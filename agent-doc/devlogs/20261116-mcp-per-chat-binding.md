# Surowan - 20261116 MCP 按群绑定、热重载与定向 cutover

## 背景

改动前，出站 MCP（`mcp.servers`）是进程级单例：`McpManager` 只在构造时读一次配置，所有 Telegram 群拿到的都是全部 server 工具的并集；`mcp.*` 不在热重载白名单里，改一次就要重启。用户希望把 MCP 和 agent 解耦：不同群用不同的 server，或者同一个 server 在不同群用不同的工具范围和策略，并且改配置不用重启。

讨论中确定的约束：

- 用户不打算积极支持「在群聊进行中反复修改 MCP 配置」，所以配置变更时直接 abort 受影响的 Invocation 是可以接受的代价，但必须只 abort 真正受影响的群，例如只绑定给一个群的 server 改了，就只动那一个群；
- 很多配置变更本来就要求 Context 重建，所以被中止的运行不在旧 Context 上续写，而是 rebuild 之后马上开一个新的 Invocation 接着回答，复用 PR #90 的 `resumeInvocation`（空 Bucket 加可信的 `<runtime_state>` 行）；
- 没写 `mcp` 绑定的群仍然拿到全部 server，保证存量配置升级后行为不变；
- 顺带修一个已有问题：调用方中止正在进行的 MCP 调用时，旧代码会走进 `!known` 分支，把整个 server 标成 degraded 并重连。按群共用 server 以后，这会让中止 A 群连带打断 B 群正在进行的调用。

本次由 T3 委派 Pi（`magpie/opencode-go/deepseek-v4.1-flash`，thinking `max`）在子线程「MCP per-chat binding, hot reload and cutover」里实现，主会话负责任务说明、ocr 审阅、逐条核实、打回修正和独立复验。

## 主要变更

### 1. 调用方中止不再拆掉共享连接：`src/capabilities/mcp/calls.ts:138`

```ts
const callerAborted = outerSignal?.aborted === true;
if (!known && !callerAborted) {
  deps.setState(server, 'degraded', errorCode);
  deps.scheduleReconnect(server);
}
```

只看调用方自己的 `outerSignal`，不看合并后的 signal：单次调用的超时说明 server 可能卡死，仍然降级重连。审计行照旧记 `outcome_unknown`，因为 server 可能已经执行了这次调用。

### 2. 按群绑定的配置与解析

- `src/platform/config/schema-sections.ts:253`：`telegram.chats[].mcp` 是 `{ server, tools?, tool_policies? }` 数组。字段缺省表示全部 server，`[]` 表示不用 MCP。绑定只能收窄工具、按工具覆盖 policy；连接参数（command、url、headers、env）只留在 server 上，需要不同连接就另配一个 alias。
- `src/platform/config/semantics.ts:236`：校验未知 alias、重复绑定、server 显式列表之外的工具、未选工具的 policy。会先把 `binding.tools ?? server.tools` 归一化，只有字面量 `'*'` 才推迟到 discovery 时再校验。
- `src/capabilities/mcp/bindings.ts:50`：`boundChatServers` 做纯配置解析；`:90` 的 `affectedMcpChatIds` 判断哪些群「失去或改变了什么」：server 被删、server 任意字段改了、工具被收窄、已有工具的 policy 变了。纯新增（新 server、放宽工具、给新暴露的工具加 policy）不算受影响。
- `src/capabilities/mcp/index.ts:96` 的 `createTools` 从 invocation 的配置快照解析绑定（`ToolFactory` 增加了第 4 个参数 `config`，见 `src/orchestration/agent-runtime/types.ts:41`），配置里不存在的群拿不到任何 MCP 工具。`src/capabilities/mcp/tool-sets.ts:169` 只采用配置和绑定一致的实例，所以未被 fence 的新群不会用到一个即将被替换的旧实例。
- 每个工具定义都记着产生它的 `ManagedServer`，调用只发往这个实例。实例已被替换时直接拒绝，审计为 `server_replaced`，不发请求（`calls.ts:55`）。
- 注册表校验改为按群：每一组不同的工具集分别校验 61 个工具的上限，并且只对这些群实际会用的模型（`modelsForTelegramChats`）检查 context window。doctor 和 serve 启动时还会对每个配置的模型单独校验一次基础工具注册表。

