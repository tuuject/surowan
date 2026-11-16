# Surowan - 20261117 MCP 连不上时服务照常运行，`required` 软废弃

## 背景

用户问：一个 streamable HTTP 的 MCP server 连不上，会不会让整个服务端罢工？用户可以接受的行为是：显示常态警告，Invocation 照常发起，只是拿不到那个 server 的工具。

按 #93（MCP 按群绑定）分支的代码，有这几处和预期不符：

- `required: true` 的 server 启动时连不上，`McpManager.start()` 会抛错，`serve` 直接退出；
- `await mcpManager.start()` 排在 scheduler 和 Admin Panel 之前，并且逐个 server 串行连接。遇到黑洞 endpoint 时，每个 server 要卡满 30 秒超时；
- 连接中途断开后，server 被标成 degraded，但工具定义没有清空，模型仍然看得到这些工具。调用时报 `MCP transport is unavailable`，审计却记成 `outcome_unknown`，实际上请求根本没有发出；
- `mcp_server_state` 表有写入，但没有任何地方把它展示给运维。

`required` 是以前的 agent 替用户定下的字段，用户自己并不需要它。它只在启动那一刻起作用，保证不了运行期间可用，反而会让 MCP 拖垮服务。用户决定软废弃：字段改成可选，不再起任何作用，只在启动 CLI 和面板常态警告里提示已废弃。

这次改动叠在 #93 的分支 `feature/mcp-per-chat-binding`（`c0c17136`）之上：#93 把 `capabilities/mcp/index.ts` 拆成了 `connection.ts`、`tool-sets.ts` 等文件，从 develop 开分支会大面积冲突。

由 T3 委派 Devin（`swe-2-high`）在子线程「MCP availability and required deprecation」里实现，主会话负责任务说明、审阅、核实、打回修正和独立复验。这次按更新后的 t3-delegate-review skill 执行：任务说明写清了提交关卡（单文件不超过 20 KB）；中间轮只跑受影响的测试；AI review 只做一轮。

## 主要变更

### 1. 启动不等 MCP：`src/capabilities/mcp/index.ts:74`

`start()` 为每个 server 在后台发起连接，然后立即返回，不会因为任何 server 抛错。连接失败的 server 进入 degraded，按原有退避重连。`serverStates()`（`:100`）把每个 alias 的实时状态提供给常态警告，只包含当前配置里的 alias。

每一次连接尝试（首次连接、重连、reconcile）都挂在 `server.attempt` 上，握手和 `listTools` 用的是「30 秒超时」与「attempt 中止信号」的合并 signal。`stopServer()`（`src/capabilities/mcp/connection.ts:57`）会中止正在进行的握手，关闭它已经打开的 transport，然后等这次尝试收尾。这样在启动后立刻 stop，也不会留下 stdio 孤儿进程或悬挂的 HTTP 请求。

### 2. 只有 ready 的 server 提供工具

- `definitions()`（`src/capabilities/mcp/tool-sets.ts:186`）跳过非 `ready` 的 server。断线期间开始的 Invocation 拿不到它的工具，重连成功后的下一次 Invocation 自动恢复。cutover 需要列出「结果未知的工具」，用 `includeUnavailable` 读出包括不可用 server 在内的完整列表。
- 调用开始时如果实例不是 ready，就按 `server_unavailable` 拒绝（`src/capabilities/mcp/calls.ts:70`），审计状态是 `error`，不发请求，也不会再触发降级。等信号量的过程中断线、重试时发现 client 已经没了，也走同一个拒绝；但如果只读工具的第一次请求已经发出，就保留第一次的传输错误分类。
- 每一种会让 server 变得不可用的转换都会安排重连：`onclose`、`onerror`（`connection.ts:147`）、listChanged 刷新失败。如果不这样，一个不关闭 transport 的错误（例如 streamable HTTP 的 SSE 流断开）会让工具永远隐藏。
- `publishCandidate()`（`connection.ts:215`）是 `connect()` 和 `refreshTools()` 共用的「先临时标成 ready 再校验、失败回滚」逻辑，避免 degraded 状态下刷新时，校验把自己的工具排除在外而误放行。

### 3. `required` 软废弃

