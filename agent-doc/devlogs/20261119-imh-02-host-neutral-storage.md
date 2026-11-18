# Surowan - 20261119 IMH-02：存储标识中性化（迁移 064、`message_no`）

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 的第二个工作包 IMH-02，解决计划「残留的单 Host 假设」里的 A3–A6：

- **A3**：`chats`、`senders`、`messages` 都带有枚举 `'telegram' | 'playground'` 的 `CHECK`，以及按 Host 分支的标识 CHECK。每新增一个 Host，就要重建这三张表，其中 `messages` 是最大的一张。
- **A4**：四张表的 `host_kind` 都有 `DEFAULT 'telegram'`。Telegram 入库从不显式写 `host_kind`，全靠默认值。
- **A5**：模型看到的消息编号分成两列：Telegram 用 `messages.telegram_message_id`，Playground 用 `messages.local_sequence_no`。快照、cutoff、reply 校验、群聊记忆区间、注意力窗口都直接读 `telegram_message_id`。
- **A6**：唯一约束不带 Host（`chats_telegram_chat_id_key (telegram_chat_id)`、`senders_telegram_identity_key (telegram_type, telegram_id)`），两个 Host 的同值 id 会相撞。

计划写作时的迁移号是 063，但 `063_ask_participation.sql` 已经被 `/ask` 占用，所以本包用 064。外部可见的行为不变：模型看到的 Prompt、工具结果与 `reply:<id>` 编号，Admin HTTP 响应，冻结快照的 JSON 键，`config.jsonc` 都不变；`test/im/pinned-surface.test.ts` 只改了查询里的列名，期望值没动。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-02: host-neutral storage identifiers (migration 064)」）实现，共一轮首次实现加一轮修正。主会话负责 review、复验、一处格式小修与交付。

## 主要变更

### 1. 迁移 064（`src/store/migrations/064_host_neutral_message_ids.sql`）

迁移标为 `@rebuild-tables`，写法与 037 相同：外键检查只在 DDL 窗口内关闭，整个迁移在一个事务里完成，提交前 `PRAGMA foreign_key_check` 必须干净。所有内部 id 保持原值。

| 表 | 变更 |
| --- | --- |
| `chats` | `telegram_chat_id` → `host_chat_id`；删除 Host 枚举 CHECK 与 `host_kind` DEFAULT；唯一索引 `chats_host_chat_id_key (host_kind, host_chat_id)` |
| `senders` | `telegram_type` / `telegram_id` → `host_sender_type` / `host_sender_id`；删除 CHECK 与 DEFAULT；唯一索引 `senders_host_identity_key (host_kind, host_sender_type, host_sender_id)` |
| `messages` | 新列 `message_no INTEGER NOT NULL`，回填 `COALESCE(telegram_message_id, local_sequence_no)`；删除两个旧编号列；`telegram_date` → `sent_at`；删除 CHECK 与 DEFAULT；唯一索引 `messages_chat_message_no_key (chat_id, message_no)` 取代 `messages_chat_telegram_message_id_key` 与 `messages_local_sequence_key`；`messages_conversation_history_idx` 改为 `(conversation_id, sent_at, message_no)` |
| `media` | 重建，只删 `host_kind` DEFAULT；`media_revision_idx`、`media_unique_idx` 原样重建 |
| `conversation_context_cutoffs` | `telegram_message_id` → `message_no` |
| `conversation_attention` | `trigger_telegram_message_id` → `trigger_message_no` |
| `host_sends` | `telegram_message_id` → `message_no` |

`message_no` 的 `NOT NULL` 同时是迁移的闸门：存量里只要有一行两个旧编号都为空，复制就会失败，整个迁移回滚。动手前核对过 Playground 的写入路径：`store/playground/admission.ts` 的 `submit()` 和 `adapters/local-monolith/playground/delivery.ts` 的 `publish()` 都从 `rooms.next_seq` 取号；Telegram 的入库与发送记录总是写 wire id。没有发现合法的空值路径。

`host_kind` 保留 `TEXT NOT NULL`，不设默认值，也不枚举取值。Host 是否合法、该 Host 是否必须带原生 id，改在应用层保证：所有 insert 都显式写 `hostKind`，漏写会直接失败，不会悄悄变成 Telegram。

### 2. 代码侧改名

