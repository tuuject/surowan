# 文件系统

塑料碗需要一个手段，来管理它接收、处理、发送的文件。

## 为什么要做

要让塑料碗能够处理外部世界的信息，文件必不可少。

一般而言，通用 Agent 都会提供 bash 和 read 两种 tool 来让 Agent 访问电脑上的各种文件。但是，因为塑料碗要面对的不可信输入来自若干群友，所以塑料碗从 day 1 就选择了不提供 bash tool。但这会带来一些麻烦：

- 塑料碗有时需要阅读群友发来的文件，这不仅限于图片，还包括 PDF、GIF、MP4、DOCX……等等。
- 我不打算直接集成文件读取功能，我打算让用户自己接入 MCP Server 去解决文件解析的问题。但问题来了，目前塑料碗并没有基础设施，可以让 MCP Server 能够读取文件。
- 此外，我在计划给塑料碗开发「通过 ACP 协议委派任务给外部 Agent」的功能，为此也需要一个机制来传输参考资料、交付 Artifact。

## 希望实现什么

我希望实现一套文件管理系统，能够实现：

- 不让 LLM 直接看到和操作用户电脑上的任意文件
- 对 LLM 暴露安全引用标识，对 MCP Server 暴露真实文件路径
- 在管理面板展示文件列表、允许按照群组和时间进行过滤、下载、删除

## 打算怎么做

引入虚拟文件路径，让 LLM 使用类似真实文件系统的绝对路径来引用文件，例如：`/fakepath/telegram_12345678/23456578_foo.pdf`。这个路径并不对应用户电脑上的真实路径。

当 LLM 调用 MCP 工具时，由塑料碗 Harness 层将虚拟路径解析为实际文件路径，并在确认访问权限后传递给 MCP Server。这样既能兼容一些 MCP Server 对文件路径参数的要求，也不需要让 LLM 知道文件的真实存储位置。

### 虚拟路径是 key，不是路径

- 虚拟路径只是长得像绝对路径的固定 key，Harness 不会把它当普通文件路径处理（不做拼接、规范化、`..` 解析）。
- 同一个文件的 key 固定不变，保留在 Context 历史里的引用不会因为重新铸造而失效或打乱 prefix cache。
- key 统一使用 POSIX 风格，与宿主无关：塑料碗跑在 Windows 裸机、Linux 还是 Docker 里，LLM 看到的都是同一套 key，也不需要关心。真实路径的平台差异只在 Harness 把 key 解析成真实路径时处理。
- key 的结构（如带 chat ID）不承担安全职责，授权只看 Harness 的发放记录。

### 只接受发给本 Conversation 的 key

- LLM 只能传 Harness 提供过的虚拟路径；没发放过的 key 直接拦截。
- 严格按当前 Conversation 判定，不按全局判定。key 的结构可以猜，群 B 的模型照格式写出群 A 的 key 时必须解析失败。这与现有 `context_refs` 的规则一致，引用只在自己的 Conversation Context 内解析。

### Harness 必须知道哪些参数是路径

只拦截「没发过的虚拟路径」还不够：`/etc/passwd`、`C:\Users\...\.ssh\id_rsa` 这类真实路径不以虚拟路径前缀开头，Harness 查不到对应 key，会被原样透传给 MCP Server（目前 MCP 参数就是校验 schema 后原样透传）。因此：

- 在 MCP `tool_policies` 中显式声明路径参数（如 `path_params`）。声明过的字段只接受本 Conversation 发放过的 key，其它任何值（真实路径、伪造 key、相对路径）一律拒绝，并记入审计。
  - 路径参数可能位于数组或对象内（如 `files[].path`），只写顶层字段名不够，声明需要能定位嵌套位置（类似 JSON Pointer，支持数组通配）。
  - MCP Server 升级后，已声明的路径参数可能消失或改名。此时 fail closed：停止暴露该 Tool 并使用警告系统发送一次性警告，不悄悄退化成「不做路径校验」。可以借现有 `registry_hash` 检测 schema 变化。
  - 有的字段既接受路径也接受 URL（如 anymd 的 `read.source`）。声明为路径字段后同样只接受 key，URL 一律拒绝：这与「现阶段不做从任意 URL 下载」的边界一致，也避免 MCP Server 绕过 `web_fetch` 的 SSRF 防护去抓内网地址。