- `src/platform/config/schema.ts:49` 及 HTTP transport 对应位置：改为 `Type.Optional(Type.Boolean())`，存量配置照常加载。
- `src/platform/config/validate.ts:65`：只要有 server 写了 `required`，就产生一条 `mcp.servers[].required is deprecated and has no effect; remove it from: …` 的警告，`check-config` 和 serve 启动日志 `config_warnings` 都会输出。
- `sameMcpServerConfig()`（`src/capabilities/mcp/bindings.ts:40`）比较 server 配置时忽略 `required`。受影响群的判断、reconcile 和 `definitions()` 都改用它，所以只改 `required` 不会触发 cutover，不会重连，也不会隐藏工具。
- 配置检查 API 不再返回这个字段；文档、示例和测试 fixture 都去掉了它。

### 4. 常态警告与日志

`src/platform/warning-catalog.ts` 新增两个 standing code：`mcp_required_deprecated`（配置里还有 `required` 时显示），以及 `mcp_server_unavailable`（`:39`）。后者列出当前配置中处于 degraded 状态，或已经失败过、正在重试的 alias，显示错误码和下次重连时间，不包含原始错误信息。数据来自 manager 的实时状态，不读 `mcp_server_state`，因为这张表会保留已删除 alias 的行。面板的 `warning-card.tsx` 加了两个渲染分支，四个 locale 都补了文案。server 进入 degraded 和恢复时各记一条日志（`mcp_server_degraded` / `mcp_server_recovered`），错误详情经过脱敏，每次故障只记一次，不会每次重试都记。

### 5. doctor

doctor 不再只探测 required 的 server：它启动全部 server，用 `awaitServerAttempts()`（`src/capabilities/mcp/availability.ts:21`）等每个 server 完成首次尝试（`src/doctor.ts:259`），把连不上的列进 `mcp_unavailable` 作为警告输出，不会让 doctor 失败。

## Review 与修正

AI review 只做一轮：ocr 报了 4 条，主会话读代码时另外发现 1 条，核实后全部成立，在同一子线程修正：

1. `stop()` 关不掉进行中的连接尝试 → 引入 `server.attempt`，支持中止、关闭并等待收尾；
2. `onerror` 不安排重连，配合 ready-only 过滤会让工具永久隐藏 → 补上重连；
3. `refreshTools()` 在 degraded 时校验漏掉自己的工具 → 抽出 `publishCandidate()` 共用；
4. 只读重试把已发出的请求记成 `server_unavailable` → 保留第一次请求的分类；
5. 重连期间常态警告闪烁 → `retrying` 状态也告警，并保留上次的错误码。

修正轮没有再跑 AI review，由主会话读 diff 逐条核对。主会话自己还补了一处：`connect()` 原来先等旧 client 关闭，再挂上 `server.attempt`，在这段等待里 stop 会漏掉这次尝试；改为先挂上 attempt 再关闭旧 client。

## 验证

快速层（修正轮前），主会话亲自运行：

```bash
pnpm run lint && pnpm run check
# exit 0
npx vitest run test/mcp test/mcp.test.ts test/config test/cut test/admin
# 88 files / 396 tests passed
```

完整层（交付前一次），主会话亲自运行：

```bash
pnpm run lint
pnpm run check
# exit 0
npx vitest run test/mcp/availability.test.ts test/mcp/availability-recovery.test.ts   # 连跑 3 次
# 每次 9 passed
pnpm test
# Test Files 1 failed | 406 passed | 1 skipped (408)
# Tests 1 failed | 2011 passed | 9 skipped (2021)
# 唯一的失败是已知的 test/recurring-alarms/schedule.test.ts（Windows 路径分隔符），与本次改动无关
MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两种 base 均 exit 0
pnpm run admin:test:e2e 01-routes 04-writes 10-developer 21-telegram 24-i18n
# 54 passed
node scripts/file-token-limit.ts && git diff --cached --check
# exit 0
```

只有子 agent 自报、主会话没有复现的：每个新增回归测试在修复前都会失败。

未执行：真实 Telegram 环境里断开或恢复 MCP server 的人工验收；真实外部 MCP server 的 `doctor`；Linux CI 上的全量测试。

## 提交

```txt
55267dfb Keep serving when MCP servers are unreachable
```
