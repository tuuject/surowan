# Surowan - 20261119 IMH-05 d–e：中性入库路径、补偿拉取与装配归位

## 背景

这是 `agent-doc/design/20261117 多 IM Host 铺路实施计划.md` 第五个工作包 IMH-05（入站契约）的后半段，覆盖 d（中性入库路径）、e（补偿拉取与装配）两节，以及 grammy import 边界测试。前半段 a–c（MessageCues、原始片段读取器、命令解析）已在 #115 合并。

这一段处理计划里的 A10 与 A12：

- **A12**：入库持久化与 Telegram 归一化写在一起。`ingress/telegram-ingestion/messages.ts` 的 `storeMessage` 既做 Telegram 内容归一化，也负责 sender、conversation、message、revision、media 的写入；「入库 → 参与闸门 → Bucket」这条编排只有 Telegram 版本。
- **A10 的剩余部分**：允许位置之外仍 import grammy 的文件有 4 个：
  - `src/startup-catch-up.ts`（`Update`）；
  - `src/runtime-catch-up.ts`（`Message`、`Update`）；
  - `adapters/local-monolith/runtime/serve-run.ts`、`runtime/support.ts`（`Context`）。
- **补偿拉取写死 Telegram**：catch-up 队列的 SQL 写死了 Telegram 过滤。

外部可见的行为不变：存储的行、审计行、模型可见的 Prompt 与冻结快照、Telegram 请求、Admin 响应都与原来一致。一个 Update 的入库与 Bucket 追加仍然在同一个同步事务里完成。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-05d-e: neutral intake path, catch-up and wiring move」）实现，共一轮首次实现加一轮修正。主会话负责 review、复验与交付。

## 主要变更

### 1. 中性入库路径（d）

`src/ingress/intake/index.ts` 定义 `InboundMessage`：adapter 已经解析好的中性数据，不含任何 transport 类型。字段包括 Host、内部 chat id、`hostChatId`、chat 类型、topic id、消息编号、发送与接收时间、是否编辑、cues、sender、来源类别、正文与回复信息、转发来源、media group、媒体描述、原始片段。

`messageNo` 的契约写在字段注释里：正数，在整个 `internalChatId` 内唯一（不是 Topic 内唯一），编辑前后保持不变。adapter 必须先把 Topic 内的编号映射成 Chat 级编号。

入口是 `new InboundIntake(store, configStore, botId)`，提供 `ingest(m)` 和 `ingestCatchUp(m)` 两个方法，都返回 `IntakeResult`。

**intake 负责**（`src/ingress/intake/{index,messages,buckets}.ts`）：

- 校验 chat 行的 `host_kind` 与 `message.host` 一致，不一致就报错。
- 写入 sender、conversation、message、revision、media。
- 丢弃 Bot 自己的消息，以及 `process_bot_messages` 关闭时的其他 Bot 消息。
- `eligibleHuman` 与 `companionOnly` 判定。
- 参与闸门。
- Bucket 追加：暂停检查、companion、`bumpDeadline`、收养 pending 的 Bot 消息。这部分由原来的 `telegram-ingestion/buckets.ts` 改名迁入；Bucket 窗口改从 `hostIntakeSettings(config, host)` 读取，取值不变。

**TelegramIngestion 仍然负责**：

- 同步 allowlist、群迁移、Topic 白名单。
- `telegram_updates` 去重。
- 管理员命令拦截与被忽略用户。
- `upsertChat`，以及 `toInboundMessage` 归一化。

TelegramIngestion 在自己的事务里调用 intake；intake 的事务以 savepoint 形式嵌套在里面，所以「一次 Update 一个事务」的边界不变。只有 `intake: 'bucket'` 的 Host 能走这条路径，Playground 的 release 路径没有改。

### 2. 补偿拉取与装配（e）

- `src/startup-catch-up.ts` → `src/ingress/telegram-ingestion/catch-up/startup.ts`；`src/runtime-catch-up.ts` → `catch-up/runtime.ts`。git 识别为改名，`STARTUP_CATCH_UP_STATE_KEY` 不变。
- `selectCatchUpMessages`、`finishStartupCatchUpQueue`、`finishRuntimeCatchUpQueue` 改为由调用方传入 Host，SQL 改用 `hostKindsSql('c.host_kind', hostsWhere((p) => p.kind === host && p.intake === 'bucket'))` 过滤。传入非 bucket 的 Host 时：
  - `finishStartupCatchUpQueue` 直接报错，不会去碰 Telegram 的启动 marker。
  - `finishRuntimeCatchUpQueue` 在开事务之前就返回空数组，共享的睡眠状态不会被清掉。
- grammy `Context` 处理逻辑（原 `serve-run.ts` 内联的 `onUpdate` 与 `support.ts` 的 `replyToCommand`）原样搬到 `src/adapters/local-monolith/telegram/updates.ts` 的 `createTelegramUpdateHandler(deps)`。组合根只拿到一个回调；`serve-run.ts` 和 `support.ts` 都不再 import grammy。

### 3. 边界测试（`test/im/transport-imports.test.ts`）

