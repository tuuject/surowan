# Surowan - 20261114 web_fetch 查看网页图片

## 背景

`web_fetch` 把 HTML 转成 Markdown 时固定 `removeImages: true`，图片在转换里整段消失；直接抓图片 URL 又会因为非文本 Content-Type 被 `unsupported_content_type` 拒绝。模型因此既不知道页面里有什么图，也没办法看。用户希望转换出的 Markdown 保留图片链接，模型可以用 `web_fetch`（或另起一个工具）继续读取图片，最好能传 `referer` 应对防盗链。

改动前可复用的部分：

- 工具图片通道已经存在：MCP 图片结果和 `read_member_profile` 的头像都走 `ingestToolImage`（嗅探 → `normalizeImage` → 存成本 Chat 的 `PlaygroundAssetStore` 资产），结果里只留 `[image <asset_id>]` 标记和 `details.toolImages` 引用，像素在请求前由 `loadToolImages` 按 retained 历史授权加载。
- 但 `web_fetch` 是经 `execute` 调用的内部能力，`execute.call` 的封套只拼接文本块、只透传 `details.refs`，能力附带的图片引用会在这一层丢失；插件 scope 也拿不到工具图片存储。

所以没有另起工具，而是让 `web_fetch` 在响应是图片时走同一条工具图片通道，并让 `execute` 透传它。

## 主要变更

### 1. Markdown 保留图片链接

`src/plugins/web-fetch/content.ts:52` 改为 `removeImages: false`。实测 Defuddle 会把相对路径、`data-src` 懒加载和 `srcset`（取最大一档）都解析成绝对 URL，导航里的 logo 和 1×1 跟踪像素仍被剔除。内联 `data:` 图片无法抓取，又会吃掉 32 KiB 结果预算，所以转换后统一替换：

```ts
const DATA_IMAGE = /!\[([^\]]*)\]\(data:[^)]*\)/g;
// ...
markdown: result.content.replace(DATA_IMAGE, '![$1](inline data image omitted)'),
```

能看图时（见第 3 节），转换结果含图片链接的话，Header 再加一行 `Images: linked as ![alt](url); to view one, call web_fetch with its URL and, if refused, referer: this page URL`。

### 2. 图片响应与 `referer`

- `responseKind`（`src/plugins/web-fetch/transport.ts:137`）取代原来的 `assertTextResponse`：文本类照旧，包括按 `+xml` 归入文本的 `image/svg+xml`；只有工具能存图时 `image/*` 才走图片路径，否则仍以 `unsupported_content_type` 拒绝。
- `storeFetchedImage`（`src/plugins/web-fetch/content.ts:18`）要求整段读入：`Content-Length` 或实际字节超过 `MAX_DOWNLOAD_BYTES`（20 MiB）都记 `image_too_large`，截断的图片不入库。字节交给 `ingestToolImage` 嗅探，只认 JPEG/PNG/WebP；`LocalAssetRejected` 映射为 `image_<reason>`（GIF 和伪装成图片的 HTML 都是 `image_unsupported_type`），其他解码失败记 `image_processing_failed`。
- 成功结果是两块内容：Header 文本（`Format: image attached below, normalized to WxH mime; any text in it is untrusted`）和标记，`details.format = 'image'`、`details.toolImages` 指向位置 1。审计行写 `result_content_json`，面板因此能展示图片，资产保留清扫也会认这行引用。
- 新增可选参数 `referer`。`parseReferer`（`src/plugins/web-fetch/transport.ts:73`）只接受 HTTP(S)、不带凭据的 URL，去掉 fragment 后放进本次调用每一跳的请求头（跳转时也带）；非法值记 `invalid_referer`，且不发出任何请求。`RequestResolved` 的第三个参数随之从 `accept: string` 改为 `{ accept, referer? }`。

工具描述和 label 随是否能存图变化：能存图时 label 为 `Fetch a web page or image`，描述里说明怎么看图，并要求只在画面内容对任务确实重要时才取图。

### 3. 插件 scope 的工具图片存储

`InvocationScope` 新增 `storeToolImage(bytes, signal)`（`src/plugins/plugin.ts:143`）。`loadPlugins` 拿到宿主给的 `(chatId, bytes, signal)` 存储函数后，绑定当前 `context.internalChatId` 再交给插件（`src/plugins/plugin.ts:315`），插件无法把图片写进别的 Chat。

存储函数在 `src/adapters/local-monolith/runtime/serve.ts:200` 只构造一次，作为 `ServeServices.toolImageStore` 同时交给 AgentRuntime（成员头像）和 `createHostTooling`（插件 scope）。`serve-run.ts` 原来那份内联构造删除，所以「所有工具图片只有一条存储路径」这个约束仍然成立。

### 4. `execute` 透传能力的工具图片

