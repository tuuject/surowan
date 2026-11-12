# Surowan - 20261112 群聊记忆：放宽校验、启用边界、live/backfill 分流与整理进度面板

## 背景

2026-11-12 的积压调查（`agent-doc/investigations/2026-11-12-group-memory-backlog.md`）发现，生产上群聊 A 的群聊记忆只整理到 10-10，还有约 2.1 万条待整理；群聊 B 积压 13.5 万条，已关闭止血。原因是几件事叠在一起：

- 迁移 048 上线后水位从 0 开始，启用即回填全部已存历史。
- tool model 73.8% 的调用因输出不合格整批失败，其中过半是「事件范围重叠」，另有 16% 是 summary 超过 150 字；任何失败都退避 30 分钟。
- `#batchFor` 永远取最旧的日期，新消息排在全部积压之后；忙碌闸门对旧日期也生效；`model_calls` 没有 Chat 维度，看不出每个群卡在哪。

用户对报告的 action items 做了三个决定：

- 不认可「事件范围不得重叠」的设计，放宽这条限制。
- summary 上限提升到 200 字，但 prompt 仍写 150 字。
- 重新启用时跳过关闭期间的消息（边界取 max(原水位, 重新启用时刻)）。

另外要一个面板监测记忆整理进度，具体设计未定。本次实现报告的 A0（成功率）、A1（并行）、A2（live/backfill 分流）、A3（启用边界）与 A4（进度面板）。报告里 A3 提到的「管理员显式回填更早日期」没有做。

## 主要变更

### 1. 整理校验放宽与一次修复调用

`parseConsolidatedEvents` 只保留 Schema、首尾 id 在批次内、`first ≤ last` 三项检查，不再要求不重叠和有序，落库前按起点排序；错误消息带事件序号、id 与长度，不含消息正文，因为它会写进审计并发回模型（`src/context/group-memory/consolidate.ts`）。`GROUP_MEMORY_SUMMARY_MAX_LENGTH` 改为 200，新增 `GROUP_MEMORY_SUMMARY_PROMPT_LENGTH = 150` 只用于 prompt。

`consolidateDay` 改为返回结果而不是抛异常，回复不合格时把原因作为下一轮 user 消息再请求一次；供应商错误不修复，交给 lane 退避（`src/context/group-memory/consolidate.ts:261`）：

```ts
  for (;;) {
    calls += 1;
    const outcome = await callOnce(dependencies, model, rows, conversation, options, calls, now);
    if (outcome.kind === 'events') {
      return { ok: true, events: outcome.events, ...read, modelCalls: calls };
    }
    if (outcome.kind === 'failed' || calls >= MAX_MODEL_CALLS || options.signal?.aborted === true) {
      return { ok: false, errorCode: outcome.errorCode, errorDetail: outcome.errorDetail, ...read, modelCalls: calls };
    }
    conversation.push(outcome.response, {
      role: 'user',
      content: repairPrompt(outcome.errorDetail),
      timestamp: Date.now(),
    });
  }
```

修复调用在 `model_calls` 里记为 `attempt = 2`。

### 2. 迁移 054：lane、运行记录与 200 字上限

`src/store/migrations/054_group_memory_lanes.sql`（`@rebuild-tables`）：

- 重建 `group_memories`，`CHECK (length(summary) BETWEEN 1 AND 200)`。
- 用 `group_memory_lanes`（主键 `(chat_id, lane)`，`lane IN ('live', 'backfill')`）替换 `group_memory_state`。backfill 必须有 `until_message_id` 且不小于游标；新增 `consecutive_failures`。旧水位行迁成空闲的 live lane：迁移时进程已停，`running` 认领一并清掉。
- 新增审计表 `group_memory_runs`，每个批次一行：lane、日期、读到的区间与条数、结果、事件数、模型调用数、`error_code`、`error_detail`。`purgeExpiredData` 按 `retention.online_days` 清理已结束的行（`src/store/store.ts`）。

### 3. 启用边界与 lane 生命周期

`GroupMemoryStore`（`src/context/group-memory/store.ts`）改为以 lane 为单位：

- `activate`（`:138`）在没有 live lane 时插入一条，游标为传入的「当前最新已存消息」，`ON CONFLICT DO NOTHING`。
- `deactivate` / `deactivateAllExcept` 删除 lane。
- `split`（`:181`）在一个事务里建 backfill 并把 live 游标前移。
- `claim`（`:240`）返回认领时间作为 token。
- `commit`（`:263`）只在 `state = 'running' AND claimed_at = token` 时推进游标并写入事件，backfill 读到终点时随同一事务删除；认领已失效就什么都不写。

