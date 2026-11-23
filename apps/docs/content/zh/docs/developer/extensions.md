---
title: 扩展与 IM 宿主边界
description: System Skills、execute 与 mcp 网关、内置插件的契约，以及 HostKind 这一内部边界，均不构成第三方平台承诺。
---

# 扩展与 IM 宿主边界

这里讲的是「想把塑料碗改成什么」而不是「怎么配置」，包括模型能读到哪些只读文档、内部能力怎么暴露、内置插件写在哪，以及新增一个 IM 宿主意味着改什么。前三条是**源码级**扩展，没有市场、没有上传 Skill、没有热插拔第三方插件。

## System Skills

System Skills 是随 runtime 发布的只读文档包，由两处来源合并：

- `src/system-resources/skills/`：`image-inspection`、`memory`、`sticker-search`、`user-manual`。
- 每个插件自己目录下的 `skills/`：`web-search`、`web-fetch`、`image-generation`、`alarms`、`dictionary`。

两者都挂到虚拟资源树的 `system:///skills/<名字>/` 下，入口文件固定叫 `SKILL.md`。

- system prompt 里只放**索引**：名字、一句描述与 URI，一行一个，并声明「这是完整清单」。正文不进 prompt。
- 模型用 `read` 按需读取正文，可以给绝对 `system:///` URI，也可以给相对引用加上找到它的文档 URI（例如 `uri "references/tools.md"` 配 `base "system:///skills/persona/SKILL.md"`）。
- 单次读取上限 32 KiB，超出时尾部追加 `[content truncated]`，返回值里的 `truncated` 为真。
- 只有 `system:///` 树内的 Markdown 可读，其它 scheme、任意文件路径、写入一律 `invalid_uri` / `resource_not_found`。文档是 runtime 资料，**可以**解释什么时候用哪个工具，但不得覆盖工具约束、核心 Agent 协议或授权规则。

可见性由三层过滤决定，过滤器在 `createHostTooling` 里：

1. 宿主画像的 `hiddenSkills`：Playground 房间看不到 `alarms`、`dictionary`、`sticker-search`。
2. 插件声明的 `hosts`：只挂该插件服务的宿主。
3. 插件 `available()` 为假时，它的能力与它的 Skill 一起消失（搜索关闭时 `web-search` 技能也不该出现）。`image-generation` 另外要求这个具体会话开过生图。

因为索引进 system prompt 参与哈希，Skill 清单变化会让相关 Conversation 在下次运行时重建 Context。

## MCP Skills

出站 MCP 服务器如果实现了 `io.modelcontextprotocol/skills` 扩展，它的 Skill 也能被 `read` 读到，URI 是 `mcp-skill://<alias>/<skill>/<path>`。

这些文件是**外部服务器的数据，不可信**。发现阶段就做完整校验，不合格的那个 Skill 被单独丢掉，不会连累服务器已连上的工具：

| 限制 | 值 |
| --- | --- |
| 每个服务器的 Skill 数 | 32 |
| 每个 Skill 的文件数 | 64 |
| 单文件字节 | 32 KiB |
| 单服务器 Skill 总字节 | 1 MiB |
| Skill 文件 URI 长度 | 512 |
| `read` 工具描述里的索引 | 最多 4096 字符、32 条 |

校验内容：Skill 清单格式、URI 必须落在自己根目录内、每个文件读回来的 UTF-8 字节数与 `sha256` 必须与清单完全一致。

可见性与同名工具完全同一套规则：宿主支持 MCP、该 Chat 绑定了这个服务器、实例就绪且至少有一个可达工具，再加上服务器自己的 `skills` 开关。不可见的 Skill 对那个 Chat 等于不存在，猜到的 URI 只会得到 `resource_not_found`。`read` 只在当前 Invocation 真的有可见 MCP Skill 时才在描述里附一段索引，并明确写明信任边界。

## execute：内部能力网关

`execute` 是模型调用 runtime 内部能力的唯一入口，只有三个动作：