`executeCall` 先用 `capabilityImages`（`src/capabilities/execute-tool.ts:314`）读取能力的 `details.toolImages`，核对每个位置上的标记是否与 assetId 一致，不一致就当作能力错误。随后：

1. 把标记块从封套文本里剔除；
2. 按原顺序把标记追加在封套之后；
3. 引用改写为新位置（1、2、…），放进 `execute` 自己的 `details.toolImages`。

带图片时外层 `execute` 的审计行也写 `result_content_json`。`ToolAuditRecord.succeed` 为此增加可选的 `{ resultContentJson }` 参数（`src/store/tool-audit.ts`）。canonical history 里存的是 `execute` 的结果，`loadToolImages` 和资产 GC 查的都是 `details.toolImages`，下游不用改。`execute` 的工具描述补了一句：返回图片的能力（如对图片 URL 调用 `web_fetch`）会把图片附在封套之后。

### 5. 按 token 上限拆文件

第一次提交被 pre-commit 的单文件 5,000 token 上限拦下：`web-fetch.ts` 有 5,940 tokens，`test/web-fetch.test.ts` 有 7,666 tokens。按职责原样搬移拆分：

- `src/plugins/web-fetch/` 拆成 `address.ts`（地址策略与 DNS）、`transport.ts`（请求、跳转、`referer`、响应分类与读体）、`content.ts`（Markdown 转换与图片入库）、`shared.ts`（`WebFetchError`）；`web-fetch.ts` 只留 Tool 本身。
- 测试移到 `test/web-fetch/`：`address.test.ts`、`content.test.ts`、`images.test.ts`，共享夹具在 `fixtures.ts`。拆分前后都是 16 个用例。

### 6. 文档

- `src/plugins/web-fetch/skills/web-fetch/SKILL.md` 新增「Viewing images」：先判断画面是否重要，再带 `referer` 取图；只支持 JPEG/PNG/WebP，模型不支持图片输入时不得描述画面。
- 主题文档同步：`agent-doc/telegram-agent-flow.md`（插件 scope 字段、工具图片通道、`execute` 透传、`web_fetch` 图片路径与 `referer`）、`agent-doc/architecture.md`、`agent-doc/verification.md`。
- 用户文档：`apps/docs/content/docs/guides/extensions.md`；产品知识索引 `src/platform/prompts/2-product-knowledge.md` 的 `web_fetch` 条目也一并更新。

## 验证

失效模式清单（先列再写测试）：Markdown 丢图或保留相对链接、`data:` 吃预算、图片被当二进制拒绝、超大响应、声明为图片的 HTML、不支持的格式、`referer` 非法/带 fragment/跳转后丢失、像素进入 history 或审计、`execute` 吞图或标记漏进封套文本、图片存到别的 Chat、没有存储时的行为。

```bash
pnpm exec vitest run test/web-fetch.test.ts
# 拆分前：16 passed
pnpm exec vitest run test/agent/runtime-web-fetch-image.test.ts
# 1 passed：真实 Invocation 里模型经 execute 读网页 → 按图片链接带 referer 取图；
# provider 请求里该结果为 [封套, 标签, image]；context_messages 只有 toolImages 引用；
# page_call / image_call 及其 :web_fetch 内层审计行齐全，带图的两行有 result_content_json
# 变异检查：把 capabilityImages 换成空数组，上述用例失败（expected ['text'] to equal ['text','text','image']），已还原
pnpm test
# 386 files passed, 1 failed, 1 skipped；1912 tests passed, 1 failed, 8 skipped（1320s）
# 失败：test/recurring-alarms/schedule.test.ts「croner is imported only by the local-monolith schedule engine」，
#       断言期望 adapters/local-monolith/recurring-schedule.ts，实际是 Windows 反斜杠路径；与本次改动无关
pnpm run lint                                        # 退出码 0
pnpm run check                                       # 退出码 0
git diff --check                                     # 退出码 0
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 52 HTML/Markdown pages ... (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 52 HTML/Markdown pages ... (base /surowan/)
git status --porcelain                               # 构建后只有本次改动
```

`docs:verify` 第一次失败：手册里用行内代码写的 `![说明](链接)` 被当成真实链接检查。改成文字描述后两种 base 都通过。

拆文件后重跑 `pnpm run lint`、`pnpm run check`，以及受影响的 12 个测试文件（`test/web-fetch`、`agent/runtime-web-fetch-image`、`agent/runtime-member-profile`、`mcp/images`、`skills`、`plugins`、`system-resources`、`playground/image`、`replay/tools-guards`、`file-token-limit`），53 个用例全部通过。提交时 pre-commit 单文件 token 上限检查通过。

未执行：

- 真实 Telegram 里用真实网站和多模态模型验收；
- 防盗链站点的实际 `referer` 效果；
- 纯文本主模型下的说明文本，这是既有的 `loadToolImages` 行为，本次没有新增用例。

## 提交

```txt
144bafa6 Let web_fetch view images linked from pages
```