`SleepingService.reconcile`（`src/context/group-memory/sleeping.ts:127`）让 lane 跟开关一致：开着的 Chat 没有 live lane 就从 `newestMessageId` 开始建，其余 Chat 的 lane 全部删除。所以首次开启不回填，关闭再开启会跳过中间那段。每次 tick 开头调用一次；配置发布时也立即调用（`publishGroupMemory`，`src/adapters/local-monolith/runtime/chat-lifecycle.ts:175`），否则边界会漂到下一个 tick。这段发布逻辑从 `serve-run.ts` 移到 `chat-lifecycle.ts`，因为 `serve-run.ts` 超出了 pre-commit 的 20 KB 单文件上限。

### 4. live / backfill 分流与并行

live lane 最旧的待整理消息早于 Chat 本地「昨天」时，`#splitBacklog`（`src/context/group-memory/sleeping.ts:377`）把「昨天零点前最后一条消息」作为 split point，交给 backfill。live 继续处理昨天和今天。

忙碌闸门只挡 live（`:415`）；backfill 只读昨天之前已结束的日期，与正在生成的回复没有竞态。

候选 lane 先 live 后 backfill，各组按 `last_attempt_at` 排序，由 `GROUP_MEMORY_MAX_IN_FLIGHT = 4` 个 worker 从同一队列取任务（`:205`）。每次扫描最多开始 `GROUP_MEMORY_MAX_BATCHES_PER_TICK = 8` 个批次，失败批次同样计数。`#controller` 改成集合，`stop()` 中止全部在途调用；启动时把上个进程遗留的 `running` 运行记录标为 `interrupted`。

### 5. 整理进度面板

后端新增两个只读端点（`src/ingress/admin/group-memory.ts`，路由在 `src/ingress/admin/routes/group-memory.ts`）：

- `GET /api/group-memories/progress`（`groupMemoryProgress`，`:264`）：每个有 lane 的 Chat 一行，给出各 lane 的游标及对应消息时间、待整理条数、backfill 终点、退避、连续失败次数、24 小时批次统计和最近一次失败。
- `GET /api/group-memories/runs`（`listGroupMemoryRuns`，`:387`）：按 `id` 做快照分页，可按 `chat`、`state` 过滤。

两个端点同步加进 `packages/admin-surface/src/specs/memory.ts`，即 `surowan-utils group-memory progress` / `group-memory runs`。

前端 `GroupMemoryProgressPanel`（`apps/admin-next/src/components/group-memories/progress-panel.tsx:111`）放在 Group memory 页顶部，是一个独立 Card 里的短表格。状态徽章区分整理中、正常和连续失败 N 次，失败时附带下次重试时间。行操作「查看批次」打开快照分页的批次列表，失败原因按 `error_code` 显示成文字，下方附 `error_detail`。

截图检查时发现表格单元格默认不换行，日期被截断，于是让次要行可以换行，并调窄了列宽。summary 编辑框上限改为 200；Chats 页开关的说明改为「只整理开启之后的消息」。

## 验证

```bash
pnpm run check
# 通过，无错误
pnpm run lint
# Checked 1281 files，无问题
pnpm test
# 拆分 serve-run.ts 之前：Test Files 371 passed (371)，Tests 1808 passed (1808)
# 最终提交 fc518e2e：Test Files 371 passed (371)，Tests 1809 passed (1809)，exit 0
pnpm exec vitest run test/group-memory test/admin/group-memory.test.ts
# 7 files，41 tests passed（之后新增的 admin 进度用例：4 passed）
pnpm exec vitest run test/schema test/tasks/migration-upgrades.test.ts test/scene/retention.test.ts test/foundation/foundation.test.ts
# 迁移版本/数量断言 53 → 54 后全部通过
pnpm exec vitest run test/admin/chats-group-memory-cutover.test.ts test/admin/chats
# 拆分 serve-run.ts 之后：6 files，23 tests passed；新增 publishGroupMemory 用例后 cutover 文件 4 passed
pnpm run admin:build && pnpm run admin:test:e2e 18-group-memory 25-koi-crud-structure 01-routes 24-i18n 09-chats-group-memory --workers=3
# 59 passed
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 50 HTML/Markdown pages ... (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 50 HTML/Markdown pages ... (base /surowan/)；构建后无额外文件改动
```

另外用临时 Playwright 脚本（未提交）截图检查了进度卡片与批次对话框的浅色/深色、1440 宽与 390 宽。

未执行：真实 Telegram 与生产库上的升级验收（迁移 054 在生产库约 761 MB 上重建 `group_memories` 的耗时、群聊 A 的积压能否实际分流并追平）；完整的 Admin e2e 套件只跑了受影响的五个文件。

## 提交

```txt
fc518e2e Unblock group memory consolidation and add a progress panel
```