- 只做整串匹配；虚拟路径出现在未声明字段里，或作为子串嵌在其它文本中时，拒绝而不是替换。
- 不采用「扫描所有字符串、像绝对路径就拦」的启发式：误伤多，也挡不住 `~`、`../`、UNC 路径等变体。
- stdio MCP Server 的 `cwd` 强制设为一个由 Harness 管理的空白目录。路径校验只能检查调用里出现的字段，省略字段时 MCP Server 会退回自己的默认值：例如 anymd 的 `search` 不传 `sources` 时递归搜索当前工作目录，而目前 stdio MCP 继承塑料碗进程的 cwd（仓库目录或 Docker 里的应用目录）。空白 cwd 让这类默认值落空。
- 纵深防御：MCP Server 自身也应配置为只能读取 Harness 提供的目录，漏声明路径参数时也读不到外部文件。

### MCP 配置页（阶段一）

在 Web Admin 增加 MCP 配置页。阶段一基本只读，前端预留可编辑能力，供以后接上 MCP Server 的增删改。

- 审计：列出每个 MCP Server 的连接状态，以及它暴露给模型的 Tool、description 与原始 `inputSchema`。数据来自 `McpManager` 内存中的 Tool 定义与 `mcp_server_state`，用只读审计 API 提供。
- description 与 schema 来自 MCP Server，属于不可信数据：页面按纯文本渲染，不走允许 HTML 的 Markdown 渲染。
- 路径字段声明：基于 Tool schema 展示字段树，让用户勾选哪些字段是文件路径。这是阶段一唯一的写操作：
  - 页面只是编辑器，结果写回 `config.jsonc` 的 `path_params`（沿用现有 `ConfigEdit` 写回契约），配置文件仍是唯一的事实来源。
  - 保存端点需要进入 Admin 写端点白名单并校验 `Origin`。
  - `mcp.servers` 不在热更新白名单内，阶段一保存后提示需要重启才生效；MCP Server 的热重启另行设计。

### AI 一键声明路径字段

借助现有的 tool model（系统级辅助模型，辞典融合已在使用），提供「一键声明路径字段」按钮，由 AI 分析 Tool schema 与 description，给出路径字段建议。

- 只有用户主动点击才运行，默认不自动帮用户做决定。
- AI 的结果只填进表单，不直接保存；用户确认后再点保存。
- 输出按 Tool schema 校验，只接受 schema 中真实存在的字段位置。
- 输入的 schema 与 description 同样可能带注入，可能诱导模型漏标字段。漏标是危险方向（路径会被原样透传），多标只会误拦。因此 UI 把 AI 新增或取消的标注做成可逐条确认的 diff，不提供不看内容的「全部应用」。
- 这次 tool model 调用的审计方式与辞典融合保持一致。

### 交给 MCP 的是副本

解析后不直接交出存储中的原件，而是每次调用物化到一个临时 staging 目录（只读权限，调用结束后清理）。MCP Server 改不了原件，也看不到 `data_dir` 的布局。

### MCP 结果中的路径

MCP Server 返回的真实路径要翻译回虚拟路径，但只认 Harness 自己知道的路径。

- 优先使用 MCP 协议自带的结构（`image`、带 blob 的 `resource`、`resource_link`），Harness 拿到内容后入库、发放 key，再交给模型。目前 MCP 结果整体 `JSON.stringify` 后截断，这类内容块实际不可用，需要一起改。
- 回显的输入路径：MCP Server 常把收到的路径原样写进结果（如 anymd `read` 的 front matter `source:`、`search` 按文件分组的标题）。Harness 把这些 staging 路径映射回对应的 key，而不是打码，模型才能分辨哪条结果来自哪个文件。
- 产出根目录：每个 Server 可以声明一个产出根目录（如 anymd 把 `read` 导出的内嵌图片写到 `$ANYMD_CACHE_DIR/images/`，这是 Server 启动时决定的全局目录，无法按调用指定）。
  - 只收录**本次调用结果中引用到**的、位于产出根目录下的文件，不扫描整个目录：产出根目录跨 Conversation 共享，整目录收录会把别的 Conversation 的产物带进来。
  - 收录前检查大小、按内容识别类型、`realpath` 确认未逃出根目录、拒绝 symlink；收录后入库并向当前 Conversation 发放 key。
