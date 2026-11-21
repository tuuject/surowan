# Surowan - 20261121 Invocation 页面实时自动刷新

## 背景

用户希望在 Admin Panel 上盯一次正在运行的 Invocation 时，新的 Tool 调用、模型调用、发送和状态变化能马上出现，不用手动刷新；要有一个「自动刷新」开关，默认打开，可以关掉。

改动前：

- Invocation 列表（`apps/admin-next/src/pages/invocations.tsx`）走 `SnapshotList`，每 15 秒在同一个服务端快照（`as_of`）里轮询一次；新行只计进「打开列表后新增了 N 条记录」提示条，读者点了才出现。
- 详情页（`apps/admin-next/src/pages/invocation-detail.tsx`）运行期间完全不刷新。
- 进程里没有事件总线，面板也可以不带 agent runtime 独立运行，所以「有变化」只能从 SQLite 本身读出来。

传输方式选了 Server-Sent Events，没有用 WebSocket：同源 `EventSource` 自动带上现有的 `HttpOnly` + `SameSite=Strict` 面板 Cookie，生产 CSP 的 `connect-src 'self'` 允许它，不需要新依赖（`@hono/node-server` 上做 WebSocket 要加 `@hono/node-ws` 和 upgrade 路径），响应也是标准的 `Response` 流。

本次由 Pi（`magpie/opencode-go/deepseek-v4.1-flash`，thinking `max`）在 T3 子线程里实现，一轮首次实现加一轮 review 修正。主会话负责任务说明、ocr 审阅与逐条核实、复验和交付。

## 主要变更

### 1. 服务端：两条只给面板 Session 的 SSE 变更流

`src/ingress/admin/routes/live.ts`（`createLiveAdminHandler`，`:52`）新增 `GET /api/live/invocations` 与 `GET /api/live/invocations/:id`，在 `src/ingress/admin/index.ts:361` 的鉴权后分发链里接一行：

```ts
response ??= await routes.live.handle(request, segments, caller);
```

- 只给面板 Session：路由不登记 `@surowan/admin-surface`，Bearer key、已配对客户端与 MCP 调用方在网关就被拒；handler 自己再判一次 `caller !== 'session'` 返回 403。非 `GET` 405，`:id` 非整数 400，行不存在 404，都在开流之前判定（`EventSource` 拿到 200 会无限重连）。
- 流不带数据，只说「你在看的东西变了」：先写 `retry: 3000`，连接时立刻推一次事件补上「首次请求」到「流打开」之间的空档，之后只在指纹变化时推 `event: change`，页面收到后重取原有 JSON 端点，脱敏与响应形状仍只有一处。
- 每秒一拍；每 15 秒一次 `: ping` 心跳，同一拍用 `AdminAuth.authenticate` 复查 Session，登出或被撤销就关流。
- 收尾：客户端断开（请求 `signal` 与 stream `cancel`）、`AdminServer.stop()`（复用已有的 `healthSignal`）、Session 失效三条路径都清定时器。定时器在首次指纹之前创建（`:181`），所以首拍就失败时也能被清掉；指纹查询与 Session 复查都包了 try/catch，数据库忙或已关闭只会结束这条流，不会从定时器里抛出未捕获异常。
- 上限：每进程最多 32 条流（`DEFAULT_MAX_STREAMS`，超出 503 `live_streams_exhausted`）；流的队列上限 8 个 chunk（`MAX_QUEUED_CHUNKS`），读端不再排空就断开，不让队列无限增长。

### 2. 指纹查询与迁移 067

`src/ingress/admin/audit/invocation-live.ts`：

- `invocationLiveFingerprint`（`:62`）把该 Invocation 的 `invocations` 行、名下 `tool_calls` / `model_calls` / `host_sends` / `agent_messages` / `invocation_messages` 的逐行签名和 resumed-by 链接折成一条聚合查询，再取 sha256 前 16 位。签名覆盖 UPDATE：状态、`finished_at`、token 与 cost、错误码，以及模型调用在 `pending` 期间才写入的请求/响应快照：

  ```sql
  (m.request_json IS NOT NULL) || '~' || (m.response_json IS NOT NULL) AS sig
  ```

  大文本只看 `IS NOT NULL`，不用 `LENGTH(...)`，每拍的代价按行数而不是按字节算。
- `invocationListLiveFingerprint`（`:123`）用 `COUNT(*)` / `SUM(id)` / `MAX(id)` 覆盖插入与删除，再借 `(state, id)` 索引折出所有非终态行及其名下的 tool/model 调用。
- 迁移 `src/store/migrations/067_host_sends_tool_call_index.sql` 加 `host_sends(tool_call_id)` 索引，Drizzle schema（`src/store/schema/agent-loop.ts`）同步。没有它，详情指纹每拍都要整表扫 `host_sends` 再回探 `tool_calls`（10 万发送约 9ms）。`test/schema/index-plans.test.ts` 断言两条指纹查询的计划里没有整表扫描；硬编码最新迁移版本的 4 处既有断言随之更新，`test/image/delivery-file.test.ts` 的索引快照排除新索引。

### 3. 前端：订阅 hook、合并重取与开关