- `src/store/schema/` 与新 DDL 逐列对齐。
- core 的 TS 标识符改名：`telegramMessageId` → `messageNo`，`telegramChatId` → `hostChatId`，`telegramDate` → `sentAt`，`telegramId` → `hostSenderId`，`telegramType` → `hostSenderType`；`localSequenceNo` 删除。Telegram adapter 内部确实持有 wire 值的局部变量保留原名。
- 入库 upsert 的 `ON CONFLICT` 目标对齐新的唯一索引，例如 sender 的目标是 `[hostKind, hostSenderType, hostSenderId]`。
- `snapshotInvocation`（`src/store/invocation-snapshot.ts`）新增 Telegram 行过滤。以前房间行的 `telegram_message_id` 为 NULL，会被 cutoff 比较自然排除；现在 `message_no` 对所有 Host 都非空。回执在房间会话里也会走到这个写者，不加过滤就会把房间消息按 Telegram 快照格式冻结进去。
- Playground 的时间线、reply 目标与 release 都改读 `message_no`；`local_reply_to_message_id` 不变。
- `scripts/audit/*` 与 `scripts/reconcile-daily-token-usage.ts` 改用新列名，并用 `AS telegram_*` 别名保持输出键不变。

### 3. Admin 响应保持原样

查询里用别名把新列对回原字段名，例如 `m.message_no AS telegram_message_id`、`ch.host_chat_id AS telegram_chat_id`。需要按 Host 区分的投影用 `CASE`（`src/ingress/admin/audit/invocation-search.ts`）：

```ts
COALESCE(ts.message_no, CASE WHEN m.host_kind = 'telegram' THEN m.message_no END) AS telegram_message_id,
CASE WHEN m.host_kind = 'playground' THEN m.message_no END AS room_seq,
```

房间行的 `telegram_message_id` 仍是 `null`；`room_seq` 在房间行上取 `message_no`，在 Telegram 行上仍是 `null`。

### 4. 按原生 id 查找时必须带 Host

改名之前，`telegram_chat_id = X` 只可能命中 Telegram chat。改名之后，`host_chat_id = X` 可能命中任何原生 id 恰好是 X 的 Host。修正轮做了一次系统性排查：凡是用 Host 原生值按 `host_chat_id` 或 `host_sender_type` / `host_sender_id` 过滤、join 或查找的地方，都加上 `host_kind` 约束。

- `src/store/host-scope.ts:27` 新增 `telegramHostSql(expr)`，给 `sql` 模板写法用；Drizzle 写法继续用 `telegramHostScope()`。core 里原有的裸 `host_kind = 'telegram'` 也改走这两个 helper，方便 IMH-03 收口 Host 字面量。
- 这轮补上的查找点：`listConversationContexts`（`/status` 用它）、Admin 删除 Chat 前查运行中 Invocation 的 `runningInvocationIdsForTelegramChat`、Admin Invocation 列表的 `chat` 过滤、Alarm 管理页的 `chat` 过滤，以及 reconcile 脚本的 legacy `'chat'` 汇总。
- `src/ingress/admin/prompts.ts` 保留了一处字面量：这个文件离 20 KB 的提交上限只差几十字节，换成 helper 会超限。它在 IMH-03 计划的允许清单（`ingress/admin/`）内。

### 5. 测试

- 新增 `test/schema/migrations-host-neutral-ids.test.ts`：从 post-063 的合成旧库升级，库里有带多条 Revision 的 Telegram 消息、房间消息、cutoff、注意力窗口、成功与未知结果的发送行、群聊记忆事件。断言内容：
  - 内部 id 与各表行数不变，`message_no` 逐行等于旧值。
  - cutoff、注意力窗口、发送行的值在新列名下不变。
  - `foreign_key_check` 干净，所有索引都存在。
  - 同一原生 id 可以分属两个 Host，同一 Host 内的重复被拒绝。
  - 入库 upsert 仍能去重，编辑消息仍追加 Revision；缺 `host_kind` 的写入会失败。
