# 塑料碗原生多模态文件输入调研

核查日期：2026-11-07。源码基线：`72c5625e714795d44ee86c6f5b36a92c2d9a1191`。状态：调研完成，架构与官方矩阵已独立复核；实施建议待产品确认。

本报告只提出研究结论和实施建议，不表示产品决策已获确认。本轮不修改运行时代码、配置、依赖或用户 PRD，不调用真实模型、不上传用户文件。官方文档核查不等于目标部署的联调验收。

## 结论与范围

建议先交付有明确端点白名单的原生 PDF 输入，再扩展办公文档、语音和视频。文件原件、授权引用和 Provider 远端句柄是三件不同的东西；保持现有 canonical Conversation Context 为唯一历史事实源，Provider 文件存储仅作可丢弃传输缓存。

决策摘要：

- **首个闭环选 OpenAI Responses，随后 Claude Messages 与 Gemini generateContent。** 这是按本项目集成成本排序，不是模型质量排名；PDF 可直接交给厂商，无需本地 Reader/OCR。
- **四处必须补齐**：PDF 入站与图片分流、原件薄缓存、canonical 附件引用、请求期 wire 转换；同时覆盖审计与 Replay。Pi 1.1.0 不认识文件块，但现有 `onPayload` 可复用，不必先 fork SDK。
- **有效能力取三层交集**：模型理解能力、实际 Provider/端点接收能力、已实现 Adapter；未知组合明确不支持，不自动转图/转码或换模型。
- **当前 Context 内可继续引用，不等于无限期可用。** 保留现有 TTL/GC 安全边界；真正 rebuild 后不保证恢复。文件 ID 省上传，不省后续输入 Token。
- **扩展优先顺序**：办公文件的厂商原生入口、Gemini OGG/Opus 与短 MP4、其他格式。xAI 文件是服务端检索路线，Mistral QnA 是 OCR→LLM；它们都不能简单等同整份 PDF 页面输入。

“Provider-native”需要进一步标注理解方式：

- **页面视觉**：Provider 把 PDF 文本和页面图像交给多模态模型，能处理版式、图表和扫描页。
- **服务端文本提取**：文件由 Provider 接收并抽取文本，但不能承诺保留图表、嵌入图片、工作簿计算或排版。
- **服务端检索/工具**：上传后由 file search、代码沙箱等工具读取；不等同于把整个文件直接放进本次模型上下文。

前两种都可以贯彻“不在 Harness 实现解析器”，但必须分别声明，不能把它们记作同一个 `supports_files: true`。第三种推迟评估，不能作为第一阶段原生 PDF 的默认实现。

调研覆盖用户列出的八组厂商、项目实际 Provider 入口、无状态重送、Context 生命周期、重放、安全和成本。未穷举每个托管平台的全部模型、地域和配额；资料不足的组合明确关闭，不根据模型名或消费端上传按钮推断 API 支持。

## 当前架构及可复用边界

### 已确认的协议与审计约束