### 3. 热重载：`src/platform/config/diff-merge.ts:117` 与 `src/capabilities/mcp/reconcile.ts`

`mcp`、`mcp.*`、`telegram.chats[<id>].mcp*` 归为 hot。`reconcile`（`reconcile.ts:15`）按 alias 增量处理：删除的 alias 停掉、新增的连上、字段变了的替换、没变的不动；带 generation 守卫（`:21`），旧的发布不能覆盖新的。`required: true` 只在启动时保证：热新增或热修改的 server 连不上时标为 degraded，按正常退避重连，并记进发布日志。

只改绑定的 reload 会在候选检查阶段（`tool-sets.ts:128` 的 `assertConfigBindings`），拿已连接、配置没变的实例的 discovery 结果，校验显式工具名和 policy 名。`/model` 切换的写入前预检改为校验「已经套用新模型」的候选配置（`src/adapters/local-monolith/config/reload.ts:248`），不合格的模型不会先写进文件。

### 4. 定向 cutover：`src/adapters/local-monolith/runtime/mcp-cutover/`

`onPublished` 通过 `src/adapters/local-monolith/runtime/mcp-publication.ts:56` 调用串行化的 `createMcpCutover`（`mcp-cutover/index.ts:40`）。每次发布的处理顺序：

1. 对受影响群的所有 Conversation 加 fence，等待期间新出现的 Conversation（新的 forum topic）也会被补上（`stop.ts:30`）；
2. 写入 `abort_cause`，abort 并等待它们 settle。超过 30 秒就转成后台继续执行，fence 保持不动；
3. 重建这些 Conversation 的 canonical Context；
4. reconcile server 实例；
5. 为每个被中止、并且这一轮还没答完的运行排一个续跑（`continuation.ts:31`）：
   - 用 `ConversationRuntime.isRoundInProgress`（`src/orchestration/conversation-runtime.ts:124`）在 abort 之前判断。运行如果已经答完、只是在 idle_grace 里等新消息，就不续跑，记为 `idle`；
   - abort 时被释放的未注入 batch 已经排成了新的 Invocation，直接把它接管为续跑（`adoptReleasedRun`，`:142`），不再另开一个；
   - 运行正在处理的任务回执或循环闹钟，会作为续跑的开场 batch 重新投递（`carryReceipts`，`:186`，以及 `resumeInvocation` 的 `openingBucketId`）；
   - 续跑的 history 会往回覆盖到被中止运行所消费的第一条消息，上限 500 条（`src/orchestration/invocation-queue/resume.ts:150`）。

队列等待也有上限：如果上一次 cutover 卡在一个永远不 settle 的 handler 上，新的发布在 cutover 窗口到期后返回 pending 结果，自己的 cutover 排到后面按顺序执行，`onPublished` 和 reload 锁不会被一直占住（`index.ts:91`）。

续跑的开场 `<runtime_state>` 由 `src/context/builder/resume.ts:25` 生成；admin 续跑的原有文案不变。MCP 变更的文案（`:77`）说明运行被停掉、Context 已重建、history 里可能有还没回复的消息、不要重发；还会列出结果未知的 MCP 工具名，只有名字，不含参数和结果。

### 5. 迁移 061

`src/store/migrations/061_invocation_abort_cause.sql` 给 `invocations` 加可空列 `abort_cause` 与 `abort_unknown_tools`（运行时写入的 JSON 工具名数组），`src/store/schema/invocation.ts` 同步更新；读写都经 `src/store/abort-cause.ts` 校验，只有 runtime 写入的代码和工具名才会进入可信行。4 个测试里写死的迁移数从 60 改为 61。

