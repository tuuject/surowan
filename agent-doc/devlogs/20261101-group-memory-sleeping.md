# Surowan - 20261101 群聊记忆与 sleeping 整理

## 背景

Memo Pad 只保存模型主动维护的资料，跨 Invocation 回忆「群里发生过什么」仍没有数据来源。群聊记忆的产品边界已在 `doc/design/20261030-group-memory.md` 确认：按 Chat 可选启用、以日期组织事件、两层渐进式披露（先事件摘要，再按消息范围回放原文），与 Memo Pad 互不替代。

本次实现同时落地了 PRD 里留给实现阶段决定的几件事：何时整理、使用哪个模型、如何存储、消息范围如何回溯。选择是「静默入睡后整理」：

- Chat 安静 `idle_minutes`（默认 30）后整理当天消息；本地日期已经结束时不必等空闲。
- 一个 Chat 一次只整理一个本地日期，避免把两天混进同一批记忆。
- 使用系统级 `tool_model`（缺省继承全局 Agent 模型），不占用聊天 Agent 的 Invocation。
- 每条记忆只存摘要与闭区间 Telegram message id，不复制原文；第二层披露直接回放 `messages` / `message_revisions`。
- 被记忆覆盖的原文跳过在线保留清理，保证 `read_group_messages` 仍能回溯现场。

## 主要变更

### 1. 按 Chat 的开关与迁移

`ChatSchema` 新增可选 `group_memory`：

```jsonc
{
  "id": -1001234567890,
  "group_memory": { "enabled": true, "idle_minutes": 30 }
}
```

`src/platform/config/schema-sections.ts` 用 `GroupMemorySchema` 校验 `enabled` 必填、`idle_minutes` 为 1–1440；`src/platform/config/diff-merge.ts` 把 `telegram.chats[<id>].group_memory(.*)` 归为热更新，下一次 sleeping 扫描直接使用发布后的配置。

迁移 `src/store/migrations/048_group_memory.sql` 建两张表：

```sql
CREATE TABLE group_memories (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_message_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(summary) BETWEEN 1 AND 150),
  CHECK (first_message_id > 0),
  CHECK (last_message_id >= first_message_id)
) STRICT;

CREATE TABLE group_memory_state (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  consolidated_through_message_id INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',
  claimed_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;
```

`GroupMemoryStore`（`src/context/group-memory/store.ts`）把摘要与水位放在同一个 IMMEDIATE transaction 提交；`state = 'running'` + `claimed_at` 是数据库认领，失败写 `next_attempt_at` 退避，崩溃留下的认领超过 30 分钟由 `recoverStale()` 释放。

### 2. sleeping 整理

`src/context/group-memory/sleeping.ts` 的 `SleepingService` 每 60 秒扫描已启用且 Telegram 就绪的 Chat，单轮最多整理 3 个批次。它按 Chat 本地日期切批（`src/context/group-memory/day.ts` 用二分查找处理 DST 的 23/25 小时日），只读取水位之后的已存消息；同 Chat 有 queued/running Invocation、collecting Bucket、`/pause`、全局 `zzz` 睡眠，或 Chat 已离开配置时跳过。

批次上限是 120 条消息 / 40000 字符，并再按工具模型窗口收窄。`consolidateDay`（`src/context/group-memory/consolidate.ts`）要求模型返回：

```json
{"events":[{"summary":"Natu 和 tcdw 讨论了 eSIM 价格。","first_message_id":4005,"last_message_id":4114}]}
```

解析后校验每个范围的首尾都真实出现在本批输入里、顺序不倒退、事件之间不重叠；摘要 1–150 字符。任何校验失败都不会落库，整批按退避重试。成功时返回的 `through` 是模型实际看到的最后一条消息，水位只推进到这里，超出窗口的消息留到下一轮。模型调用写 `model_calls`（`role = 'tool'`、`invocation_id = NULL`），不进入每日 Agent Token 预算。

### 3. 两层回忆

`src/context/group-memory/tools/read.ts` 新增两个直接暴露的原语：

- `search_group_memory`：按 Chat 本地 `YYYY-MM-DD`、关键词（匹配 summary，多个关键词至少一半命中）与 limit 返回 `gmem_` id、日期、summary 与 `messages <first>-<last>`。
- `read_group_messages`：接受闭区间 message id，按当前 revision 回放同一 Chat 的原始消息；最多 200 条、2000 个 id 宽度、20000 字符，超出时提示模型缩小范围。

两个工具都按 `internalChatId` 隔离，并在调用时重新确认 `group_memory.enabled`；未启用、已关闭或 Chat 已移出配置都不会返回别处的数据。工具只在启用时注册进 `buildTools`（`src/orchestration/agent-runtime/support.ts`），同时参与 `validateAdditionalTools` 的模型窗口校验。

稳定提示 `src/platform/prompts/3-capabilities.md` 增加了一段条件式说明：`search_group_memory` / `read_group_messages` 可用时，群聊记忆用于「群里发生过什么」，不是 Memo Pad。

### 4. 保留窗口与回溯

`purgeExpiredData`（`src/store/store.ts`）在删除/匿名化旧 Message、Revision 与 Media 时，跳过被任一 `group_memories` 范围覆盖的行：

```sql
AND NOT EXISTS (
  SELECT 1 FROM group_memories gm
  WHERE gm.chat_id = messages.chat_id
    AND messages.telegram_message_id BETWEEN gm.first_message_id AND gm.last_message_id
)
```

因此启用群聊记忆的 Chat 会长期保留被摘要引用的原文；记忆行本身没有 TTL，随 `chats` 级联删除。代价是磁盘占用随事件覆盖范围增长，已写入用户指南。

### 5. 文档与测试

同步了 `agent-doc/configuration.md`、`data-layer.md`、`telegram-agent-flow.md`、`verification.md`、`AGENTS.md`、`agent-doc/README.md`，以及用户指南 `apps/docs/content/docs/guides/memory.md`。

新增 `test/group-memory/`：日期与 DST、摘要/水位事务、关键词与 Chat 隔离、认领/退避/stale 恢复、模型输出校验与 `model_calls` 审计、idle 与暂停/忙碌/全局睡眠跳过、跨 Chat 原文隔离、保留清理。配置热更新测试补了 `group_memory` 的增删分类；迁移版本断言从 47 更新到 48。

## 验证

```bash
pnpm test
# 348 passed | 1 skipped（348 个测试文件）；1941 passed | 8 skipped（1949 个用例）
# 功能落地后跑过两轮完整套件

pnpm test test/group-memory test/config/diff.test.ts
# 7 files，37 passed（最终改动后）

pnpm test test/prompts test/scene test/runtime/host.test.ts test/agent/runtime.test.ts
# 16 files，61 passed（稳定提示加入群聊记忆说明后）

pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm run lint
# biome lint + format 通过

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, 116 HTTP resources
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, 116 HTTP resources

git diff --check
# 无输出
```

未执行：真实 Telegram 群聊的人工 sleeping 验收、真实 `tool_model` 提供商调用与磁盘占用观察。

## 已知限制

- 没有独立的 Admin 页面；只能改配置开关，只能让模型通过工具回忆。
- 开启后会从当前仍保留的最早消息开始补整理，积压较多时会有多轮后台模型调用。
- 被记忆覆盖的原文不再按 `retention.online_days` 清理；这是回溯能力的代价。
- 摘要不自动注入，也不做 RAG/embedding；检索是摘要关键词与日期。
- 后台整理在全局 `zzz` 睡眠、`/pause` 或 Chat 忙碌时跳过，恢复后补做。

## 提交

```txt
56ada82 Add sleeping group memory with message ranges
```