- 替换一次完成：用全部「真实路径 → key」映射构造一个正则交替式（逐项转义，按长度从长到短排列，避免短路径先匹配长路径的前缀），配合回调函数做一次 `replace`。不对每个映射依次调用 `String.prototype.replace`，否则前一次替换出的文本可能被后一次再次匹配，导致结果错乱。
  - 替换在结构化结果的字符串字段上进行，在 `JSON.stringify` 之前完成；否则路径在 JSON 中被转义（如 Windows 的 `\` 变成 `\\`），与映射对不上。
- 映射之外的路径不做处理：包括意外漏出的 staging 路径（形如随机字符组成的临时目录，不含有价值的信息）和其它任意路径。它们保留原文，模型拿到也无法解析成 key，没有授权意义。

## 还有什么没想清楚

### Docker 下如何配置产出根目录

产出根目录是 MCP Server 进程看到的路径。裸机部署时管理员容易理解；在 Docker 里，管理员需要分清容器内路径与宿主机路径，容易配错。

一个可能的方向：路径不由管理员填写，而由 Harness 分配（如 `<data_dir>` 下按 Server alias 划分的目录），管理员只声明「怎么把这个目录告诉 Server」，例如指定环境变量名（anymd 是 `ANYMD_CACHE_DIR`），或在 `command` 中使用占位符。stdio MCP Server 是塑料碗的子进程，与塑料碗处在同一个文件系统命名空间里，Harness 分配的路径对两边一致，管理员不需要理解容器内外的路径映射。`cwd` 的空白目录也可以用同一套方式分配。

### key 授权的生命周期

key 固定后，它的授权是否跟随 Context TTL 与 GC 驱逐失效（现有 `context_refs` 的规则），还是按 Conversation 归属长期有效（类似 `image_generation_id`）？群友发来的文件适合前者；ACP 交付的 Artifact 可能需要活得更久。

### MCP Server 热重启

阶段一 `path_params` 重启生效。以后支持 MCP 配置热更新时，核心问题是 Invocation 尚未结束时如何优雅处理：

- 正在进行的 MCP 调用与本次 Invocation 已拿到的 Tool 定义，按旧配置跑完还是中断。
- Server 增删、command/url/env 变化时的连接替换，以及 `required` Server 失败的语义。
- 只改 Tool 策略（`tool_policies`、`path_params`）时不必重启连接：Tool 在每次 Invocation 构建时取一次，执行时用的是当时的定义，整体替换定义即可保证同一次调用不出现半新半旧的校验。

### Streamable HTTP MCP

真实路径只对同机（且同一文件系统命名空间）的 stdio MCP Server 有意义，远端 HTTP MCP Server 拿到路径也读不到。需要另一条通道，例如 embedded resource 直接带内容，或短时签名 URL。

### 前置工作

- 目前入库只记录照片、图片类 document 和 Sticker，PDF、DOCX、MP4、GIF、语音都没有进库；媒体只存 `file_id`，用时下载到临时目录、用完即删，没有持久化文件存储。
- Bot API `getFile` 有 20 MB 上限。
- `send` 目前只能发 Sticker、照片和生成图，交付 Artifact 还需要发送文件的能力。
- 管理面板的删除属于写端点，需要进入 Admin 写端点白名单，删除时同时让对应 key 失效。

## 边界

- 现阶段不做让塑料碗从任意 URL 下载并保存文件以便后续处理的功能。对于涉及到这种操作的场景，会考虑在未来允许用户（Bot 管理员）通过「外部 Agent 委派」间接实现。
- 对于管理员选择配置高危 MCP Server（例如 bash、filesystem），这属于管理员自己的责任，塑料碗 Harness 不会负责。