### 6. 文档

`agent-doc/configuration.md`（绑定、热重载、`required` 只在启动时生效）、`agent-doc/telegram-agent-flow.md`（按群工具集与 cutover 步骤）、`agent-doc/data-layer.md`（迁移 061）、用户指南 `apps/docs/content/docs/guides/extensions.md`。

## Review 与修正

主会话对子 agent 的改动跑了两轮 ocr，逐条回到代码里核实后打回同一子线程修正：

- 第一轮 14 条，去重后 11 条全部成立，并加上一处写错的注释：handoff 用旧配置 reconcile、manager 的配置落后于已发布配置导致新群拿到全部 server、执行器按 alias 现查实例、fence 漏掉新 topic、只改绑定时漏校验、通配绑定的 policy 名不校验、serve 的 validator 忽略 `chatIds`、`/model` 预检用了切换前的配置、「注入后发过一次 send」的启发式太粗、rebuild 后 history 窗口不够、放宽被误判为变更。全部已修。
- 第二轮 10 条，修了 7 条：cutover 队列阻塞 reload 锁、释放的 batch 挡住续跑、任务回执丢失、新群用到配置不一致的实例、省略 `tools` 时被当成字符串遍历、通配 policy 名在只改绑定时漏校验、doctor 漏掉基础注册表校验。
- 接受现状、作为已知限制的 3 条：
  - reconcile 本身在 await 时冒出的新 topic 可能拿到即将被替换的实例的工具，调用会以 `server_replaced` 干净失败；
  - 续跑 history 有 500 条上限；
  - 续跑还没结束又遇到一次 cutover 时，history 窗口会退回默认值。
- 主会话读代码时额外发现、但没有返工的一处：被中止的运行同时有「已注入的回执」和「未注入的 batch」时，走接管 batch 的路径，回执虽然被转给了续跑，但不在它的开场 batch 里，所以不会再被渲染。需要同时满足三个条件才会出现，记为已知限制。
- 提交时被 pre-commit 的单文件 5,000 token 限制拦下，由子 agent 把 `mcp-cutover.ts`、`capabilities/mcp/index.ts`、`serve-run.ts` 和 cutover 测试拆成目录与主题模块，测试总数不变（2009）。

## 验证

主会话在子 agent 的 checkout 里亲自运行，以下是最终状态：

```bash
node scripts/file-token-limit.ts
# exit 0（暂存区没有超限文件）
pnpm run lint
# exit 0
pnpm run check
# exit 0
pnpm test
# Test Files 1 failed | 404 passed | 1 skipped (406)
# Tests 1 failed | 1999 passed | 9 skipped (2009)
# 唯一的失败是 test/recurring-alarms/schedule.test.ts（Windows 路径分隔符）；在主 checkout 的 develop 上单独运行同样失败，与本次改动无关
MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两种 base 均 exit 0
git diff --cached --check
# exit 0
npx vitest run test/cut/mcp-cutover.test.ts test/mcp/abort.test.ts test/mcp/reconcile.test.ts   # 拆分前，连跑 5 次
# 每次 20 passed
# rebase 到 origin/develop（f2cba296）之后：
pnpm run check
npx vitest run test/cut test/mcp test/mcp.test.ts test/config test/invocations test/agent
# 56 files / 248 tests passed
```

只有子 agent 自报、主会话没有复现的：每个新回归测试在单独回退对应修复时会失败；`test/mcp/abort.test.ts` 在修复前确实失败（状态变成 `degraded`，`reconnect_attempt` 为 1）。

未执行：`pnpm run admin:test:e2e`（没有改 Admin Panel 前端、API 和可见文案）；真实 Telegram 群里的热重载与 cutover 人工验收；真实外部 MCP server 的 `doctor`。

## 提交

```txt
750ed7b3 Bind MCP servers per chat with hot reload and cutover
```