| 动作 | 输入 | 返回 |
| --- | --- | --- |
| `search` | `query`（1–200 字符） | 匹配的能力 `[{ name, summary }]`，最多 8 条 |
| `help` | `tool` | 该能力的 `label`、`description` 与参数 Schema |
| `call` | `tool` + `input` 对象 | `{ text, refs }` 信封；返回图片的能力在信封后附带图片 |

- 直接暴露的原语**不能**经 `execute` 调用，包括 `read`、`send`、`send_reply`、`execute`、`zzz`、Memo 与群聊记忆的读取工具、`read_member_profile`、`mcp`，MCP 工具同样不能。
- 参数按能力自己的 Schema 校验。单次 `call` 输入默认上限 32 KiB（Memo 写入类另有更小的上限），结果上限 32 KiB。
- 能力可以声明「有副作用」，审计里区分这只是读取还是真的改了东西，计费类能力不自动重试。
- 未注册的名字返回稳定错误码，不做模糊匹配。

注册表由 `createHostTooling` 组装，顺序是：

1. `read_image`（宿主画像 `mediaRead` 为真时）。
2. `search_stickers`（`stickers` 为真且此刻有贴纸索引）。
3. Memo Pad 写入工具（`add_memo`、`update_memo`、`delete_memo`）与 `save_memo_image`。
4. `list_documents` / `read_document`（镜像内置用户手册，单页同样 32 KiB）。
5. 各插件按 `BUILTIN_PLUGINS` 顺序贡献的能力。

Skill 与能力的文案都只有英文源码，没有本地化版本，模型读到什么就按什么说。

## 渐进式 mcp 网关

每个服务器在配置里有 `exposure`：

- `direct`：工具按 `<alias>__<tool>` 直接进工具注册表。
- `progressive`：不进注册表，全部收进唯一的 `mcp` 原语。模型从它的描述里看到 alias、管理员审过的描述与工具数量，再用 `search`（可带 `server` 限定与 `offset` 翻页）/ `help` / `call` 按需发现和调用。

`call` 走的是与直接暴露完全相同的 `executeMcpTool`，沿用同一套 allowlist、只读策略、请求/响应上限、超时、结果转换与审计，内层 `tool_calls` 行仍记 `<alias>__<tool>`。发现不是授权，网关手里只有这个 Chat 解析出来的定义。

目录有上限，每页最多 10 条搜索结果、列表最多 100 条，单页 JSON 超过 24 KiB 就提前结束并给 `next_offset`。

## 内置插件

插件列表是编译期常量 `src/plugins/builtin.ts`，每个组合根都加载同一份：

| id | 宿主 | Skill | 通过 `execute` 提供 | 何时出现 |
| --- | --- | --- | --- | --- |
| `web-search` | telegram, playground | `web-search` | `web_search` | `web_search` 未关闭，且至少有一个启用引擎 |
| `tavily` / `brave` / `exa` / `firecrawl` / `deepseek` / `searxng` / `youcom` | — | — | —（向 `web-search.providers` 贡献引擎） | 随 `web-search` |
| `web-fetch` | telegram, playground | `web-fetch` | `web_fetch` | 总是 |
| `image` | telegram, playground | `image-generation` | `image_generate`、`list_image_models`、`search_image_assets` | 进程接了生图桥，且该会话开了生图 |
| `alarm` | telegram | `alarms` | `alarm`、`list_alarm`、`delete_alarm` | 总是 |
| `dictionary` | telegram | `dictionary` | `lookup_dictionary`、`add_dictionary_entry`、`update_dictionary_entry` | 总是；另有每批注入的辞典上下文 |

### 插件契约

`definePlugin` 只做类型标注，真正的校验在 `loadPlugins`：

