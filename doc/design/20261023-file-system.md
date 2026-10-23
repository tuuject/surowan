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
- 「提供过」按当前 Conversation 判定，不按全局判定：key 的结构可以猜，群 B 的模型照格式写出群 A 的 key 时必须解析失败。与现有 `context_refs` 的规则一致——引用只在自己的 Conversation Context 内解析。

### Harness 必须知道哪些参数是路径

只拦截「没发过的虚拟路径」还不够：`/etc/passwd`、`C:\Users\...\.ssh\id_rsa` 这类真实路径不以虚拟路径前缀开头，Harness 查不到对应 key，会被原样透传给 MCP Server（目前 MCP 参数就是校验 schema 后原样透传）。因此：

- 在 MCP `tool_policies` 中显式声明路径参数（如 `path_params`）。声明过的字段只接受本 Conversation 发放过的 key，其它任何值（真实路径、伪造 key、相对路径）一律拒绝，并记入审计。
- 只做整串匹配；虚拟路径出现在未声明字段里，或作为子串嵌在其它文本中时，拒绝而不是替换。
- 不采用「扫描所有字符串、像绝对路径就拦」的启发式：误伤多，也挡不住 `~`、`../`、UNC 路径等变体。
- 纵深防御：MCP Server 自身也应配置为只能读取 Harness 提供的目录，漏声明路径参数时也读不到外部文件。

### 交给 MCP 的是副本

解析后不直接交出存储中的原件，而是每次调用物化到一个临时 staging 目录（只读权限，调用结束后清理）。MCP Server 改不了原件，也看不到 `data_dir` 的布局。

## 还有什么没想清楚

### MCP 返回的文件路径

MCP Server 如果返回了一个文件路径，我有责任将其翻译回虚拟文件路径吗？我要怎么做？

目前倾向：要翻译，但只认 Harness 给出的出口。

- 优先使用 MCP 协议自带的结构（`image`、带 blob 的 `resource`、`resource_link`），Harness 拿到内容后入库、发放 key，再交给模型。目前 MCP 结果整体 `JSON.stringify` 后截断，这类内容块实际不可用，需要一起改。
- 兼容只会返回路径的 MCP Server：每次调用提供一个 output 目录，调用结束后只收录该目录下的文件（检查大小、按内容识别类型、`realpath` 确认未逃出目录、拒绝 symlink），收录后替换成虚拟路径。
- 结果中出现的其它真实路径：位于 `data_dir` 或 staging 目录下的打码；其它的保留原文，模型拿到也无法解析成 key，没有授权意义。

### key 授权的生命周期

key 固定后，它的授权是否跟随 Context TTL 与 GC 驱逐失效（现有 `context_refs` 的规则），还是按 Conversation 归属长期有效（类似 `image_generation_id`）？群友发来的文件适合前者；ACP 交付的 Artifact 可能需要活得更久。

### Streamable HTTP MCP

真实路径只对同机（且同一文件系统命名空间）的 stdio MCP Server 有意义，远端 HTTP MCP Server 拿到路径也读不到。需要另一条通道，例如 embedded resource 直接带内容，或短时签名 URL。

### 前置工作

- 目前入库只记录照片、图片类 document 和 Sticker，PDF、DOCX、MP4、GIF、语音都没有进库；媒体只存 `file_id`，用时下载到临时目录、用完即删，没有持久化文件存储。
- Bot API `getFile` 有 20 MB 上限。
- `send` 目前只能发 Sticker、照片和生成图，交付 Artifact 还需要发送文件的能力。
- 管理面板的删除属于写端点，需要进入 Admin 写端点白名单，删除时同时让对应 key 失效。
