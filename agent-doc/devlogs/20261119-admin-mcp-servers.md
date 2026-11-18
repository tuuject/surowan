# Surowan - 20261119 Admin Panel 管理出站 MCP server 与按群绑定

## 背景

#93（按群绑定、热重载与定向 cutover）和 #94（连不上时照常服务）之后，出站 MCP（`mcp.servers[]`，由 `McpManager` 运行）已经能热重载：改配置不用重启，受影响的群会被 fence、停止、重建并续跑。但 Admin Panel 里还没有对应的页面。面板上唯一能看到 MCP 的地方是常态警告，要增删 server、改工具范围或按群绑定，都只能去服务器上手改 `config.jsonc`。用户要的是一个「make sense」的管理面板。

需要事先说清两件事：

- 仓库里有两个「MCP」。这次做的是 bot 自己去连的**出站 MCP**；`src/ingress/admin/mcp/` 是 Surowan 把 Admin API 暴露给外部 Agent 的**反向 MCP Server**，两者不能混。新代码统一叫 `mcp-servers`，路由是 `/mcp-servers`，API 前缀是 `/api/mcp-servers`。
- stdio server 的 `command` / `env` 不能在面板上写，这是用户在派发前拍板的。理由与 keychain PRD（`doc/design/20261116-keychain.md`「环境变量与外部命令」）一致：能写外部命令或环境变量，就等于面板能在宿主机上执行任意程序。

本次由 T3 委派 Pi（`magpie/opencode-go/glm-5.3`，thinking `max`）在子线程「Admin Panel page for managing outbound MCP servers」里实现。主会话负责任务说明、ocr 审阅、逐条核实、打回修正和独立复验。派发前，主 checkout 快进到 `origin/develop`（`8ff62c67`），这样子 agent 能直接复用 keychain 的密钥输入组件。

## 主要变更

### 1. 只读视图：`GET /api/mcp-servers`

`src/ingress/admin/mcp-servers/read.ts:134` 的 `mcpServersView` 为每个配置的 server 返回以下内容：

- 实时状态，来自 `McpManager.serverStates()`，只给错误码和下次重连时间，不给原始错误文本；
- 连接摘要；
- 工具范围、上限与 policy；
- server 实际广告过的工具，并标出是否暴露、生效 policy；
- 显式绑定它的群，以及没写 `mcp`、因而继承全部 server 的群。

工具列表来自新的只读访问器 `McpManager.serverToolListings()`（`src/capabilities/mcp/index.ts:118`）。`connect()` 和 `refreshTools()` 成功后把完整的 `listTools` 结果存进 `server.advertised`（`src/capabilities/mcp/connection.ts:190`、`:258`），`stopServer` 清空它。它不受 server `tools` 设置的过滤，所以面板能列出「广告了但没暴露」的工具，按群绑定也能从中挑。`serve-run-admin.ts` 用传 `mcpServerStates` 的同一种方式把它交给 admin 层；不在 `serve` 里时（测试、独立面板）就没有实时数据。

脱敏规则：

- stdio 只给程序名（`command[0]` 的 basename）、参数个数和 env 变量名，argv 不出服务端；
- 面板会话能看到每个密钥的来源，程序化调用方（API key、已配对客户端）只能看到名字；
- 程序化调用方看到的 HTTP URL 只有 origin（`redactedUrl`，`read.ts:130`），同时带 `url_redacted: true`。托管 MCP 常把 token 放在 path（Zapier 式 `/mcp/<secret>/sse`）或 query 里，后者既可能是 AMAP 的 `?key=`，也可能是裸参数名。面板会话保留完整 URL，因为编辑表单要用。

广告的 description 和 inputSchema 是不可信数据：详情对话框按纯文本渲染，schema 交给 JsonViewer，不走 Markdown/HTML。

### 2. Server 写入

`src/ingress/admin/mcp-servers/write.ts`：

- `createMcpServer`（`:231`）只接受 streamable HTTP。提交 stdio 返回 400，并提示去服务器上改 `config.jsonc`。`follow_redirects` 固定写 `false`。
- `updateMcpServer`（`:294`）以 alias 为身份，不能改名。HTTP 能改 URL、header、工具、上限与 policy；stdio 只能改工具、上限与 policy，带 `command` / `env` / 改 `transport` 一律 400，文件不变。`policyFields`（`:115`）先把两个 policy 字段从基底里剥掉再合并，所以显式 `null` 真的删除字段，省略则保留。
- `deleteMcpServer`（`:431`）对两种 transport 都可用。还有群显式绑定这个 alias 时返回 409，并列出群 id，与「keychain 条目被引用时不能删」同一规则。admin-surface 里标为 `confirm: 'destructive'`。
- header 密钥走 `src/ingress/admin/secret-input.ts`，与网络搜索设置同一套规则：面板会话可以填新明文，也可以选已有 keychain 条目；程序化调用方只能交新明文。程序化调用方改 URL 却沿用已存的 header 时被拒绝，必须在同一请求里重填。例外是原样回传 `redactedUrl` 的 origin（`write.ts:350`）：这算没改 URL，保留原值。没有这条，CLI `--file` 或 Agent「先读再写」时会把打码 URL 写回，覆盖真实地址。
- 名为 `__proto__` 的 header 被拒绝：累加器改成 null-prototype，而 `jsonc-parser` 读配置时本来就会丢掉这个键，写进去也是死配置。
- 写入前用 `validateSemantics` 校验候选配置，带上部署实际注册的搜索 provider，这样未知 alias、工具与 policy 不一致等问题直接以 400 返回，而不是变成 apply 失败。