- `id` 必须匹配 `^[a-z][a-z0-9-]{0,63}$`，不能重复，也不能占用 runtime 保留的 id（循环闹钟的 `RECURRING_ALARM_PLUGIN_ID`，它决定哪些任务数据可以当作可信指令渲染）。
- `hosts` 必填且非空，插件显式声明自己的宿主矩阵，而不是靠缺省悄悄落在所有宿主上。
- `dependencies` 必须出现在更早的位置（`loadPlugins` 直接拒绝顺序错误），并且**只有**声明了对某个扩展点所属插件的直接依赖，才能向那个扩展点贡献值。
- 扩展点名形如 `<owner>.<contract>`（1–3 段）。点可以带 `identify`，同一个身份被两个插件贡献会报错，这是 provider id 之类「按名字解析的键」保持唯一的办法。
- 能力名与上下文注入器名都不能重复，注入器继承所属插件的宿主矩阵。

插件拿到的 `InvocationScope` 里有本轮配置、当前发布的配置读取器、Invocation Context、deadline、审计、存储、**按插件 + 会话绑定的任务作用域**、媒体引用解析、生图桥、工具图片存储、SecretStore 与 out-of-band `steer`。能力必须用作用域里的对象，不能自己缓存配置。

### `web_fetch` 看图片

内置能力里只有 `web-fetch` 会顺手把外部图片变成「本轮工具图片」。页面 Markdown 里的图片保留成普通的图片链接，模型可以再用 `web_fetch` 抓那个 URL，JPEG / PNG / WebP 会作为附带图片返回（一次一张），网站拒绝时用 `referer` 传页面地址。

- 单张上限 20 MiB，超过是 `image_too_large`。
- 只在本轮会话授权范围内可引用，引用不跨会话、有 TTL。
- 没有本地素材存储的进程不提供这条路径（描述里也不会提）。

## 多 IM 宿主边界

代码里已经按 `HostKind`（当前 `telegram` 与 `playground`）解耦，但这只是内部结构，**不是**「支持任意平台」的承诺：

- `src/platform/im-host/` 是宿主中立的契约层：身份（`HostKind`、会话引用、发送者引用）、消息线索（`MessageCues`）、投递、策略与配置来源。
- `src/platform/host-profile.ts` 是宿主特征表：媒体读取、贴纸、MCP、睡眠、预算作用域、配置来源、入库方式（`bucket` / `release`）、投递记录方式、快照格式，以及每个宿主自己的模型可见措辞。core 代码读特征或写穷尽 `switch`，不写 `kind === 'telegram'` 这类分支。
- `src/platform/config/projection.ts` 是唯一允许 core 了解「宿主的配置落在文件哪一段」的地方：`configuredChats`、`allConfiguredChats`、`hostIntakeSettings`、`resolveChatConfig` 等访问器。`config.telegram` 仍是文件形状与面板契约，但 core 不直接读它。
- `src/ingress/intake/` 是宿主中立的入库与消息批次路径，`src/ingress/telegram-ingestion/` 与 `src/ingress/playground.ts` 是各自宿主的边缘。
- 三条边界测试钉住这条线：`test/im/host-literals.test.ts`（core 不出现宿主字面量）、`test/config/host-projection-boundary.test.ts`（core 不读 `config.telegram`）、`test/im/transport-imports.test.ts`（`grammy` 只出现在宿主边界）。

新增宿主是**源码级**改动，新的 `HostKind`、新的 `HostExecutionProfile`、配置投影、边缘入库、适配器与宿主相关的提示措辞一处都不能少。没有第三方宿主插件机制，也不提供稳定的宿主扩展 API，本项目目前只服务 Telegram 与本地 Playground。

## 不存在的东西

明确写出来，免得读者去找：

- 插件市场、插件包安装、运行期热加载第三方插件。
- 任意上传 Skill（模型的 Skill 只有 `system:///` 与 `mcp-skill://` 两种来源，后者由服务器发布并经校验）。
- 任意代码执行、Bash、无限制文件系统访问。模型能做的都在 Tool 边界内。
- 可编程的第三方 IM 宿主接入。