- `from 'grammy`（含 `grammy/types` 与 `import type`）只允许出现在以下三处：
  - `src/adapters/local-monolith/telegram/`
  - `src/ingress/telegram-ingestion/`
  - `src/doctor.ts`
- 扫描时忽略注释，扫描器本身有正反样例测试。
- 加上 IMH-03 的 Host 字面量测试、IMH-04 的配置段访问测试，三个边界测试都已生效。Host 字面量测试的允许清单还少了一条：两个 catch-up 条目被 `ingress/telegram-ingestion/` 前缀吸收了。

### 4. 测试

- `test/intake/inbound.test.ts`：不 import grammy、不构造 Update，手工构造 `InboundMessage` 驱动中性路径。覆盖：
  - 入库并开 Bucket；
  - 媒体、回复、转发、service 元数据原样落盘；
  - 编辑追加 Revision 但不开新 Bucket，重复投递什么都不写；
  - 触发 cue 刷新注意力窗口并上报 mention；
  - 自己 / 其他 Bot / service / 纯 Sticker 消息的资格判定；
  - 写到一半失败时整体回滚；
  - catch-up 入库不调度 Bucket；
  - release 型 Host 被拒绝；
  - chat 的 Host 不匹配时报错。
- `test/telegram/ingestion.test.ts`：用 trigger 让 `buckets` 插入失败。断言 `telegram_updates`、chats、senders、conversations、messages、revisions、buckets、bucket_messages 全部为空，删掉 trigger 后同一个 Update 重投成功。
- `test/scheduler/catch-up-scope.test.ts`：
  - 一次补偿只扫调用方的 Host，且只在它的 intake 是 bucket 时扫；
  - 用 `'playground'` 调用时，Telegram 启动 marker、过期的睡眠行和 buckets 都保持原样。
- 其余既有测试只改了 import 路径，以及 `finish*CatchUp('telegram', …)` 的实参，期望值都没变。

子 agent 报告：首轮的边界测试、intake 测试、catch-up 范围测试在实现前失败；修正轮的 Playground 调用 startup / runtime 补偿、release Host 入库、跨 Host chat 这四条在修复前失败；Telegram 级回滚测试钉住的是原本就正确的边界。

## Review

首轮实现后用 ocr 审了一轮（17 个文件，8 条意见），主会话逐条核实：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| `finishStartupCatchUp('playground')` 会删掉 Telegram 的启动 marker | 成立 | 修正：报错 |
| release Host 的 runtime 补偿会清掉睡眠 marker | 成立 | 修正：开事务前返回 |
| 实时 intake 接受 release Host，可能开出无人 release 的 Bucket | 成立 | 修正：报错 |
| intake 没有校验 chat 行属于 `message.host` | 成立 | 修正 |
| Telegram 外层事务加 savepoint 的回滚没有测试 | 成立 | 补测试 |
| `messageNo` 的契约没有写明 | 成立 | 补注释 |
| 归一化挪到 intake 判断丢弃之前（base 上是先丢弃自己 / Bot / 重复消息，再归一化） | 不改 | 只有畸形 Telegram payload 在归一化时抛错才会表现不同；归一化留在 edge 正是拆分的目的 |
| live handler 缺 forum topic 命令回复的测试 | 不改 | handler 是原样搬过去的 |

此外，首轮 `test/scheduler/catch-up-scope.test.ts` 的格式没过 lint，修正轮已修。

修正轮没有再跑 AI review，由主会话逐条对照上一轮意见，并通读新 diff。

## 验证

以下由主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm test test/telegram test/participation test/proactive test/bot-commands test/startup test/scheduler \
  test/context test/scene test/im test/playground test/runtime test/intake   # 首轮
# 117 files / 611 tests passed（同一轮 lint 报了 1 处格式问题，修正轮修复）
pnpm run lint && pnpm run check && git diff --cached --check && node scripts/file-token-limit.ts   # 修正轮之后
# 通过
pnpm test   # 修正轮之后
# Test Files 448 passed | 1 skipped (449); Tests 2233 passed | 9 skipped (2242)
pnpm run admin:build && pnpm run admin:test:e2e
# 349 passed (2.8m)
```

提交前 develop 合入了 #110（群聊记忆 30 小时制，8 个提交），与本包没有文件重叠。rebase 之后重跑 `pnpm run lint`、`pnpm run check` 以及 `test/im`、`test/config/host-projection-boundary.test.ts`、`test/group-memory`、`test/intake`、`test/telegram`、`test/startup`、`test/scheduler`：329 个测试中 1 个失败，就是原有的 flake `test/group-memory/store.test.ts`「a keyword search reaches…」超时（base 上也会挂）。rebase 后的全量测试交给 PR 上的 CI。

未执行：真实 Telegram 验收。建议覆盖：

- 私聊、群、Forum Topic 里收发、编辑、回复；
- 媒体组、转发、Sticker 与图片；
- 被忽略用户执行 `/ignoreme` 与 `/unignoreme`；
- `/pause` 期间重启后的补偿：只重放 `/pause` 与 `/resume`；
- 换 token 后的 runtime 补偿；
- @Bot 后出现 typing。

## 提交

```txt
1c036b92 Route inbound messages through a neutral intake path
```
