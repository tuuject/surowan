# Surowan - 20261119 MCP 渐进式暴露、`mcp` 网关与描述起草

## 背景

出站 MCP 的每个 Tool 都以 `<alias>__<tool>` 直接进入 Agent 的工具注册表，每次请求都要带上全部定义。注册表有硬上限：总共 64 个，MCP 最多 61 个（`src/capabilities/mcp/tool-sets.ts` 的 `validateResolution`）。整张表还不能超过模型上下文窗口的 10%。一个有几十个 Tool 的 Server 就能把这两条线都顶满。

用户提出的需求和讨论中拍板的决定：

- 提供 MCP tool search 与聚合，所有渐进式 Server **共用一个入口**；
- 模型一次看不全工具、群友也无法提示它有哪些 MCP 能用，所以每个 Server 需要一段 description。用户可以手写，也可以让 tool model 根据它暴露的 Tool 起草，但都要用户在 admin panel、CLI 或 MCP 里操作并确认；
- 直接暴露还是渐进式暴露**按 Server 设置，不能按 Chat 覆盖**；
- 渐进式 Server 没写 description 时，用 Tool 名列表兜底，并在 Warnings 页告警；
- 顺带优化中文搜索。

改动前的相关状态：`execute` 已经用 search/help/call 渐进暴露内部能力，但 AGENTS.md 的安全约束不允许 MCP Tool 经 `execute` 调用；`dictionary merge preview` 已有「tool model 起草 → 用户确认 → 另一个端点写入」的先例；admin-surface 的一张路由表同时生成面板、CLI 与反向 MCP；`sameMcpServerConfig` 已经把废弃的 `required` 排除在实例身份之外。`execute.search` 的分词只认 `[a-z0-9_]`，中文 query 只能整句命中。

用户没有要求先写 PRD，本次直接实现。

## 主要变更

### 1. 配置字段与热更新语义

`src/platform/config/schema-model.ts` 新增 `McpExposureSchema`（`direct` | `progressive`）和 `McpServerDescriptionSchema`（1–1000 字符）。两种 transport 的 Server 都可选 `exposure` 和 `description`；`semantics.ts` 另外拒绝全空白的 description。

`sameMcpServerConfig`（`src/capabilities/mcp/bindings.ts:48`）把这两个字段和 `required` 一起排除。这两个字段只改变模型看到同一批 Tool 的方式，不改变 Chat 能调用什么，所以只改它们不重连、`affectedMcpChatIds` 不计入、不触发 cutover 和 Context 重建，下一次 Invocation 起生效。反过来，把 Server 从 progressive 改回 direct 可能撑破上限，这种情况由热应用的候选校验（`McpManager.toolSets(candidate)`）拒绝。

### 2. 按暴露方式分组与 `mcp` 网关

`chatToolSet`（`src/capabilities/mcp/tool-sets.ts:169`）按 Server 的 `exposure` 把一个 Chat 解析出的定义分成 `direct` 与 `progressive` 两半。exposure 和 description 读的是调用方传入的配置，不是实例上的旧配置。`buildTools` 把 direct 逐个建成 Tool；只要有 progressive Server 贡献了 Tool，就再追加一个 `mcp`。`resolutions` 的分组签名同时带上 progressive Server 的 alias、description 和策略。`definitions` 退化为两半合并，所以 `toolNamesForChat` 仍然列出全部暴露名。

`createMcpGatewayTool`（`src/capabilities/mcp/gateway.ts:72`）：

- **索引**放在 Tool 描述里，不放 system prompt。system prompt 的稳定段一变就要重建 Context，而 Server 是否 ready 每次 Invocation 都可能不同。索引的每一行是 `alias (N tools): description`，没有 description 时退回前 8 个 Tool 名；
- **search** 接受 `query` 和/或 `server`。只给 `server` 时列出该 Server 全部 Tool（上限 100 条）；带 `query` 时取前 10，Server 描述也参与评分，所以中文描述的 Server 能被中文请求找到；
- **help** 返回 `{tool, server, read_only, description, input_schema}`；
- **call** 先用定义自带的 validator 校验输入，失败时只记外层 `invalid_arguments`，并提示先 `help`。校验通过后调用 `executeMcpTool`，内层 tool call id 为 `<toolCallId>:<alias>__<tool>`。结果原样返回、不套封套，工具图片的位置不变；
- **审计**：外层写一行 `mcp`，内层是真实的 `<alias>__<tool>`，MCP cutover 按工具名收集 `outcome_unknown` 的逻辑因此不用改。带图片时两行都写 `result_content_json`。直接暴露的 Tool 经网关调用会得到 `unknown_tool`。

`mcp` 加进 `EXECUTE_PRIMITIVES`（`src/capabilities/execute-tool.ts:52`），`execute` 既不能注册也不能 dispatch 它。

### 3. 共享分词搜索