- 新增 `test/schema/migrations-host-neutral-ids-rollback.test.ts`：在 post-063 库里放一条两个编号都为空的房间消息，`SqliteStore.open` 应该失败。之后用裸连接复查：版本停在 063，`chats`、`senders`、`messages` 仍是旧列、旧索引，行数完整。
- 新增 `test/im/host-scope.test.ts`：一个 Telegram chat 与一个 `host_kind = 'playground'` 的 chat 共用 `host_chat_id = 500`，断言 `listConversationContexts`、`runningInvocationIdsForTelegramChat`、Admin Invocation 列表的 `chat` 过滤都只返回 Telegram 那一行。
- `test/schema/fixtures.ts` 新增 `buildDatabaseBelow(loaded, version)`：手工应用并记录指定版本之前的迁移。原先 `test/image/delivery-file.test.ts` 重放 049、`test/schema/index-plans.test.ts` 的 upgraded 模式重放 062，这两处首轮被改写成了不再重放迁移的形式；修正轮改为在 post-063 库上真实重放 049、062，再跑 064，原有断言照旧保留。
- 其余既有测试只改列名或 Drizzle 字段名，另有两处迁移计数从 63 改为 64。

子 agent 报告：首轮迁移测试在实现前失败；`host-scope.test.ts` 在修复前失败（`[20n, 10n]` 对 `[10n]`）；回滚测试和两个重放测试钉住的是已有的正确行为，第一次跑就通过。

## Review

首轮实现后用 ocr 审了一轮（90 个文件，32 条意见），主会话逐条核实，并自己读了非机械部分的 diff：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| 按原生 id 查找不带 `host_kind`，同值 id 会跨 Host 串台（Admin 删 Chat、`/status`、Invocation 列表过滤、reconcile 脚本、3 处测试夹具，含重复共 9 条） | 成立 | 修正：系统性加 Host 约束，集中到 `host-scope.ts` 的 helper |
| 049 / 062 的重放测试被改写成断言「手搓的结果等于自身」（主会话发现） | 成立 | 修正：在 pre-064 库上真实重放 |
| 064 的回滚闸门没有测试 | 成立 | 修正：补拒绝路径测试 |
| 群聊记忆、scene、adoption、房间 reply seq、invocation-detail / search 等处，原先靠 NULL 排除的跨 Host 行现在可能混入（11 条） | 不改 | 只有脏数据才会出现：没有写入路径会把一个 Host 的消息写进另一个 Host 的 Chat；replay 被 preflight 限定为 Telegram；Telegram 发送不会写 `host_sends.message_id` |
| `PlaygroundStore.timeline()` 接受任意 chat id | 误报 | 唯一调用方传入的是校验过的 `room.chatId` |
| recurring alarm、调度日志、audit 脚本里的 `telegram_chat_id` 投影没有按 Host 门控（5 条） | 不改 | 房间的 `host_chat_id` 目前都是 NULL，输出不变；非 Telegram 原生 id 在 Admin 与日志里怎么展示，按计划推迟到 Discord |
| audit / reconcile 脚本打不开 pre-064 的备份（3 条） | 不改 | 脚本跟随当前 schema |
| `pinned-surface.test.ts` 改了 SQL | 误报 | 只改了列名，期望值没动 |
| `ReceiptRow.telegram_chat_id` 等内部别名应改名 | 不改 | IMH-04 会重做这些行契约 |

修正轮没有再跑 AI review，由主会话逐条对照上一轮意见，并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts
# 首轮通过；修正轮后 lint 报新增的回滚测试是 CRLF 换行，主会话用 biome format --write 修正后通过
pnpm test test/schema test/im test/telegram test/playground test/group-memory test/cut test/send test/admin test/foundation.test.ts   # 首轮
# 159 files / 697 tests passed
pnpm run admin:build && pnpm run admin:test:e2e   # 修正轮之后
# 349 passed (2.8m)
pnpm test   # 修正轮之后，格式修正后重跑
# Test Files 437 passed | 1 skipped (438); Tests 2154 passed | 9 skipped (2163); 796.93s
```

基线（`87234915`）：`pnpm test` 没有已知失败；`admin:test:e2e` 349 个全过。子 agent 首轮全量 e2e 时 `25-koi-crud-structure` 有一例 `waitForResponse` 超时，单跑通过；主会话这次全量 e2e 没有复现。

未执行：真实 Telegram 验收。建议在升级前后各查看一次 Admin 的消息、Invocation、Context、群聊记忆页，并在私聊、群和 Forum Topic 里各收发、回复、编辑一次，再试一次 `/cut_topic` 与 `/status`。

## 回滚限制

迁移 064 之后，旧版本程序无法使用升级后的库：它读写的列已经被删除或改名。回滚只能恢复迁移前自动生成的 `pre-migration-*` 备份，升级之后新收到的消息会因此丢失。

## 提交

```txt
21459787 Store host-neutral chat, sender and message identifiers
```