`src/ingress/admin/routes/mcp-servers.ts` 负责 `If-Match`、32 KiB body 上限，以及 `writeSecretsAndApply` / `writeAndApply`。POST/PUT 解析所用的快照，和调用方 revision 对应的是同一份文件（`:128`）。原因是 body 流入期间如果别的写入者提交了，内容恰好相同的 no-op 请求会绕过最终的 revision 复核，带着过期 `If-Match` 拿到 200。响应是刷新后的视图加 `apply` 结果，前端按现有的 `applyFeedback` 约定区分「已应用」和「已保存、需重启」。

### 3. 按群绑定：`PUT /api/chats/:id/mcp`

`src/ingress/admin/chat-mcp.ts:44` 用 `{ mode: 'inherit' | 'none' | 'explicit' }` 表达 `telegram.chats[].mcp` 的三种状态：字段缺省、`[]`、绑定数组。绑定直接复用配置自己的 `ChatMcpBindingSchema`，整份候选配置过一遍 `validateSemantics`。Chats 视图每个群多返回一个 `mcp` 字段，供对话框回填。

前端 `apps/admin-next/src/components/chats/mcp-binding-dialog.tsx` 从 Chats 页行菜单打开，纯逻辑抽在 `mcp-binding-draft.ts`：

- `bindingWriteBody`（`:116`）原样保留绑定已有的 `tool_policies`，只丢掉被取消选择的工具的 policy；
- `reconcileBindingDrafts`（`:76`）让对话框打开期间新出现的 server 也能勾选；
- `bindingChoices`（`:95`）在 wildcard server 尚未完成发现时，回退到已保存的工具名。

### 4. 页面与 CLI / 反向 MCP 对齐

新页面 `/mcp-servers` 放在 `agentSetup` 导航组里，紧挨 Search settings。新增/编辑对话框的 HTTP header 复用 keychain 的 `HeaderFields` 与 `header-rows`。stdio 的连接字段只读展示。「全部工具」模式下也能编辑按工具的 policy 覆盖，wildcard server 的覆盖不会在无关编辑时丢失。保存前提示：用到这个 server 的群，进行中的运行会被停止并续跑。文案覆盖 `en`、`zh-CN`、`de-DE`、`ar` 四个 locale，绑定对话框使用 Koi 的 `Checkbox` / `RadioGroup`。

`packages/admin-surface/src/specs/mcp-servers.ts` 加了 `mcp-server list|create|update|delete` 四行，`specs/chats.ts:61` 加了 `chat mcp`。`surowan-utils` 和反向 MCP 的 `surowan_*` 工具因此自动获得同等能力，写入要求 `write` 权限与 config revision。`skills/surowan-mcp/` 与 `skills/surowan-utils/references/panel.md` 同步更新了工具/命令清单和 URL 规则。

### 5. 顺带修的共享写路径

`KeychainController.#writeAndApply`（`src/adapters/local-monolith/config/reload-keychain.ts:216`）原来调用 `writeConfigEdits` 时没有带上 reloader 的 load options。结果是所有带 keychain 条目的写入，都会把插件注册的搜索 provider 当成未知 provider 而拒绝。现在由 `ConfigReloader` 把 `#loadOptions` 传进来。

### 6. E2E 与文档

E2E 服务器直接启动 `AdminServer`，不跑 `serve`。只有 `test.use({ mcpManager: true })` 的 spec（`37-mcp-servers`）和 `admin:dev:mock` 才会启动一个真实的 `McpManager`：连 `test/fixtures/mcp-server.ts` 的 stdio fixture，外加一个必然 degraded 的 HTTP server；`onPublished` 时 reconcile，关停时先 stop 再关 store。其他 spec 保持「不跑连接管理器」的原有足迹。早先让全部 spec 都起 manager 时，`10-developer` 在全量 e2e 下会超时，所以改成了按需启动。`37-mcp-servers.e2e.ts` 的每个用例都用 API 自建前置状态，能单独运行；Chats 用例解析写出的 JSONC，逐个断言 explicit、`[]` 和继承（字段缺省）三种值；结尾输出页面截图和 `config.jsonc` 的 mcp 段作为产物。

文档：`agent-doc/admin-panel.md` 新增「MCP servers 页」一节，并在写端点白名单里加了对应行；`agent-doc/configuration.md` 说明面板可改、stdio 连接字段只读；用户指南 `apps/docs/content/docs/guides/extensions.md` 新增「在面板里管理」；`src/platform/prompts/2-product-knowledge.md` 原先写着「MCP 改动需重启」，这在 #93 之后已经不成立，这次一并改正。

## Review 与修正

