# MCP 原生图片支持与验证记录

基线：`develop` / `932612cf8fc0d354ae4bc29f074e9bd1fecbaf8b`。验证环境为 Fedora 43、Node 24.22.2、pnpm 12.11.2。所有服务与数据均为临时目录中的隔离 fixture，没有连接 Telegram 或向外部聊天发送消息。

## 实现边界

原生 MCP `image`、纯图片、混合文本、多图和 `isError` 图片结果使用已有本地图片资产存储。canonical history 保存有版本的引用及结果位置；每次请求从 retained history 授权并加载图片字节，缓存和 SQLite 文本不持有 base64。Completions 仅在请求投影中把图片转成逐图带原始工具名/call ID 的 user 内容；canonical 工具身份不变。

Admin 工具审计、时间线、Transcript 和 Context 使用认证图片 URL 显示真实像素并放大。图片 GET 仅供 Panel Session，Bearer key 不自动取得新的媒体权限；Context 读取不依赖 Invocation 审计仍然存在。

没有新增图片生命周期服务、定时器或一组新配置。复用 `PlaygroundAssetStore` 的现有目录、格式校验、私有文件、去重和 staging grace；旧的 table/directory/class 名保留，MCP 也使用该存储，不开放 Playground MCP。清扫同时检查输入 media、工具审计和 canonical 引用；复用旧资产会续期 staging grace。cut 撤销模型读取，仍被历史记录引用的资产继续保留。

迁移 049 只增加 nullable 字段：`tool_calls.result_content_json`、`agent_messages.tool_call_id`、`playground_assets.last_used_at`。旧纯文本 MCP 保留原 JSON 包装与截断行为，旧工具历史可不含 details，新字段为空时使用原文本展示。

边界沿用已有配置和处理能力：MCP `payload_max_bytes` 配置及最大 1 MiB 不变；本地资产最多 10 MiB、40M 像素；规范化最长边 2048、JPEG/PNG 输出；请求加载工具图片共用现有 20 MiB 媒体字节预算，并遵守模型声明的图片数量约束。原生数据严格校验 base64、静态 JPEG/PNG/WebP 的 MIME/魔数和可解码内容。传输超限报告 `payload_limit`；格式错误、缺图、请求预算和不支持图片的模型均明确反馈，不自动重发工具或调用辅助 vision。

不包含 resource/link 抓取、音视频、动画、Telegram 主动发图、自动换模型或自动辅助视觉。现有 1 MiB wire 上限意味着部分大截图会被明确拒绝，这是保留的兼容约束。

## 自动验证

| 验证 | 覆盖 |
| --- | --- |
| `test/mcp/images.test.ts` | 真实 stdio MCP、混排顺序、多图、纯图、isError、旧文本包装、缺图、无视觉能力、越权、cut、审计过期、清扫及 staging grace |
| `test/mcp/image-limits.test.ts` | stdio/Streamable HTTP 真实运输、native image、HTTP/stdio payload 超限、base64/MIME/大小拒绝及模型图片数量限制 |
| `test/mcp/providers.test.ts` | 四个真实 Pi adapter 经隔离 HTTP fixture 发出请求；Completions 多工具/复合 call ID、Responses 图片 output、Anthropic 错误图片结果、Gemini 2/3 格式；四种 wire 图片脱敏 |
| `test/agent/runtime-mcp-images.test.ts` | AgentRuntime → stdio MCP → canonical → 请求加载；关闭后重新打开 SQLite、创建新 Runtime，恢复相同图片字节与错误状态；工具调用身份审计 |
| `test/admin/tool-images.test.ts` | Session 认证、Bearer 拒绝、PNG 字节、nosniff/private/no-store、错误工具/Invocation/资产拒绝、带分隔符的 call ID、审计删除后的 Context 读取、缺文件 |
| `test/schema/migrations-mcp-images.test.ts` | 从 048 升级，保留旧工具文本、无 details 的历史和原本地图片元数据，验证外键一致性 |
| `test/context/store.test.ts`、`test/models/request-audit.test.ts` | 旧历史可读；data URL、Anthropic source.data、Google inlineData.data 脱敏且不误删普通 data 字段 |
| Admin E2E `23-mcp-images` | 真实 AdminServer、SQLite、生产 SPA/CSP、真实图片加载 naturalWidth、混排、放大、Transcript/Context 和刷新恢复 |

仓库检查命令：

```sh
pnpm run check
pnpm run lint
pnpm test
pnpm run admin:build
pnpm run admin:test:e2e 01-routes 03-invocation-detail 05-readonly-security 06-trust-boundary 23-mcp-images --workers=2
```

执行结果：完整 `pnpm test --silent` 为 **363 个测试文件、2,008 项全部通过**；上述五组 Admin E2E **43 项全部通过**；`check`、`lint`、Admin 构建通过。冷恢复测试还单独验证了先停止 MCP、关闭原 SQLite，再打开数据库并创建新 Runtime 的路径。首次完整测试暴露的 5 个迁移断言已更新为版本 049 及新增字段的明确 null 值，并通过完整复跑。

Provider fixture 有意在收到请求后返回 400 终止，因此它证明真实 adapter 的 wire 契约，不代表真实供应商接受或理解了图片。fixture 的 `image-model`、`claude-sonnet-4`、`gemini-3-flash` 和 `gemini-2.5-flash` 是用于选择适配路径的测试 ID，不能据此宣称这些真实模型已验收。

## 真实视觉验收：已准备入口，缺少测试凭据

当前没有发现专用测试模型凭据或仓库测试环境文件，未对任何真实模型/供应商端点完成视觉验收。

入口：`test/mcp/live-vision.ts`。它启动真实的临时 stdio MCP，返回仅图内含随机六位码的原生图片，工具文本不泄漏答案；停掉 MCP 后校验第一次真实模型请求，再启动全新 Node 进程从 SQLite 历史恢复并再次请求。两次都检查 wire 中含图片并精确核对答案，不把第一次模型答案保存到历史，防止文字复述冒充图片恢复。完成或失败均清理临时配置、数据库和图片；不会连接 Telegram，也不要求测试 Chat。

需要现有合法专用环境提供以下环境变量，不要提交凭据文件：

- `SUROWAN_MCP_IMAGE_TEST_API`：四种支持的 API 名之一。
- `SUROWAN_MCP_IMAGE_TEST_BASE_URL`：明确允许使用的测试端点。
- `SUROWAN_MCP_IMAGE_TEST_MODEL`：该端点可用的视觉模型 ID。
- `SUROWAN_MCP_IMAGE_TEST_KEY`：仅供该隔离验证使用的合法测试凭据。

配置好环境后执行：

```sh
node test/mcp/live-vision.ts
```

该命令会产生两次真实模型调用。缺少配置时在启动 MCP、创建临时数据和发起模型请求之前失败，并列出具体缺少的变量。仅凭 fixture 通过不能将本节改成“真实验收通过”。

## 浏览器截图

截图使用合成数据，没有真实业务消息或凭据。

![工具审计中按原位置混排文本与两张图片](audit.png)

![放大查看工具图片](enlarged.png)

![Context 历史中的真实图片](context.png)