`src/platform/text-search.ts` 用 `Intl.Segmenter('zh', { granularity: 'word' })` 切词：保留 Latin 词（`_` 连接的名字转成空格形式），去掉中文常见虚词和单个假名。评分沿用 `execute` 原有的规则：整句命中加 10，每个词元按字段顺序取第一个命中字段的权重。`execute.search` 改用它，英文排序不变。例：「帮我查一下北京明天的天气」切出 `查 / 北京 / 明天 / 天气`。

### 4. description 起草与编辑

- `draftMcpServerDescription`（`src/capabilities/mcp/describe.ts:97`）照搬 dictionary merge 的 tool-model 调用与 `model_calls` 审计。它只读该 Server 当前 `tools` 选择下的 Tool 名和描述，以及 initialize 返回的 `instructions`（`connection.ts:193` 起开始保存）。这些数据作为不可信 JSON 交给模型，回复用 Schema 校验。
- 新增 `POST /api/mcp-servers/:alias/description-draft`（`src/ingress/admin/routes/mcp-servers.ts:72`）：不需要 `If-Match`，从不写文件。错误码：未知 alias 404，未发现被选中的 Tool 409 `mcp_server_not_ready`，tool model 不可用 502。admin-surface 加 `mcp-server describe`（`access: 'paid'`、`confirm: 'paid'`），CLI 和反向 MCP 自动获得同一能力。
- `PUT /api/mcp-servers/:alias` 的 `tools` 和两个上限改为可省略（省略即保留），`exposure`/`description` 可以单独提交。`presentationFields`（`src/ingress/admin/mcp-servers/write.ts:157`）的规则：`direct` 删字段回到缺省，description 去掉首尾空白，`null` 或空白即删除。`write.ts` 因此超过 5,000 token 的提交上限，Header 密钥解析原样移到 `src/ingress/admin/mcp-servers/headers.ts`。
- Warnings 新增常驻告警 `mcp_description_missing`（`src/platform/warning-catalog.ts:47`），卡片链到 MCP servers 页。

### 5. 面板

- 编辑对话框新增暴露方式单选、描述输入框和「用工具模型起草」按钮：草稿只填进输入框，保存才写入；新增 Server 时提示先保存。渐进式且没有描述时显示提示。保存前的 cutover 提示改为说明「暴露方式与描述不打断运行」。
- 列表里的 progressive Server 带徽标，详情对话框显示暴露方式和描述。
- 四个 locale 补齐文案。

### 6. 文档

- `AGENTS.md` 的工具分层；
- `agent-doc/telegram-agent-flow.md` 新增「渐进式暴露与 `mcp` 网关」；
- `agent-doc/configuration.md` 补两个字段与热更新语义；
- `agent-doc/admin-panel.md` 补写端点白名单、视图字段和告警；
- `agent-doc/verification.md` 登记新测试；
- 用户指南 `apps/docs/content/docs/guides/extensions.md` 新增「直接暴露与渐进式暴露」；
- `skills/surowan-utils/references/panel.md` 的计费操作表加 `mcp-server describe`。

`src/platform/prompts/2-product-knowledge.md` 没改：现有那行仍然成立，改动它会让全部 Conversation Context 重建。

## 验证

```bash
npx vitest run test/mcp/progressive.test.ts test/skills/execute-search.test.ts test/admin/mcp-servers-presentation.test.ts
# 3 files / 11 passed
npx vitest run test/admin/mcp-servers-writes.test.ts test/admin/mcp-servers-writes-callers.test.ts \
  test/admin/mcp-servers-writes-policies.test.ts test/admin/mcp-servers-presentation.test.ts \
  test/admin/mcp-servers-view.test.ts test/admin/chats-mcp.test.ts
# 拆出 headers.ts 之后重跑：6 files / 22 passed
pnpm test
# Test Files 1 failed | 450 passed | 1 skipped (452); Tests 1 failed | 2248 passed | 9 skipped (2258)；915 s
# 唯一失败：test/group-memory/store.test.ts「a keyword search reaches an entry older than thousands of
# non-matching ones」Test timed out in 5000ms。未改动的 develop（58d033d8）上单独运行 3 次也失败 2 次，与本次改动无关
pnpm run lint && pnpm run check && git diff --check
# exit 0
pnpm run admin:build && pnpm run admin:test:e2e 37-mcp-servers 17-dictionary-merge 18-tool-model
# 12 passed；新用例产物：页面截图与 mcp 配置段（exposure: progressive，description 为确认后的文本）
DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify          # PowerShell
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify  # PowerShell
# 两种 base 均 Verified 54 pages，构建后没有生成物改动
```

未执行：全量 `pnpm run admin:test:e2e`（只跑了受影响的三个套件）；在真实 Telegram 群里让模型经 `mcp` 网关搜索和调用外部 MCP 的人工验收；用真实 provider 起草 description。

## 提交

```txt
920125c1 Add progressive MCP exposure behind an mcp gateway
```