AI review 只做一轮：ocr 在首轮实现上报了 14 条。主会话读代码时另外发现 2 条，与 ocr 的第 1、5 条重合。逐条核实后，13 条成立，1 条（嵌套三元的风格问题）丢弃。成立的 13 条里，「Chats 绑定对话框的工具选择」和「server 列表的 URL 显示」各有两条，修正轮按问题合并成 11 项，再加上一项 Koi 组件替换，共 12 项打回同一子线程：

1. 绑定对话框保存时清空绑定已有的 `tool_policies`，只读覆盖悄悄失效 → 保留，只丢弃被取消选择的工具的 policy；
2. wildcard server 的按工具 policy 覆盖会被表单丢掉，后端 `null` 又删不掉字段，两个 bug 互相掩盖 → 两边一起修；
3. HTTP URL 原样返回给程序化调用方，query 里的 key 会泄露 → 程序化调用方的 URL 打码；
4. wildcard server 尚未完成发现时，隐藏已保存的窄化选择，保存时却照样提交 → 控件不再依赖发现结果；
5. 对话框打开期间轮询到的新 server 无法勾选 → 草稿与 server 列表对齐；
6. 保存和删除忽略 `apply` 结果 → 改用 `applyFeedback`；
7. 预校验没带插件搜索 provider → 从路由依赖传入。修这条时发现了第 5 节的共享路径问题；
8. 拒绝 `tools: []` → 放开；
9. 无改动的写入带过期 `If-Match` 也能返回 200 → 改用快照的 revision；
10. `__proto__` header 被静默吞掉 → 明确拒绝；
11. e2e 用例互相依赖、断言过松 → 每个用例自建状态并精确断言；
12. 绑定对话框用了原生 radio/checkbox → 换成 Koi 组件。

修正轮没有再跑 AI review。主会话复核时发现第 3 条只打码了 query 值：path 里的 token 和裸 query 参数名仍会泄露，程序化调用方先读再写时还会把打码 URL 写回去覆盖真实地址。于是再打回一轮，改为只给 origin，并且原样回传 origin 时视为未改。主会话自己只改了一处过时注释（`read.ts` 里 `redactUrls` 的说明）。

## 验证

快速层（每轮修正后），主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint && pnpm run check && pnpm --filter surowan-admin-next run check
# exit 0（首轮、第二轮均如此）
npx vitest run test/admin/mcp-servers-* test/admin/chats-mcp.test.ts test/admin/mcp.test.ts test/admin/chats.test.ts \
  test/admin/model-switch.test.ts test/admin/keychain test/config test/mcp test/mcp.test.ts test/cli apps/admin-next/src
# 第二轮连跑 3 次：每次 65 files / 339 passed / 6 skipped
pnpm run admin:test:e2e 37-mcp-servers --repeat-each 3
# 15 passed
```

完整层（交付前一次，rebase 之前的同一份改动），主会话亲自运行：

```bash
node scripts/file-token-limit.ts && git diff --cached --check
# exit 0 / exit 0
pnpm run lint && pnpm run check && pnpm --filter surowan-admin-next run check
# exit 0
pnpm test
# Test Files 432 passed | 1 skipped (433); Tests 2135 passed | 9 skipped (2144)；751 s
# base 8ff62c67 上同一命令有 3 个负载下的 5 秒超时（test/group-memory/store.test.ts 1 个、test/playground/only-serve.test.ts 2 个），这次全部通过
pnpm run admin:test:e2e
# 347 passed（2.7 min）
MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两种 base 均 Verified 54 pages；构建后 git status 没有未暂存或未跟踪的生成物
```

rebase 到 `origin/develop`（`1fb681d8`，上游 4 个前端/e2e 提交）之后，主会话重跑受影响部分：

```bash
pnpm install --frozen-lockfile
pnpm run lint && pnpm run check && pnpm --filter surowan-admin-next run check
# exit 0
npx vitest run test/admin test/cli apps/admin-next/src
# 85 files / 392 passed / 6 skipped
pnpm run admin:test:e2e 37-mcp-servers 01-routes 09-chats 23-mcp-images 24-i18n 25-koi-crud-structure 33-i18n-stress-layout 33-i18n-stress-rtl
# 91 passed, 1 failed：09-chats.e2e.ts:174「mobile Chat edit keeps all fields inside the dialog with long model IDs」
# （form scrollWidth 551 > clientWidth 280）
pnpm run admin:test:e2e 09-chats --grep "mobile Chat edit"
# 在本分支和纯 origin/develop（1fb681d8，同一 checkout detach 运行）上都同样失败，Received 551
# 这条用例由上游 #106 新增，失败与本次改动无关
```

只有子 agent 自报、主会话没有复现的：各项新回归测试在修复前会失败；每个 `37-mcp-servers` 用例都能单独 `--grep` 运行。

未执行：真实 Telegram 群里经面板改 MCP 配置后 cutover 的人工验收；真实外部 MCP server（包括 URL 里带 key 的 AMAP 和 path 里带 token 的托管服务）的端到端验证；Linux CI 上的全量测试。

## 提交

```txt
70243434 Add an Admin Panel page for outbound MCP servers
```