- `apps/admin-next/src/hooks/use-live-refresh.ts`（`useLiveRefresh`，`:27`）：开着且标签页可见时保持一条 `EventSource`；标签页切到后台就关（浏览器每个源只允许约 6 条 HTTP/1.1 连接），回到前台重连并重取。流出错时自己关掉它，期间每 5 秒轮询一次查询，并按 2 秒起、30 秒封顶的退避重连。组件不直接写 `useEffect`，订阅只在这个可复用 hook 里。
- `apps/admin-next/src/lib/coalesced-refresh.ts` + `apps/admin-next/src/hooks/use-coalesced-refetch.ts`：事件到达时如果已有重取在途，不取消它，只记下欠一次，等它结束后补一次。TanStack 的 `refetch()` 默认会取消在途请求，忙碌的运行里每秒一个事件就可能让大详情永远落不了地。
- 偏好 `invocationAutoRefresh` 放进持久化的 `apps/admin-next/src/stores/ui.ts`（`surowan-admin-ui`），默认 `true`，旧存档没有该键时读作开；两个页面共用 `apps/admin-next/src/components/invocations/auto-refresh-switch.tsx`。四种语言新增 `layout.business.autoRefresh`（Auto refresh / 自动刷新 / Automatisch aktualisieren / التحديث التلقائي）。
- 关掉开关就完全没有自动刷新：列表查询不再有 15 秒 `refetchInterval`（开着时也去掉，全由流驱动），列表与详情查询都设 `refetchOnReconnect: false`。

### 4. 详情页与列表页

- 详情页：每个事件重取 `invocationQuery`，查询在途时保留旧数据，所以当前标签页、展开的行与滚动位置都不动。一次后台重取失败（`QueryClient` 不重试）不会再把页面换成错误页，也不停流，下一个事件或轮询就能恢复；只有 404（Invocation 被删）才停止订阅并显示错误页。
- 列表页：`SnapshotList` 新增可选 `live` 属性，其它列表行为不变。自动换快照改成在 `useSnapshotPages` 的渲染期里声明式判断（`apps/admin-next/src/components/business/snapshot-list.tsx:120`）：读者在第 1 页、当前快照（任意一页）报过 `new_count > 0`、且拿到的不是占位数据时，换新快照，并把当前第 1 页的行作为新请求的占位，表格不会闪加载骨架；第 2 页及以后只刷新当前行，到达仍计进提示条。这样也避免了回调里拿旧的 `page` 把读者从第 2 页拽回第 1 页，以及「在第 2 页数到的到达回第 1 页后看不到」两个问题。

### 5. Review 意见处理

首轮实现后用 `ocr review`（workspace 模式）审了一轮，共 11 条；主会话逐条回代码核实，加上自己发现的 1 条，合并成 9 项打回：

| 意见 | 判定 | 处理 |
| --- | --- | --- |
| 首拍失败后才建定时器，永远清不掉 | 成立 | 定时器先于首次指纹创建 |
| 心跳里的 Session 复查没有错误保护，可能抛出未捕获异常 | 成立 | try/catch 后结束这条流 |
| 读端不排空时队列无界 | 成立（影响小） | `highWaterMark` 8 + `desiredSize` 判断 |
| 指纹漏掉 pending 期间写入的请求/响应快照；`LENGTH` 每拍按字节读 | 成立 | 加两个 `IS NOT NULL` 标志，`LENGTH` 换成 `IS NOT NULL` |
| 一次后台重取失败就整页变错误页并停流 | 成立 | 有数据就保留，只有 404 停 |
| 事件频繁时重取互相取消 | 成立（ocr 与主会话都发现） | 合并重取 |
| 第 1 页换快照：旧闭包拽回第 1 页、第 2 页数到的到达丢失、骨架闪烁（最后一条为主会话发现） | 成立 | 渲染期声明式换快照 + 占位沿用 |
| 关掉开关后断网重连仍会刷新 | 成立 | `refetchOnReconnect: false` |
| e2e「关掉」窗口 3 秒短于 5 秒兜底轮询 | 成立 | 窗口改 6.5 秒并断言窗口内无 `/api/live/` 与查询请求 |
| e2e 只插新行，没测已有行的 UPDATE | 误报 | vitest 已覆盖各表 UPDATE，e2e 也测了运行结束的状态变化 |

修正轮按约定不再跑 ocr，由主会话逐条对照与复验。子 agent 报告修正轮的回归测试在修复前均失败（第 9 项除外：它对旧代码本来就通过，子 agent 把 `enabled` 临时改成恒真确认窗口有效后还原）。

## 验证

主会话在子 agent 的 checkout 里亲自跑（修正轮之后、提交之前）：

```bash
git diff --cached --check                 # 通过
pnpm run lint                             # 通过
pnpm run check                            # 通过
git add -A && node scripts/file-token-limit.ts   # ok
pnpm test                                 # 483 files / 2489 tests 全部通过（472s）
pnpm run admin:build && pnpm run admin:test:e2e  # 385 passed（1.7m）
pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify                                # 通过
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify  # 通过
git status --porcelain                    # 构建后无新增或未暂存文件
```

首轮之后主会话还跑过一遍快速层：`test/admin`、`test/schema`、locales 与迁移相关测试共 89 files / 419 tests 通过，`test/admin/live-invocations.test.ts` 连跑 3 遍 9/9。

子 agent 自报（主会话未单独重跑）：`pnpm run admin:test:e2e 40-invocation-live-refresh --repeat-each 5` 35 passed；修正轮 `pnpm test test/admin` 68 files / 317 tests、`pnpm test apps/admin-next/src` 8 files / 45 tests。

提交后 rebase 到 `origin/develop`（`0bf97468`），新增的上游提交只改了 `doc/design/20261121-suroscript-code-mode.md`，没有重跑验证。

基线：在 base（`018bae37`）的主 checkout 里跑全量时，`test/admin/decision-gate-list.test.ts`、`test/admin/decision-gate-secrets.test.ts`、`test/admin/mcp.test.ts` 共 5 个用例失败；它们在本分支的 checkout 里全部通过，与本次改动无关。

未执行：真实浏览器长时间挂着的人工验收、反向代理（nginx 等）后面的 SSE 缓冲实测、`doctor` 与真实 Telegram 验收。

## 提交

```txt
2b8196a8 Add live auto-refresh to the Invocation pages
```