项目锁定 Pi AI / Agent Core `1.1.0`，见 [package.json](../../package.json#L35)。项目开放的 API 只有 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`，见 [builtin-providers.ts](../../src/platform/builtin-providers.ts#L11)。Pi 自己提供更多协议，不代表塑料碗已经开放 Bedrock、Vertex 或 Mistral 原生 API。

模型配置的 `input` 目前只允许 `text`、`image`，见 [schema-model.ts](../../src/platform/config/schema-model.ts#L85)。因此新增 PDF 不是修改 Prompt 或补一个 MIME 字符串就能实现。

[run-hooks.ts](../../src/orchestration/agent-runtime/run-hooks.ts#L24) 在每次模型调用前加载工具图片，随后走已有模型注册表的 `streamSimple`；`onPayload` 用于请求审计，`onResponse` 用于响应状态审计。该边界适合复用，但新增文件必须同时覆盖真实请求与审计视图，不能另起一条绕过预算、并发和记录的 SDK 请求链路。

当前 [request-audit.ts](../../src/platform/models/request-audit.ts#L3) 只剥离 `image/*` base64。只读合成样例实验确认：图片载荷被替换；OpenAI `input_file.file_data`、Claude `document.source.data`、Gemini `inlineData` 中的 PDF 数据都未被剥离。这个缺口目前不是 PDF 输入已泄漏的证据，因为该输入尚未实现；它是启用原生文件之前必须补齐的验收项。

当前 [codec.ts](../../src/context/codec.ts#L268) 的估算基于序列化 JSON 长度及工具图片 patch 数。附件只存引用后，引用字符串长度不能代表 PDF 的页面、音频时长或视频帧 Token；base64 长度同样不能作为内容 Token。

### Telegram 附件和图片链路

[入站规范化](../../src/ingress/telegram-ingestion/messages.ts#L305)只为 photo、JPEG/PNG/WebP 图片 document 和 sticker 建立 `media` 行。普通 PDF、其他办公文件、voice/audio/video/animation/video_note 只有 revision kind 和原始 Telegram JSON，没有规范化媒体行、原件缓存或模型文件输入；普通消息通常只显示 `[document]` / `[voice]` 等占位。Rich Message 的 PDF 会显示文件名，但同样不创建媒体行，见 [rich.ts](../../src/platform/telegram-markdown/rich.ts#L270)。

可复用 [media 表](../../src/store/schema/messaging.ts#L90) 的 `kind='document'`、file ID/MIME/大小/原始 Telegram 元数据，以及 [下载器](../../src/capabilities/media/download.ts#L4) 的取消、流式计数和 20 MiB 限制。PDF 本身不要求新增 media kind 或数据库表；音视频独立 kind 才需要对应 schema/迁移。必须把 Telegram 官方的 20 MB 服务限制与代码的 20 MiB 本地保护分别看待，实际取更小者。

**当前没有通用入站原件缓存可直接复用。** 图片下载到临时目录，经 Sharp 旋转/缩放/重编码后删除，见 [image-input.ts](../../src/capabilities/media/image-input.ts#L104)。现有 `media_analyses` 缓存的是视觉描述，不是文件原件。要做到 PDF 后续轮次不重复下载，需要在同一 media 子系统增加一个小型、受 Context 约束的原件缓存；复用下载器和目录管理，而非宣称已有完整附件存储。

当前 [renderInjection](../../src/context/builder/render.ts#L216)把新批次所有非 sticker media 当图片，随后进入 `loadDirectImages`。**只放宽 document 入库过滤会把 PDF 送进 Sharp，可能直接中止 Invocation。** PDF 必须走独立原件路径，不能加入 `isImageDocument`。

图片内联块不会写入 canonical history，见 [codec.ts](../../src/context/codec.ts#L150)。从代码推导，缓存 Agent 的 live transcript 可能继续保留旧内联图片，直到驱逐/GC/恢复时丢失；本轮未抓实际模型请求验证这个差异。新增文件不能依赖这种内存偶然保留，应每次从结构化引用恢复。现有图片流程保留，另以回归测试验证未受影响。

### 模型元数据与 Context 事实

运行时模型元数据来自配置 `providers.<alias>.models[]`，由 [providers.ts](../../src/platform/providers.ts#L244)构造；Pi 目录提供 API/base URL 等预设。Admin/TUI 从 OpenRouter、Vercel、models.dev 等预填后仍须配置确认；[metadata.ts](../../src/platform/models/metadata.ts#L306)和 [models-dev.ts](../../src/platform/models-dev.ts#L201)只提取 text/image，因此上游目录出现 audio/video/file 也不会自动生效。

[Context store](../../src/context/store/index.ts#L25)是唯一写者；[refs](../../src/context/refs.ts#L147)依据 Context、来源 seq、head_seq 和 TTL 授权。默认 ref TTL 为 72 小时；media ref 在有效期内复用但不自动续期，见 [resolve.ts](../../src/platform/config/resolve.ts#L51)、[refs.ts](../../src/context/refs.ts#L67)。GC 同步推进 canonical head、Pi loop、Agent state 与 refs，见 [transcript.ts](../../src/orchestration/agent-runtime/transcript.ts#L157)。

Agent 按 Conversation 缓存，正常 Invocation 可以复用，不是每轮从零重建。缓存丢失时从 canonical history 恢复，见 [run-agent.ts](../../src/orchestration/agent-runtime/run-agent.ts#L150)。模型切换本身不必重建，但模型相关模板内容/图片能力会改变稳定 Prompt，或新窗口不足，会触发真正 reset；新文件能力说明不宜简单写进稳定 Prompt 从而让每次切换都意外清空 Context。

[Invocation snapshot](../../src/store/invocation-snapshot.ts#L105)保存媒体 ID、修订关联和部分元数据，不保存原件字节。Replay 从公开消息快照重新建场景，不恢复生产 canonical history；其 [scene 媒体白名单](../../src/context/scene/index.ts#L130)目前排除 PDF，[Replay 输入](../../src/orchestration/replay/run.ts#L176)只有场景文本，图片按需通过工具读取。扩大生产输入时必须同步扩展 Replay，不能指望原功能自动覆盖。

## 兼容性矩阵

下列“支持”只指官方明确说明的具体模型/端点组合；塑料碗当前对新文件模态的 Adapter 支持仍需实现。文件上传上限、推理请求上限、模型上下文上限必须分别判断。

### PDF：首期候选与应分开的处理方式

| 模型 / Provider 端点 | API 输入与传输 | 限额、理解方式及结论 |
| --- | --- | --- |
| OpenAI GPT 视觉模型，Responses；文档示例 GPT-4.1 / GPT-6 Astra | `input_file`：base64、Files `file_id`、外部 `file_url` | 每文件小于 50 MB，整请求文件合计 50 MB；未公布独立页数上限，仍受上下文限制。文本+每页图像；优先首个闭环 [O1] |
| OpenAI Chat Completions | `file`：base64 / `file_id`；不支持文件 URL | 文件块仅支持 PDF；不支持 Responses 的 PDF `detail`。同样可原生输入，但 Pi 未实现 [O1] |
| Anthropic Claude 原生 Messages；所有当前 active 模型，示例 Opus 5.5 | `document.source`：base64 / URL / Files `file_id` | 第一方请求 128 MB；整请求 PDF 页数 600，**请求上下文小于 1M 时为 100 页**；无密码/加密的标准 PDF。文本+页图，适合 P0 [A1] |
| Google Gemini Developer，generateContent；官方例 Gemini 3.8 Flash | `inlineData` base64 / Files URI 的 `fileData`；具体 URL 来源依入口 | PDF 50 MB、1000 页；多 PDF 仍受总页数和上下文限制。页面视觉+文本，适合 P0；项目当前走 generateContent，不能直接复制新版 Interactions 的 `document` 字段 [G1/G2] |
| xAI Grok，Responses；文档例 Grok 4.7 | `input_file`：公网 URL / 已上传 `file_id` | **自动启用 `attachment_search` 检索**；官方把它描述为服务端文档搜索/agentic workflow，不承诺整份文件直接进入上下文，也不能据此断言全文永远不会进入历史。不是本方案默认的整份 PDF 直接上下文路径。文件管理页 512 MB 与上传参考 50 MB 冲突，接入前确认；未见页数/OCR保证 [X1/X2] |
| DeepSeek；已确认 `deepseek-flash` 图片视觉 | 图片 base64 / URL / Files ID | 未找到 PDF/Office/音视频直接文件理解入口；Files 图片上传不是 PDF 支持。本阶段明确不可用，不引入 PDF 转图 [D1] |
| 阿里百炼 Qwen3.8 Max/Max-0902/Flash/27B，Chat Completions 或 DashScope | `file.file_url` / `file.file_data`，base64 时必须有 filename | 150 MB、256 页；服务端提取文本和图片。北京/新加坡，27B 的 PDF 只在北京。**Responses 返回 200 也不会把 PDF 传给模型**；必须绑定精确协议 [Q1] |
| 智谱 GLM-4.6V/FlashX/Flash，BigModel Chat | `file`：`file_id` / `file_url` / `file_data` 三选一 | 单文件 50 MB，最多 50 个；128K 上下文，未公布独立页数硬上限。可提交 PDF，但页面视觉/扫描页的实际处理细节未充分说明；不能同时理解文件、视频和图像 [Z1/Z2] |
| Mistral Document QnA，Chat；文档例 `mistral-small-latest` | `document_url`：公网 URL / PDF data URL / Files 生成的 signed URL | **Provider OCR→LLM**；QnA/OCR 的 FAQ 都列 50 MB、1000 页，但不代表全文必然装入模型窗口。符合“无需本地解析”，但应作为明确的 Provider 辅助处理选项后置 [M1/M2] |

来源：[O1 OpenAI 文件输入](https://developers.openai.com/api/docs/guides/file-inputs)；[A1 Claude PDF](https://docs.anthropic.com/en/docs/build-with-claude/pdf-support)；[G1 Gemini 文档理解](https://aistudio.google.com/docs/document-processing)、[G2 generateContent 文件输入](https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods)；[X1 Grok 文件对话](https://docs.x.ai/developers/model-capabilities/files/chat-with-files)、[X2 上传 API](https://docs.x.ai/developers/rest-api-reference/files/upload)；[D1 DeepSeek Vision](https://api-docs.deepseek.com/guides/vision)；[Q1 百炼 PDF](https://help.aliyun.com/zh/model-studio/pdf-understanding)；[Z1 GLM-4.6V](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v)、[Z2 BigModel Chat](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)；[M1 Mistral QnA](https://docs.mistral.ai/studio/document-processing/document_qna)、[M2 OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)。

GLM 中国站的字段与限额不能自动用于 `zai` 国际 alias：[Z.ai 模型页](https://docs.z.ai/guides/vlm/glm-4.6v)确认 File 模态，[国际 API 页](https://docs.z.ai/api-reference/llm/chat-completion)也声明多模态，但本轮取得的可读 schema 主要展开文本模型，未独立确认国际文件块全部字段、配额与 Coding Plan 行为。应保持“待该端点验收”，而非照搬中国站。

Google 的 [新版默认指南](https://aistudio.google.com/docs/file-input-methods)主要展示 Interactions；本轮另读取了 generateContent 版本，确认 `inlineData(application/pdf)` 示例仍存在。Vertex / Gemini Enterprise Agent Platform 的 [文档理解指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/document-understanding)按模型、GCS/inline/URL 给另一套限制和 Token 口径；它不使用 Developer Files 的 48 小时生命周期，也不在项目当前四协议之内，不把其更大配额并入本表。

### 办公文档与结构化文件

| 端点 / 模型族 | DOCX / PPTX / XLSX、JSON / CSV | 覆盖限制 |
| --- | --- | --- |
| OpenAI Responses [O1] | DOCX/PPTX 提取文本；XLSX/CSV/TSV 表格增强；JSON 等代码/文本格式也可 `input_file` | 非 PDF 不提取嵌入图片/图表；表格每 sheet 最多前 1000 行，另加摘要/表头元数据，不能承诺全表分析 |
| Claude Messages / Files | `document` 支持 PDF 和纯文本；CSV/MD 可按 `text/plain`；DOCX/XLSX 不属于直接 document 输入 | code execution 的 `container_upload` 是另一种工具路径；PPTX 直读未确认。本期不启用托管沙箱来扩充支持 [A2] |
| Gemini Developer | DOCX/PPTX 全文+嵌入图片但不渲染页面；XLSX/XLS **只读第一张 sheet**并转 CSV；JSON/CSV 以文本语义理解 | 版式/图表及公式可能丢失。新版 Office 能力与具体模型/协议需验证；当前 generateContent 与 Interactions 的字段不同 [G1/G3] |
| Qwen-Long | Files `purpose=file-extract` → `fileid://`，DOCX/PDF/文本等；150 MB，最多 100 个文件引用/请求 | 文本抽取路径；文件上传格式表与错误码关于图片/扫描件存在冲突，不声明扫描 PDF 页面视觉或完整 Excel；文件无当前明确到期，调用仍计文件 Token [Q2] |
| GLM-4.6V（中国站） | `file_url` 文档列 `pdf/txt/word/jsonl/xlsx/pptx` | 单文件 50 MB；`word` 的各扩展名/MIME、嵌入图/公式保真需端点测试；不能与图像/视频混用 [Z1/Z2] |
| Mistral | 独立 OCR 明确列 DOC/DOCX、PPT/PPTX、XLSX/CSV 等；Responses preview 另有 `input_file` | 不把 OCR 的全格式列表自动视作 Chat QnA 的全格式承诺；OCR/Responses 和 Pi 内置 `mistral-conversations` 是不同入口 [M2/M3] |
| Grok | 直接附件明确 PDF/文本/代码/CSV/JSON；办公 MIME 出现在 Collections | Collections 是持久检索，排除首期；Office 直接附件未确认 [X1/X3] |
| DeepSeek | 未确认 Office/结构化文件的原生文件入口 | JSON/CSV 作为普通文本并不证明附件接口支持；本阶段不增加本地读取转换 |

补充来源：[A2 Claude Files](https://docs.anthropic.com/en/docs/build-with-claude/files)；[G3 Gemini 更新记录](https://aistudio.google.com/docs/changelog)；[Q2 Qwen-Long](https://help.aliyun.com/zh/model-studio/long-context-qwen-long)、[错误码](https://help.aliyun.com/zh/model-studio/error-code)；[M3 Mistral Responses](https://docs.mistral.ai/inference/conversations/responses)；[X3 Grok Collections](https://docs.x.ai/developers/tools/collections-search)。

OpenAI 对完整表格计算建议 Hosted Shell，对大文件检索建议 File Search，对保留 Office 图表建议先转 PDF；这不是直接文件入口覆盖全部内容的证据。本方案不默认启用 Hosted Shell（现有模型工具边界不提供任意执行）、不引入 RAG，也不自动部署 Office→PDF 转换器。若需要这些行为，应另行授权设计，而不是偷偷绕过前1000行等限制。

Mistral OCR 的格式 FAQ 是折叠内容，普通网页正文抓取未展开。独立复核一度认为 XLSX/CSV 只属于 Search Toolkit extractor；主核查随后在同页原始响应的 FAQ 数据中确认了 `Excel (.xlsx, .csv)`、Word/PowerPoint 行以及明确的“50 MB or less / 1,000 pages or fewer”。因此保留上表的 **OCR** 格式声明，但仍不据此保证 Chat QnA 全格式支持；该例也说明不能把未展开的页面当作不支持的证据。

### 音频、视频与动画

| 端点 / 模型 | 音频 / Telegram voice | 视频 / GIF / 动态贴纸 |
| --- | --- | --- |
| OpenAI GPT 音频模型，Chat | `input_audio` base64，明确 WAV/MP3；独立转写限 25 MB，列 mp3/mp4/mpeg/mpga/m4a/wav/webm，未列 OGG。不能把 ChatGPT 的 OGG 上传能力套到 API | 未找到通用 GPT 原生视频文件理解入口；图像支持 non-animated GIF。抽帧不属于首期 [O2/O3] |
| Claude Messages | 未提供原生音频 content block | 未提供原生视频块；GIF 只取首帧，不能用于动态理解 [A3] |
| Gemini Developer；如 3.8 Flash | inline / Files URI，列 OGG、Opus；音频页称最长 9.5 小时、32 Token/s | MP4/WebM 等，静态模式默认 1 FPS；音轨同时处理。1M 上下文约 3h low / 1h high；格式列表不含 GIF 图片。支持 WebM 不保证所有 Telegram VP9 贴纸编码都兼容 [G4/G5] |
| Qwen-ASR / Qwen-Omni / Qwen-VL | 短 ASR `qwen3-asr-flash` URL/base64，≤5min/10 MB，明确 OGG/Opus；异步 filetrans 仅公网 URL，≤12h/2 GB。Omni 能听音频，但其格式表未明确 OGG/Opus | VL/Omni 有 `video_url` 等入口；Qwen3.8/3.5 系列可到 2h，Qwen3-VL-Plus 1h，URL≤2 GB、base64<10 MB，型号分别判断。VL **不听视频音轨**，Omni 可以；TGS 未支持 [Q3/Q4/Q5] |
| GLM-ASR-2512 / GLM-4.6V | 独立转写仅明确 WAV/MP3，≤25 MB/30s；OGG 暂不支持声明 | 4.6V `video_url` ≤200 MB，MP4/MKV/MOV；音轨能力未明确。4V-Plus 的模型页“2h”与 API “30s/20 MB”冲突，不能混成一个上限 [Z2/Z3] |
| Grok | 独立 `/v1/stt` 支持 OGG/Opus，最大 500 MB；不是 Responses 的音频上下文 | 未确认上传 Telegram 视频进入 chat/Responses 的入口；Imagine 编辑、扩展及 X Search 看 X 帖子视频均不能充当此证据 [X4] |
| Mistral Voxtral | chat `input_audio` + `voxtral-small-latest` 可做音频问答，但格式/限额表不完整；独立转写明确 Telegram OGG/Opus，≤60min/500 MB | 未确认对话视频输入；Vision GIF 限单帧。先支持明确格式，不引入通用转码 [M4/M5] |
| DeepSeek | 未确认音频入口 | 未确认视频入口；图片支持 GIF，但官方未交代动画帧语义 [D1] |

来源：[O2 OpenAI audio chat](https://developers.openai.com/api/docs/guides/audio-chat-completions)、[O3 转写](https://developers.openai.com/api/docs/guides/speech-to-text)；[A3 Claude Vision](https://docs.anthropic.com/en/docs/build-with-claude/vision)；[G4 Gemini audio](https://aistudio.google.com/docs/audio)、[G5 video](https://aistudio.google.com/docs/video-understanding)；[Q3 Qwen ASR](https://help.aliyun.com/zh/model-studio/asr-model)、[Q4 Omni](https://help.aliyun.com/zh/model-studio/qwen-omni)、[Q5 VL](https://help.aliyun.com/zh/model-studio/vision)；[Z3 GLM ASR](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr-2512)；[X4 Grok STT](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)；[M4 Voxtral chat](https://docs.mistral.ai/studio/audio/audio-in-chat)、[M5 转写](https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files)、[Telegram 示例](https://docs.mistral.ai/studio/agents/examples/majordome)。

媒体上限通常依模型窗口变化；这里记录文档中给出的条件值，不把“9.5 小时”“2 小时”当所有模型都接受的配置。Telegram voice 也并非永远都是 OGG，应按实际 MIME、容器与 codec 校验。Gemini 音频指南 32 Token/s 与 media-resolution 页 25 Token/s 存在口径差异，不能设置跨模型统一常量；最终看具体模型、采样模式和 usage。

### 重用、TTL 和成本

| Provider 文件机制 | 生命周期 / 上传限制 | 影响 |
| --- | --- | --- |
| OpenAI Files | 上传单文件 512 MB；普通文件默认保留至删除，可设 1h–30d 到期；作为输入仍受 50 MB 限制 | PDF 文本+页图计输入 Token；`file_id` 只省上传。Responses 链接历史也仍计历史输入费用 [O4/O5] |
| Claude Files | 单文件 500 MB；保留至删除或到期，可设 1h–90d；当前文档已非 beta，无需旧 beta header | PDF 无额外 PDF 费，文本约 1500–3000 Token/页，另计页图；工作区共享文件，必须自行做用户/Conversation 授权 [A1/A2] |
| Gemini Files | 单文件 2 GB、项目 20 GB，48h 到期；PDF 自身仍 50 MB / 1000页 | 文件 URI 失效可在仍有授权时从本地重传；上传免费不等于输入免费。PDF 指南给 258 Token/页，Gemini 3 提取的原生文本另有不收费说明；不要套用 Vertex 的计数 [G1/G6] |
| Qwen PDF / Long | PDF URL/base64 每次提交；Long 文件当前无到期限制 | PDF 除模型 Token 另收北京 0.02元/页、新加坡 0.024元/页，需 `include_tool_usage` 取得页数；Long 每次重新计引用文件 Token [Q1/Q2] |
| GLM Files | 文件 TTL 本轮未确认 | 保守按账号隔离、调用显式带引用；不承诺永久有效或免费解析 [Z2] |
| Grok Files | 默认保留到删除，可设 1h–30d；上限文档存在冲突 | 附件搜索按工具调用加 Token，另有文件存储费用；不能用普通 Token 单价算出完整成本 [X1/X5] |
| Mistral Files | 上传 512 MB、保留 30d；signed URL 默认 24h，可设 1–168h | 文档输入仍按 OCR/上下文限额。OCR 有页费，QnA 不能假定重复引用后不再处理 [M6/M7] |

来源：[O4 OpenAI Files](https://developers.openai.com/api/reference/resources/files/methods/create)、[O5 会话状态](https://developers.openai.com/api/docs/guides/conversation-state)；[G6 Gemini Files](https://aistudio.google.com/docs/files)；[X5 Grok 文件管理](https://docs.x.ai/developers/files/managing-files)、[价格](https://docs.x.ai/developers/pricing)；[M6 Mistral Files](https://docs.mistral.ai/api/endpoint/files)、[M7 价格](https://docs.mistral.ai/inference/pricing)。

除文件缓存，还需区分各厂商的 prompt/context cache。它们依赖模型、前缀、TTL 和配置，且缓存内容仍占上下文。本轮未验证真实命中率，因此不预报节省比例。Google Interactions 的隐式缓存与 generateContent 的显式 cached content 不能混用，见 [Gemini caching](https://aistudio.google.com/docs/caching)。

两个直接影响 PDF 预算的细节：

- OpenAI Responses 的 PDF `detail` 默认 `auto`，GPT-5.6 及之后等价 `high`，之前等价 `low`；只影响页图，提取文本仍在。首期建议显式采用 `low` 作为成本可预测的初值，允许管理员按图表/小字需求选 `high`，并把选择写入调用审计；不能依赖升级后会改变的 `auto` 语义。见 [O1](https://developers.openai.com/api/docs/guides/file-inputs)。
- Gemini 文档处理页给 258 Token/页，但 [media-resolution](https://aistudio.google.com/docs/media-resolution)对 Gemini 3/4 给出 PDF low/medium/high 为 280/560/1120 + native text，默认 unspecified 为 560。音视频页与该表也存在 32/25 Token/s 等差异。**258 不是 Gemini 全型号的固定预算常量**，应依型号、分辨率和实报 usage 计算；资料不一致时保守准入，不作精确成本承诺。

### 聚合平台与不同部署渠道

| 渠道 | 文件入口与理解方式 | 对塑料碗的意义 |
| --- | --- | --- |
| OpenRouter | Responses 的 `input_file`，或 Chat Completions 的 `file`；PDF URL / base64 data URL。支持原生转发，也可自动 OCR | 必须明确选择 `file-parser.pdf.engine = native`，并约束下游路由；默认模式会在原生不可用时选 Mistral OCR，不能当作“仅原生” |
| Vercel AI Gateway | Chat 的 `file`、Messages 的 `document`、Responses 的 `input_file`；官方提供内联 PDF 示例 | 按所选模型和实际 Provider 判断；其文档明确要求不支持的办公格式先提取文本，本阶段直接报告不支持 |
| Azure OpenAI | Responses 支持 PDF；部署、地域和 API 版本仍有限制 | 不套用 OpenAI 全部 Files 语义：官方说明 `user_data` 上传 purpose 尚不支持。项目未开放独立 Azure Adapter；兼容端点仍需单独验证 |
| Bedrock Converse | `document` 支持 PDF、CSV、DOC/DOCX、XLS/XLSX、HTML/TXT/MD；source 为 bytes 或受支持的 S3 引用 | 这是不同协议和认证通道；不在本项目四种 API 中，不纳入首期，仅作厂商渠道差异证据 |

来源：[OpenRouter PDF](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)、[Vercel 文件输入](https://vercel.com/docs/ai-gateway/inputs-and-tools/file-input)、[Azure Responses](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)、[Bedrock DocumentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html)、[DocumentSource](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentSource.html)。

OpenRouter 有两项容易混淆的区别：

- [Files API](https://openrouter.ai/docs/guides/features/files-api) 的 workspace 文件可达 100 MiB、总量 10 GiB、不自动到期，但文档把上传文件消费限定为 sandbox；DOCX/XLSX/PPTX/OGG 能上传，不是普通聊天能直接理解这些文件的证据。该 API 是 beta，且只在 global endpoint 可用。Provider-hosted files 的 BYOK 路径另行判断。
- [音频](https://openrouter.ai/docs/guides/overview/multimodal/audio)中 Responses 只列 `wav` / `mp3`，Chat 则允许下游支持的 format；[视频](https://openrouter.ai/docs/guides/overview/multimodal/videos)支持 URL / data URL，但 URL 来源受下游限制，Messages API 不支持视频。不能把一种协议的字段照搬到另一种。

### 项目其他已支持 Provider 的补充覆盖

对锁定依赖实际运行目录过滤，本轮得到 31 个可由配置接入的 builtin Provider，其中 28 个可作为单协议新增预设。OpenRouter、Fireworks、GitHub Copilot 是混合协议目录。此数字只描述注册能力，不证明账号有权限或文件输入已经实现。

| Provider / 现有 alias 族 | 官方文件或多模态证据 | 接入结论 |
| --- | --- | --- |
| Moonshot Kimi / `moonshotai{-cn}` | [Files](https://platform.kimi.ai/docs/api/files-upload) 的 `file-extract` 接 PDF/DOCX/PPTX/XLSX 后取回文本；[Chat Vision](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)可用 base64/`ms://` 视频 | PDF 是服务端抽取后二次注入文本，不是页面视觉；官方禁止直接把 PDF base64/file ID 当聊天文件块。Chat 视频能力不自动适用于 Responses/Messages |
| `kimi-coding` | [Code 模型表](https://www.kimi.com/code/docs/en/kimi-code/models.html)列部分型号 image/video | 订阅端点独立；未确认继承开放平台 Files/API 配额，PDF 暂关 |
| MiniMax / `minimax{-cn}` | [Chat 兼容 API](https://platform.minimax.io/docs/api-reference/text-openai-api)的 M3/M3.1 支持图片/视频 URL、base64、`mm_file://`；[独立 STT](https://platform.minimax.io/docs/api-reference/speech-to-text)列 OGG、500s/50 MB | 未确认 PDF；聊天音频不支持，STT 不作为“主模型听音频”声明；国内/国际单独验收 |
| Groq | [Whisper STT](https://console.groq.com/docs/speech-to-text)接受 OGG，图片走 vision Chat | 未确认 Chat 原生 PDF/音频/视频；独立转写可后置 |
| Fireworks | [Document Inlining](https://docs.fireworks.ai/firesearch/inline-multimodal)已下线；[audio/video](https://docs.fireworks.ai/guides/video-audio-inputs)有模型/部署专用入口，OGG 示例 | PDF/DOCX 不在当前原生链路；Qwen3 Omni dedicated 音频与 GLM 5.3 Flash/Qwen3 Omni 视频分别判断 |
| Together | [视频输入](https://docs.together.ai/docs/inference/vision/inputs)仅部分 dedicated endpoint；[独立 ASR](https://docs.together.ai/docs/inference/transcription/overview)列 OGG | 未确认 PDF；不能把 dedicated、多模态 Chat 与 Responses/Messages 文本兼容混为一项 |
| NVIDIA | [NIM 多模态](https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/multimodal-input.html)列 `audio_url/input_audio/video_url`，依赖模型/容器 | 自托管 NIM 文档不等于内置 hosted `nvidia` 全部支持；PDF/OGG 未确认，按部署关闭默认能力 |
| HuggingFace | [Inference Providers Chat](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion)有 VLM 图像，ASR 是独立 task | 路由 Provider/模型决定能力；未确认通用 PDF/Office/视频文件块 |
| Ant Ling / `ant-ling` | [多模态指南](https://developer.ant-ling.com/en/docs/tutorials/multimodal-understanding/)：Ling3.2/3.0-VL 视频，Ming3.0-audio-flash 音频；音频只明确 MP3/WAV | 视频仅 base64，Anthropic 路径支持范围不同；PDF/OGG 未确认 |
| Xiaomi MiMo / `xiaomi`、三个区域 token-plan alias | [音频](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding)明确 OGG；Chat/Responses 有音视频入口 | PDF 未确认；[Token Plan](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)和 Anthropic 兼容路径不能照搬 Chat 的模态 |
| Meta / `meta` | [File handling](https://dev.meta.ai/docs/file-handling)：PDF base64/URL/Files ID，inline 50 MB，上传 1 GiB；文本仅前100页，页图仅前50页 | 已有 Responses 协议可扩，但不能保证长 PDF 完整读取；音频只列 MP3/WAV、视频 MP4；文件不自动到期。Muse Spark 音频还需核对具体版本 |
| Cerebras | [图像输入](https://inference-docs.cerebras.ai/capabilities/image-inputs)仅 base64；文件上传主要为 batch JSONL | 未确认原生 PDF/音频/视频，不把 batch upload 当聊天输入 |
| Baseten | [Vision](https://docs.baseten.co/inference/model-apis/vision) / [Audio](https://docs.baseten.co/inference/model-apis/audio)：Muse Spark Open 有音视频及 OGG，明确不接 PDF | 仅针对该服务型号；其他模型/视频具体块仍待核实 |
| GitHub Copilot | 目录允许混合协议 alias | 本轮未取得可支持通用文件上传/转发的独立官方契约，不列入文件首期；配置可注册不代表订阅鉴权可用 |
| Qwen token-plan 三个 alias、GLM coding alias | 注册表存在，不等于百炼按量付费或 BigModel 通用端点 | PDF/音视频能力、配额、计费逐连接确认；不继承上面原厂通用 API 的文件支持 |

这些补充条目完成“项目已有 Provider”层面的覆盖；未确认的格式、时长和地域不填猜测值。它们不扩大首个 PDF 闭环的支持承诺，也不要求为每个供应商创建一个 Adapter。

## 最小架构方案

### 三层能力，形成一个有效判定

不建设三个独立能力服务。沿用模型注册表，增加少量经过核查的文件输入事实和 Adapter 静态支持表，在运行快照中派生有效能力：

`可提交 = 模型理解能力满足 × Provider 接收该 MIME/理解方式 × 当前 Adapter 可编码 × 本次文件/请求约束通过`

- **Model Capability**：模型理解 text/image/audio/video 等语义模态，以及具体端点承诺的 PDF 页面视觉或文本能力。目录数据只是候选，不依据厂商名称自动开启。
- **Provider Capability**：具体 base URL、API、地域/路由、MIME、传输方式、处理模式与限额；代理与原厂分别声明。
- **Adapter Capability**：当前发布版本实际实现的 wire 格式、授权与重送处理。用户配置不能把未实现的转换强行声明成已支持。

第一阶段只声明 `application/pdf`，避免同时增加所有办公扩展名、音视频 codec 和动态格式的完整矩阵。保留已核查来源和禁用原因；支持声明未知时关闭。自定义 Provider 必须显式选择经验证的协议能力，不能因 `api = openai-responses` 就认为它与 OpenAI 文件 API 等价。

文件类型至少包括规范化 MIME、实际容器类型、显示文件名和字节数。文件名/Telegram 声称的 MIME 不足以授予能力；轻量 magic-byte 检查和流式字节限额属于输入校验，不是 PDF Reader。无法安全确认的类型拒绝，不尝试 OCR、转换或更换模型兜底。

### 通用消息与传输分离

通用历史只保存塑料碗自己的附件引用及来源关系：所属 Context、来源消息/修订或 canonical seq、media 标识、MIME、大小、摘要哈希和状态。Provider 的 `file_id`、`file_uri`、`document.source`、`input_file`、base64、访问 URL 都留在发送边界，不进入通用历史和模型可自行填写的工具参数。

附件和来源文本必须有稳定关联；PDF 内容作为不可信用户输入，不成为 system/developer 指令。MIME 与能力映射以结构化元数据处理，不从用户可伪造的提示文本标记恢复授权。

### 适配路线：自有引用 + 请求期投影 + 小型 wire 转换

已安装 Pi 的 [内容类型](../../node_modules/@earendil-works/pi-ai/dist/types.d.ts#L263)只包含 text/thinking/image/toolCall，用户消息没有 file/document/audio/video union。四个编码器把非 text 的用户块走图片分支：OpenAI Responses 生成 `input_image`，Chat 生成 `image_url`，Claude 生成 `image`；Gemini 虽使用通用 `inlineData`，也不应借此把 PDF 伪装成图片。

可用扩展点是 [StreamOptions.onPayload](../../node_modules/@earendil-works/pi-ai/dist/types.d.ts#L76)：支持异步检查并返回替换 payload，四条现有 Adapter 都调用它。因此建议首期不 fork Pi，也不扩宽 Pi 的 `input` union：

1. 配置在现有模型项旁增加文件输入声明，解析后作为塑料碗自有能力随快照传递；Pi 仍收到原有 text/image 字段。Provider 端的文件处理模式与支持限额另有静态事实，不把二者合并成模型名称判断。
2. user canonical payload 增加可选、经 Schema 校验的 `attachmentRefs` 元数据。**必须同步改造整个落盘链**：`injectBatch` 生成附件描述，经 `pendingUserTags` 传给 `persistMessage`，扩展 `UserMessageSchema` 与 `encodeContextMessage` 的显式编码；旧行无新字段仍可读取。不能只在 live user message 塞一个属性，现有 codec 会丢掉它。附件水合从 retained canonical payload 取元数据，decode 给 Pi 时仍仅提供合法 text/image 消息，不依赖 Pi 保留扩展属性；缓存命中/丢失使用同一路径。落点见 [run-round.ts](../../src/orchestration/agent-runtime/run-round.ts#L93)、[事件持久化](../../src/orchestration/agent-runtime/run-hooks.ts#L153)、[persistMessage](../../src/orchestration/agent-runtime/transcript.ts#L94)、[codec](../../src/context/codec.ts#L77)。
3. **授权存储选定为复用 `context_refs.kind='media'`，首期不新增 CHECK kind。** 为 PDF 签发独立 `file_` token，按“Context 代次 + 明确引入的来源 seq + media/revision”登记；不能直接调用现有按 mediaId 复用旧 sourceSeq 的 `mediaRef`。同一次引入重试应幂等，后续请求携带不续期；只有新的获准引入才能签发新的引用。`sourceSeq/expiresAt` 由 `context_refs` 持有，canonical 元数据保存 ref、mediaId、revisionId 和显示信息，不创建第二套 TTL 权威。GC 删除旧来源 ref 后，新来源 ref 如仍保留可继续有效；仅复制文本中的 token 不构成重新授权。图片 ref 的原有签发语义不改。
4. 每次调用在 `run-hooks` 的媒体水合位置，从**本次保留历史中明确列出的引用**解析附件计划。先校验 Context/generation/head/TTL，再通过 media→revision→message→conversation 关联证明归属与冻结来源匹配，才可用 mediaId 读缓存或下载；现有 `selectMediaRow` / `readOriginalFile` 只按 ID 查询，不能直接当授权层。下载完成到出站前再检查取消、代次/TTL，避免重建途中仍发出旧授权文件。不得枚举整个 media 表，也不得只凭内容哈希访问。
5. 在 Pi 完成消息编码后，**无条件执行文件转换，再按 `record_model_payloads` 开关决定是否审计**，返回转换后的 payload。不能把转换放进调试开关里，也不能从零重建请求丢掉 tools、stream、thinking、cache 等既有字段。`payload: unknown` 必须校验所需结构；升级导致结构不符时明确失败，不能猜字段继续发送。
6. 首个切片可把全部仍有效附件组合成一个请求期的 user 附件消息，附 runtime 生成的来源消息/文件名标识，追加在已完成的工具交互之后；这样无需从可伪造文本找替换标记，也不依赖 Pi 保留消息索引。必须验证工具配对、来源关联及连续 user 规则。它会牺牲部分前缀缓存效率；以后需要原位放置时再扩展并验收映射，不先建通用变换框架。

PDF 入库后的图片分流必须同时修改 [schema.ts](../../src/context/builder/schema.ts#L200) 的 `prepareSnapshot` 引用签发、[render.ts](../../src/context/builder/render.ts#L216) 的 figure/directImages 选择、[format.ts](../../src/context/builder/format.ts#L75) 的文件标签和 Rich Message 分支：只有支持的图像 MIME 进入 Sharp；PDF 显示文件名/MIME/大小/`file_`，不使用 figure 或 `img_` 标签。`read_image`、[save_memo_image](../../src/context/memo-pad/tools/image.ts#L36) 和图片发送参数遇到非图片文件必须明确拒绝，不能因共用 media resolver 而获得处理 PDF 的隐式能力；本任务不扩展文件发送功能。文件水合需要核对 ref 的来源 seq，而现有 `resolve` 返回值不带该字段，应在 Context refs 层提供受限的文件解析结果，不让调用方重复实现授权 SQL。

具体 wire 映射：

| 端点 | 请求期 PDF 内容块 |
| --- | --- |
| OpenAI Responses | `input_file` + `filename` + `file_data`，或后续的 `file_id` |
| Anthropic Messages | `document` + `source:{type:base64, media_type:application/pdf, data}`，或后续的 file source |
| Google generateContent | `inlineData:{mimeType:application/pdf,data}`，或 `fileData:{mimeType,fileUri}` |
| OpenAI Chat 及经核实的兼容端点 | `file`，但内部字段和支持模式按连接声明；OpenAI/Qwen/GLM/Mistral 不能混用 |

**Pi Chat Adapter 没实现文件，不代表 OpenAI Chat API 不接收 PDF。** 该协议可后续接通；Mistral 的 `document_url`、Qwen 的按页费用、GLM 的混合模态限制需要独立小分支，不能用一个“OpenAI compatible”开关全部放行。

不得把 PDF 暂装成 `ImageContent` 再依赖 MIME 替换，这会碰到图片数量、尺寸、降级和压缩逻辑。也不新增 `read_document` 工具：该名字已经用于用户手册；现有 `read` 的 system-only 安全边界保持。首期 PDF 随新消息自动登记，后续按仍有效的 Context 引用投影，工具读取方式不作为前置条件。

## Context 与文件生命周期

### 生命周期的区分

“同一个 Context”应指现有持久化 Conversation Context 的代次，而不是一次 Invocation 或某个 Pi Agent 实例。

- 新 Invocation、Agent LRU 淘汰、进程重启后的 transcript 恢复：只要 canonical Context 仍在，文件引用也应能按授权恢复；不应因为内存缓存丢失就变成新 Context。
- Prompt 变更、显式 rebuild、窗口变化触发真正重建：旧附件授权结束。首期不承诺自动从历史消息重新下载/上传所有旧文件；只提供不可用说明，要求重新发送或明确重新引入。
- checkpoint GC、截断：来源消息移出当前 Context 后，其引用立即失效。不要用“所有本地 media 仍在”延长授权。
- 引用到期和远端文件到期：前者是授权边界，后者只是传输缓存失效。禁止为重传方便自动延长已经失效的授权。

“后续可引用”应明确为：来源仍处于保留历史、引用有效、当前模型/端点兼容时，后续轮次继续携带附件。若产品希望保证整个 Context 期间无限续期，需要显式修改既有 ref TTL 契约，不宜在实现中偷偷绕过。

### 无状态请求与缓存

本地原件只下载一次，后续从已校验缓存读取；只要文件仍属于本次请求可见历史，每次无状态请求都重新提供其输入块。

- 内联 base64：每次请求发送字节，避免重复 Telegram 下载，但没有避免网络重传。
- Provider 文件句柄：上传一次，后续每次请求发送文件 ID/URI；远端过期、连接账户切换后重新上传，不能跨账户重用。
- Prompt caching / cached content：可能减少重复推理 Token 的计费，和“省一次上传”不是一回事；不能承诺文件 ID 免 Token。
- Responses 的服务端 conversation / previous response 链不是首期依赖：继续由 canonical history 控制裁剪、切换与 replay，避免出现第二份无法同步 GC 的历史。

建议首个可验收切片使用有保守体积限制的内联 PDF；随后为相同路径增加 Provider 上传缓存。这样不必把远端上传、轮询、删除、过期恢复全部放进第一个交付前置条件。报告中的 Provider 限额是上限证据，不是建议默认把每次请求开到上限。

上传缓存应以 Context 代次、文件内容哈希、Provider 连接身份/版本和处理模式为键；不能只用模型名称或文件名。保存 MIME、字节数、远端句柄、到期时间和上传状态；并发读取同一键复用进行中的上传。内容哈希用于完整性和去重，不能代替 Conversation 授权。

本地原件缓存同样不能只是一个永不清理的哈希目录：写入使用安全生成的文件名、临时文件+原子完成，读取前核对所属 media/revision 与当前授权，不把 Telegram 文件名当路径；服务重启可由已有引用和受限缓存元数据恢复。设缓存总字节上限，清理中断下载和无有效 Context 引用的文件，Chat 删除时清除归属素材；清理失败只记录运维状态，不恢复授权。活跃文件被容量回收时允许在当前授权下重新下载，拿不到就明确 unavailable，因此“不重复下载”是正常命中路径，不是无限容量保证。无需建立全文索引或长期文件库。

### 模型切换与不兼容输入

每次 Invocation 使用既有配置快照；运行中不半途换 Provider。下次调用重新计算附件的有效能力：

- 兼容：相同原件重新编码；需要时在新 Provider 上传。
- 不兼容或能力未知：保留 canonical 附件事实，但发送明确的“该文件未提供给当前模型”占位，不静默删除、不把 PDF 当图片、不启用解析器、不自动切回昂贵模型。
- 切回兼容模型：只有仍有效且未被 GC 的附件可恢复发送。已经过期/重建的授权不能复活。
- 单文件超限/类型不符/原件缺失：本次发送前标明不可用原因并记审计。上游拒绝整个请求时保留真实失败；只有可明确归因的文件拒绝才允许有界重建请求，不能无条件删文件重试后宣称已读。

可预测错误至少区分：`unsupported_mime`、`provider_unsupported`、`adapter_unsupported`、`file_too_large`、`request_too_large`、`ref_expired`、`context_rebuilt`、`source_missing`、`provider_file_expired`、`provider_rejected`。这是建议的语义集合，不要求建立独立错误框架。

### Replay 与生产输入共用转换，授权分别建立

扩展 snapshot 的可选附件元数据，冻结来源 revision、MIME、文件名、大小及能取得的内容哈希；不要只引用消息编辑后的“最新附件”。老快照无新字段仍可重放。原件缓存用于当前 Context 的连续使用，不承诺永久重放素材；快照保存哈希不能保证原件永远存在。

Replay 根据冻结场景中的媒体关系重新创建 scene-local 附件授权，复用相同水合/能力判定/wire 转换函数，但不调用生产 Context 的 refs、不复用旧 Provider file ID，也不写入生产 canonical history。默认仍使用当前配置或显式临时模型；媒体缺失、过期或新模型不兼容时，在 preflight/结果里说明保真损失，不能把“重放完成”当成“原文件已读”。

PDF 原件在缓存里存在且校验通过时可复用；缓存已清理时，只能经当前 Replay 场景授权和允许的宿主下载器取回，失败就标 unavailable。不得通过解析未经授权的原始 Update、任意 file ID 或跨 Conversation 全库搜索绕过素材缺失。

Replay 本来就是真实模型调用；若后来启用 Files API，上传也是对外发送数据，必须沿用重放的付费操作授权、取消信号和审计，使用可清理的 scene-local 上传记录。维持发送/记忆写入等既有合成副作用行为。

明确的改造入口是 [scene/index.ts](../../src/context/scene/index.ts#L130) 增加文件分类与 scene-local 文件映射、[replay/prepare.ts](../../src/orchestration/replay/prepare.ts#L115) 派生该模型的文件能力、[replay/run.ts](../../src/orchestration/replay/run.ts#L186) 新增共享附件投影的 `onPayload` hook。现有 Replay stream 路径不带生产的媒体水合 hook，不能仅修改生产 `run-hooks`。

## 实施顺序与验收门槛

建议按可独立验收的切片推进，不以“所有 Provider 同时支持”为交付条件。以下是后续实施建议，本轮没有执行：

1. **PDF 首个闭环：OpenAI Responses 官方端点。** PDF 入库与图片分类分离；文件元数据、canonical 附件引用、Context 原件缓存、请求期投影、审计剥离、预算与不可用原因；生产和 Replay 同时覆盖。建议起始保护值单文件 8 MiB、每请求累计原件 16 MiB，并另校验完整编码请求大小。这是保守的产品默认建议，不是厂商限制；不得使用按字节估算的“页数”承诺。
2. **PDF 扩充：Claude Messages、Gemini generateContent。** 复用相同引用与缓存，只增加协议转换及各自限额；三个端点各过 fixture 和后续真实验收。然后考虑有需求的 Chat PDF、Qwen/GLM 和 native-only 网关组合。无需为了第一阶段提前更换整套 Pi。
3. **同阶段可选优化：Provider 文件句柄缓存。** 只有当重复内联的网络/时延实测值得时加入。处理上传、就绪状态、到期/丢失、账号切换、删除补偿；继续每请求引用，继续按 Token 计费。远端 404 只能在本地原件仍获授权时有界重传，失败不无限重试。
4. **P1 办公文件。** 先接复用 Responses 的 OpenAI 文本抽取/表格路径，以及 Google 或 GLM 已确认端点。向模型明确 DOCX/PPTX 内嵌图、XLSX 行数/工作表覆盖的限制。Mistral OCR、Kimi/Qwen-Long 的抽取属于 Provider 辅助处理另一路，可按需求后置，不能自动成为不兼容模型的 fallback。
5. **P1 音频和视频。** 优先能原样接收 Telegram OGG/Opus、MP4 的 Gemini 组合，再评估 Qwen/其他厂商明确的格式。voice、audio、video、animation、video_note 都补入站元数据和下载授权。纯 ASR 是可选的 Provider 服务，不能被描述为主 Agent 原生理解声音；只接受 WAV/MP3 的端点暂不接 OGG，不建设通用转码。视频先短 MP4，随后按证据覆盖 WebM；画面理解不代表音轨也受支持。
6. **P2 GIF/动态贴纸/结构化文件。** Telegram animation 经常实际是 MP4；按实际 MIME/容器分派。TGS 不当视频，保留现有贴纸代表帧流程；不宣称其具有动态理解。JSON/CSV 先利用 Provider 已支持的文件/文本入口，拒绝压缩包和任意脚本执行。独立 Parser/OCR/RAG 仍不进入前置范围。

每个切片先写失败场景与契约测试，再实现。验收至少覆盖：

- 实际锁定 Pi Adapter 产出的请求，经本地 fixture server 捕获后确实含对应文件块；不能只断言 Faux 模型收到 `file` 字样。覆盖文本+图片+PDF、工具回合后续、两文件来源不串线、协议字段不匹配时失败。Gemini 不接受自定义 fetch 时，用配置的本地测试 endpoint/现有 SDK fixture 边界拦截，不能跳过 wire 验证。
- 同一 Context 连续两轮、跨 Invocation、LRU 驱逐、重启恢复都能用文件；断言 canonical 只含引用，下载次数不重复；inline 模式每轮仍有字节，file-ID 模式上传次数只一次但每轮仍有引用。
- TTL、GC、cut/rebuild 后不再出站；跨 Chat/Topic、伪造 ref、伪造 MIME、来源修订变化、Provider 连接变化、大小未知/超限和远端过期均有明确状态。GLM 等不能混合文件和图片的端点预先拒绝冲突文件，不损害原有图片输入。
- 模型切换必须分别测试“不触发 reset”与“Prompt/窗口触发 reset”，后一类不承诺文件恢复。
- Replay 用相同文件转换但独立授权；旧快照可读、素材缺失可见、生产 Context 不变；审计同时验证原件字节和凭据未写入 request JSON。
- 扫描页、图表、加密/损坏 PDF、长文件属于真实 Provider 后续验收；只允许文档说明能力的模型组合通过。纯 HTTP 200 不足以证明文件生效，应问仅文件里存在的随机事实并核对 usage/请求内容。

功能实现后的检查按仓库规则执行受影响 Vitest、`pnpm run check`、`pnpm run lint`；跨模块跑完整 `pnpm test`，若触及 Admin 则跑受影响 Playwright，Schema 生成文档变化则跑两种 base path 的 docs 构建/验证。本轮仅调研，无这些功能验证通过的声明。

## 风险与取舍

1. **Token 和价格**：PDF 页图与提取文本可能同时入上下文。音视频还受采样率、时长、分辨率及专用价格影响。复用文件 ID 不消除重复输入费用；每次调用的上游 usage 是记账依据，估算仅用于准入与 GC。首期无页数解析器时不能靠本地字节数保证上下文一定装得下，应保守限制并处理 Provider 的页数/上下文拒绝。
2. **多重体积限制**：base64 约增加三分之一体积，JSON 和其他消息继续占请求空间。逐文件上限、累计原始字节、编码后请求上限、上下文预算全部检查；不要把 Files API 的大上传配额视作推理请求配额。
3. **Telegram 下载瓶颈**：官方 [getFile](https://core.telegram.org/bots/api/methods/getfile.md) 当前最多下载 20 MB，下载地址至少有效一小时。该 URL 包含 Bot token，绝不能交给 Provider 拉取或写进模型上下文。由宿主下载后内联/上传，保存原消息中的文件名/MIME，因为 `getFile` 不保证保留它们。
4. **内容安全与隐私**：附件正文、文件名、PDF 内嵌指令都不可信；沿用 Chat/Topic/Context 隔离。拒绝任意外部 URL 和任意 Provider file ID 作为模型授权凭据。审计只留哈希、大小、状态、处理方式和脱敏来源，不落文件 base64、带签名 URL 或含凭据下载链接。原件下载时计算哈希并复用，生成审计副本时先以元数据替换字节再序列化，避免每轮为大文件 `JSON.stringify` + base64 解码分配多份内存；设审计载荷上限并记录截断状态。
5. **远端保留**：上传到厂商后不随本地 GC 自动消失。先选内联可减少远端句柄管理，但不等于厂商零保留。采用 Files API 后，显式删除/到期和失败补偿是传输生命周期的一部分；不建立长期文档存储，删除失败也不能维持模型授权。Google [2026-10-26 更新](https://aistudio.google.com/docs/changelog)说明新付费项目的 generateContent 默认存储请求，既有项目保持原设置；应核对请求 `store`/项目日志选项，不能假定“无状态请求=无保留”。Claude Files 的合规资格也不等同内联 Messages，见 [Files 文档](https://docs.anthropic.com/en/docs/build-with-claude/files)。
6. **Provider 差异与维护**：相同模型通过网关时，格式、OCR fallback、区域、文件 TTL 和计价可能不同。将协议编码与连接能力分别判断，保持少量已验收组合。不要为未知兼容端点复制整套 Provider 实现。
7. **理解质量**：“接受文件”不保证长表格完整计算、扫描文字准确、所有视频帧都被采样。能力声明注明理解方式和采样限制；不把有限 API 支持描述成等价于用户端完整办公/影音应用。

## 证据、复现和仍需验证的事项

只读实验一：从项目 `listBuiltinProviders()` 运行 `isSupportedBuiltinPreset` / `listBuiltinPresets`，检查实际可配置 Provider 与协议集合；未读取部署配置或凭据。混合协议目录的 Provider 可通过既有 alias 使用，但不一定出现在新增预设列表。

只读实验二：向 `scrubModelRequestAuditJson` 传入只含字符串 `synthetic research fixture` 的四种合成载荷。结果为 image `replacements=1 / bytesRemain=false`，Responses PDF、Anthropic PDF、Gemini PDF 均为 `replacements=0 / bytesRemain=true`。未发送网络模型请求，未用真实文件。

最小复现（在仓库根目录执行 Node ESM；载荷只含合成字符串，不需要配置/凭据）：

```js
import { scrubModelRequestAuditJson } from './src/platform/models/request-audit.ts';
const data = Buffer.from('synthetic research fixture').toString('base64');
const payload = { type: 'input_file', file_data: `data:application/pdf;base64,${data}` };
const result = scrubModelRequestAuditJson(JSON.stringify(payload));
console.log({ replacements: result.replacements, bytesRemain: result.json.includes(data) });
```

只读实验三：直接导入锁定版本的 `@earendil-works/pi-ai/api/openai-responses`，用合成模型和替身 fetch 拦截，`onPayload` 返回保留原参数并追加一个合成 `input_file` 的对象。捕获结果含 `input_text` 和 `input_file`，`model/stream` 保持，替身调用一次、真实网络请求零次。这验证了首选扩展点在当前版本可把文件块传到 HTTP 序列化边界，**不证明 OpenAI 接受合成 PDF，不证明完整 Context/工具回合方案已实现**。没有写入代码或测试文件。

Google 部分官方页面的 HTML 只返回应用外壳；本轮对已检索出的公开 URL 用 `Accept: text/markdown` 取得官方正文，另核对 generateContent 版本。没有把网页产品 UI 的上传功能作为 API 能力证据。引用是核查当日的动态官方页，不是永久冻结的 API 合约；部署前应复核目标型号、地域、协议与 SDK 版本。

仍影响实施、但不妨碍本次选定最小路线的未知：

- `onPayload` 的 OpenAI Responses 序列化边界已用替身验证；完整附件追加的工具时序、其余 Provider 参数校验和 Pi 升级稳定性仍需 Adapter + fixture 验证，尚无完整实现 spike。
- 同一文件的扫描页、图表、Office 多 sheet、损坏/加密文件处理效果没有真实厂商验收。尤其 GLM 文件理解细节、Qwen 扫描 PDF、各 Coding Plan 和兼容网关都不能宣称已验证。
- 官方未统一/存在冲突的限制（Grok 上传大小、部分 GLM 视频时长、Gemini 音频计数、Mistral 图片限制）按保守端点策略或关闭该组合处理，不用猜测值扩大支持。
- 文件规模、重复轮次和缓存命中率未知，因此不提供虚构的时延/费用提升百分比；先用内联首个闭环测量，再决定远端上传缓存优先级。

本轮验证：源码与锁定依赖只读追踪、Provider 目录枚举、合成审计实验、OpenAI Responses Adapter 的零网络传输边界实验、官方文档核查。没有修改功能代码、安装依赖、运行真实 Telegram/模型调用或执行功能测试。

独立复核结果：架构复核在补齐引用签发、落盘链、媒体分流、无条件转换、归属校验及 Replay hook 后通过；官方矩阵复核在补齐成本口径、缩小 xAI 断言并重新读取 Mistral 折叠 FAQ 原始证据后通过。结论仅为“研究方案没有发现决定性缺口”，不等同已实现、已获产品批准或真实端点验收通过。
