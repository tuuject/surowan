# Public Release 文档重组调研与规划

- 日期：2026-11-06（2026-11-23 同步增补 2026-11-06 至 2026-11-23 的新增功能、变更与双语/截图决策）。
- 状态：调研与增补完成，整体方案待维护者确认；两篇入门教程职责（见 3.4）以及双语文档、默认根路径、内置手册语种与 Playwright 双语截图范围（见 3.5）已澄清。本文件不代表已审核 PRD，也不授权实施。2026-11-23 应用户要求按第 10 节推荐选项实施，分工契约见 [实施拆分](20261123%20Public%20Release%20文档重组实施拆分.md)；第 10 节各项仍由维护者在 PR review 中确认。
- 调研基线：`af2bc767`（原基线 `7daebf39e685b84d314dbca77d07730718a939d8`，已核对期间合入的 PR #65–#126 及相关文档/配置/界面变更）。
- 范围：保留「指南」「配置文件参考」「开发者参考」三个顶层分类，规划 **简体中文（`zh-CN`）+ English（`en`）** 双语公开文档重组、双语参考生成及 Playwright 双语截图自动化。
- 原始调研仅进行只读探索，未启动服务、运行构建或测试，未连接真实 Telegram、Provider，未生成截图。随后按用户要求将报告保存为本文件，并在 2026-11-23 按当前源码、现有文档与维护者补充决策同步更新。
- 本文描述的是上述提交的调查结果；实施前须重新核对源码。下文目录、拆分、自动化及实施顺序均为建议。

## 1. 建议结论

保留三个顶层分类，上线 **简体中文与 English 双语文档**，并在编写文档阶段通过 **Playwright 自动化截取简体中文与 English 两套面板截图**。新手主线调整为：

> 安装并用服务器一次性码登录面板、接入可运行的模型 → 设计人设并在虚拟群聊试聊 → 接入真实平台（目前为 Telegram）→ 按实际表现调优（含入场闸门、批改导出、续跑与参与/批次控制）。

现有内容大多可以复用。主要工作是建立中英双语站点结构与生成流程、重排任务路径、补齐 2026-11-06 之后合入的新功能（无网页建号的一次性登录与 Agent SSH 配对、Keychain 密钥管理、Providers/Models 双页与模型昵称/目录源、自适应消息批次、`/ask` 与 `ask_only`、`/help` 命令、Decisions 入场闸门、循环闹钟、群聊记忆 30 小时制、Invocation 批改导出/失败续跑/实时自动刷新与自动滚动、出站 MCP 面板/按群绑定/渐进式暴露/`mcp-skill://`、贴纸集管理、生图参考素材与 AI 提取、Web Fetch 看图与多 IM Host 扩展边界）、修正已漂移的行为说明，并补齐接口契约。沿用 Rspress 2（启用双语 locale）与现有 Playwright 基础设施，不需要更换文档框架或增加额外截图依赖。

## 2. 调研范围与现状分析

调查覆盖了公开文档及导航、Rspress 配置与打包脚本、配置 Schema/解析/验证/热更新/废弃字段、Admin 路由/导航（Koi 迁移后，含 Entry gate 与 MCP servers 等新页）和部分操作测试、两套 CLI（含服务端 `pairing`/`clients` 与客户端 `auth`）、反向 MCP Server、相关 Skill、文档构建部署及截图基础设施。遵循仓库规则，没有读取历史设计归档和冻结 devlog 正文。

### 2.1 已有文档及可复用基础

| 区域 | 已有内容 | 规划中的定位 |
| --- | --- | --- |
| `apps/docs/content/docs/` | 当前为纯中文：开始使用、配置与接入（含 Agent 配对、Keychain、Invocation 批改）、个性化指南（含循环闹钟、入场闸门）、维护排障、参考 | 重组为 `zh-CN` / `en` 双语公开正文（三个分类） |
| `apps/docs/examples/` | 完整配置、人设示例 | 保留示例唯一源，补充更小的入门示例（跨语言复用下载资源） |
| 根 `docker-compose.yml` | 部署模板，与文档下载共用 | 保留唯一源，不在文档另存副本 |
| `agent-doc/` | 架构、数据、配置、运维、验证等维护者资料 | 继续服务代码维护，不整体搬进公开文档 |
| `packages/cli/` | `surowan-utils` 客户端及说明（含 Ed25519 配对签名） | 开发者参考的代码依据 |
| `skills/surowan-utils/`、`skills/surowan-mcp/` | 外部 Agent 操作流程与边界 | 保留可安装资源，文档解释安装与使用 |
| `src/system-resources/`、插件内 Skills | Bot 自己使用的只读能力说明 | 与外部 Coding Agent Skill 明确区分 |

现有文档站基础：

- Rspress 2 静态站（当前仅配 `lang: 'zh'` 单语，需扩展为 `zh` + `en` 双语 `locales`），支持搜索、逐页 Markdown、`llms.txt` 和 `llms-full.txt`。
- 从当前 `ConfigSchema` 生成字段页（已含 `fields-models-dev.md` 等顶层段分页，已渲染 `deprecated` 提示）和可下载 JSON Schema。
- 使用真实 `loadConfig` 离线校验完整示例和正文 JSONC 片段。
- 校验链接、图片、来源提交、搜索、下载文件、Markdown 产物及 HTTP 404。
- 同一份正文打包为镜像内置用户手册，供 Bot 按需读取。
- GitHub Actions 验证 `/`、`/surowan/` 两种部署 base；生产配置指向 Cloudflare Workers 静态发布。

依据：[文档站维护说明](../../apps/docs/README.md)、[Rspress 配置](../../apps/docs/rspress.config.ts)、[生成脚本](../../scripts/docs/prepare.ts)、[验证脚本](../../scripts/docs/verify.ts)、[文档 CI](../../.github/workflows/docs.yml)。

这里确认的是仓库中的发布配置与流程，没有验证 Cloudflare Dashboard 当前设置或线上发布状态。

### 2.2 主要问题

#### 新手主线仍以手改完整配置为中心

当前快速开始要求读者先理解 Provider 协议、模型能力和元数据、Agent/Vision 引用、Telegram Chat ID，以及可选生图段。源码和面板已支持分阶段设置：先启动服务并用服务器一次性码登录面板，再在 Providers/Models 添加 Provider、自动补全元数据、选模型、在 Prompts 写人设，通过 Playground 验证。

#### 任务内容和精确参考交错

Telegram 接入页同时承载首次接入、自适应消息批次、贴纸集管理、发送去重、空文本策略和命令；Admin 总览同时承担页面索引、登录、恢复、批改、续跑、实时刷新和部分接口说明。读者完成一个任务时容易进入细节分支。

#### 已确认的行为漂移

| 现有表述 | 源码事实 | 影响与建议 |
| --- | --- | --- |
| 配置页把删除 Chat 与 MCP 列为需要重启 | `mergeChats` 将移除 Chat 作为热更新；`mcp.servers` 与每群 `mcp` 绑定也已全部热应用（后台建连，停跑受影响会话并自动续跑，`required` 已废弃） | 修正生命周期矩阵，区分移出配置与删除数据，并更新 MCP 热应用与降级语义 |
| `configure/admin.md` 顶部仍写「首次访问时创建管理员账号」，与同页「首次登录」矛盾 | 已无网页 setup 建号端点；首次登录只能靠服务器 `pairing create --web`（自动建无密码 `admin`）或离线 `admin-account` | 统一删去网页首设表述，确保安全边界一致 |
| Prompt 管理页称 API key 不能编辑 Prompt | API key（与配对客户端）经权限检查后进入共用路由；Prompt 保存、恢复已列入接口表 | 删除仅 Session 的旧限制，按权限模式与 Session-only 白名单（Auth/API keys/Keychain）说明 |
| 产品知识索引仍称 API key 不能改配置、删除 Chat 要重启，且缺多项近期新功能 | 已被当前权限、热更新与新能力取代 | 正文修正后同步索引，避免 Bot 继续引用旧事实 |
| 首次运行要求文本和图片模型，并同步设置 Vision | 主 Agent 只要求 `text`；Vision 可不配置，直接看图和独立 Vision 是不同能力 | 首次主线只要求实际任务所需能力 |
| 顶层配置概览未完整覆盖 `image`、`dictionary`、`tool_model`、`web_fetch`、`models_dev` 等段，且未集中标注废弃字段 | 当前 Schema 包含上述全部段，另有三个兼容废弃字段（`deprecated.ts`）与 `mcp.servers[].required` | 从 Schema 自动建立完整目录，单独标清废弃兼容字段与替代项 |

证据：[Chat 配置合并](../../src/platform/config/diff.ts)、[废弃字段清单](../../src/platform/config/deprecated.ts)、[Chat 删除端点](../../src/ingress/admin/routes/chats.ts)、[Keychain 仅 Session 路由](../../src/ingress/admin/routes/keychain.ts)、[API key 路由授权](../../src/ingress/admin/index.ts)、[Prompt 接口表](../../packages/admin-surface/src/specs/prompts.ts)、[旧 Prompt 文档](../../apps/docs/content/docs/configure/admin-prompts.md)、[旧 Admin 文档](../../apps/docs/content/docs/configure/admin.md)、[旧配置文件文档](../../apps/docs/content/docs/configure/config-file.md)、[产品知识索引](../../src/platform/prompts/2-product-knowledge.md)。

必须保留这个区别：从配置中移除 Chat 与调用面板/API 删除 Chat 不是同一个数据操作。后者还会在停止运行、核对授权状态后删除相关数据；停止未完成时可能返回待处理错误并保留数据。

#### 接口目录存在，但完整接口文档尚未形成

`packages/admin-surface` 能提供方法、路径、参数入口、权限、并发版本和确认要求；它没有逐字段描述请求 body，也没有完整响应 Schema，且不收录 Session-only 的 Keychain 路由（`/api/keychain*`）。当前不能仅凭该表宣称已有可直接导出的完整 OpenAPI。

#### 截图没有文档资产流程

部分 E2E 已调用 `page.screenshot`，但图片写入临时测试产物。尚未形成面向双语文档（简体中文 + English）的场景清单、资产命名、引用关系、更新命令及审核机制。

### 2.3 2026-11-06 之后新增功能与变更汇总

原规划基线 `7daebf39` 之后至 `af2bc767` 之间合入了多项用户可见与开发者可见能力（PR #65–#126），需要整体纳入本次重组方案：

| 主题 | 新增 / 变更能力 | 归属文档位置 |
| --- | --- | --- |
| 定位澄清 | `README.md` 明确本项目为「塑料碗 Harness（Surowan Harness）」，是人设无关的 Harness 服务端 | 指南入口、核心概念、首页定位 |
| 安全登录与 Agent 配对 | 移除网页建号 setup；新增服务器一次性登录码 `pairing create --web`、Agent 配对 `pairing create` / `clients`、本机 `surowan-utils auth init/pair/status/permissions/logout`（Ed25519 请求签名、防重放、预绑定公钥）；密码失败按 TCP 对端地址锁定 | `guides/installation.md`、`guides/admin.md`、`guides/agent-assisted.md`、`developer/http/index.md`、`developer/service-cli.md`、`developer/client-cli.md` |
| Keychain 密钥管理 | `key.json` 升级为 Keychain：稳定条目名、多处共享、原地轮换并触发热应用、孤儿显式清理、旧格式自动迁移；新增面板 **Keychain** 页（Session-only）；各页密钥输入控件统一支持新密钥或选用已有条目 | `guides/admin.md`、`configuration/secrets.md`、`developer/http/configuration.md` |
| 模型选择与昵称 | 拆分为 **Models**（三角色分配与思考强度，统一保存栏）与 **Providers**（供应商与模型列表、自动拉取与 `models.dev` 补全/最高价回退、「用作 / Use as」快捷分配、批量健康检查并展示模型原话回复）；新增模型 `nickname`（Telegram 命令脱敏）、`models_dev.api_url` 镜像配置、切换模型中止旧会话确认、`vision.thinking_level` | `guides/models.md`、`configuration/providers.md`、`configuration/models-dev.md`、`configuration/vision.md`、`developer/http/configuration.md`、`developer/telegram-commands.md` |
| Decisions 入场闸门 | 新增全局 `telegram.decision_gate` 与每群 `chats[].decision_gate`（热更新，`shadow` 影子观察 / `enforce` 拦截，阈值/历史与批内条数/自定义是非提问，`enforce` 下跳过主动回复抽样、被拦批次记 `skipped_budget`/`decision_gate_dropped`、不计入日预算、故障/超时一律放行、直接触发/私聊/回执/循环闹钟/恢复/追赶/Playground 不经闸门）；新增面板 **Entry gate（入场闸门，`/decision-gate`）** 页、Chats 行内覆盖与 `decision-gate show/update/decisions` 接口；`doctor` 开启时实测连通性 | `guides/tuning.md`、`guides/chats.md`、`guides/troubleshooting.md`、`configuration/telegram.md`、`developer/http/configuration.md`、`developer/service-cli.md`、`developer/client-cli.md` |
| 自适应消息批次 | `telegram.bucket_max_seconds`、`bucket_bump_seconds`（配合 `bucket_window_seconds` 实现消息到达延长等待），与 `idle_grace_seconds` 的跨字段约束，Telegram 设置页热编辑生效 | `guides/tuning.md`、`configuration/telegram.md`、`developer/http/configuration.md` |
| `/ask`、`ask_only` 与 `/help` 命令 | 新增成员命令 `/ask`（支持匿名管理员与频道身份，允许 `/ignoreme` 成员显式唤起）与 `/help`（按发送者在当前 Chat 的权限动态列出可用命令，含被忽略成员精简列表）；新增全局与每群 `participation.ask_only`（0 秒 Bucket、不留注意力窗口、普通消息仍入库并参与群聊记忆） | `guides/chats.md`、`configuration/telegram.md`、`developer/telegram-commands.md` |
| 循环闹钟（Recurring alarms） | 管理员在面板按规则/标准 5 段 Cron 设定周期任务与可信提示词（支持多规则、未来 5 次预览、独立时区、Run now 立即执行、最近 50 次触发记录、预算与睡眠豁免），与 Bot 自建一次性 Alarm 明确区分；API 写与立即执行需 `write+paid` | `guides/tools.md`、`developer/http/data.md`、`developer/mcp-server.md`、`developer/client-cli.md` |
| 出站 MCP 面板、按群绑定、渐进式暴露与 MCP Skills | 新增 **MCP servers** 页（HTTP 增改删、stdio 连接字段只读、实时状态与工具/Skill 列表）与每群 `chats[].mcp` 绑定/收窄；新增 `exposure`（`direct` vs `progressive`，后者收进唯一 `mcp` 网关原语供 `search`/`help`/`call`）、`description`（支持 `mcp-server describe` 调用工具模型起草草稿、缺省告警 `mcp_description_missing`）与 `skills` 开关（经 `read` 读取 `mcp-skill://` 并做摘要与大小校验）；后台建连不阻断启动（`degraded` 告警与自动恢复）、全部热应用（受影响会话停跑并自动续跑）；废弃 `mcp.servers[].required` | `guides/tools.md`、`guides/chats.md`、`guides/troubleshooting.md`、`configuration/mcp.md`、`configuration/telegram.md`、`developer/http/configuration.md`、`developer/extensions.md` |
| Invocation 批改、失败续跑与实时刷新 | 新增 **Reviews（批改）** 浏览器本地草稿（支持单条时间线事件与整体评价、跨标签同步、按「调优机器人 / 开发者反馈」导出带结构化 JSON 尾块的 Markdown 提示词交给 Coding Agent）；新增失败运行 **Resume** 真实续跑（`POST /api/invocations/:id/resume`，`write+paid`）；Invocations 列表与详情页新增实时**自动刷新**（默认开）与详情页**自动滚动到底部**（默认关） | `guides/tuning.md`、`guides/agent-assisted.md`、`guides/troubleshooting.md`、`guides/admin.md`、`developer/http/audit.md` |
| 群聊记忆 30 小时制与吞吐优化 | 新增 `group_memory.thirty_hour_clock`（`off` / `non_overlapping` / `overlapping`）、后台回填通道与批次状态展示、事件按字段编辑 | `guides/knowledge.md`、`configuration/telegram.md`、`developer/http/configuration.md`、`developer/http/data.md` |
| 贴纸集管理、生图参考素材与工作台升级 | Telegram 组新增 **Bot sticker sets** 页（热管理 `telegram.sticker_sets` 别名/备注与索引进度）；媒体组独立呈现 **Image assets（生图素材）** 页，支持编辑关键词与「Agent 可用」可见性开关（开启后跨会话可供聊天 Agent 搜索并引用为参考图）以及 **AI 提取**（`POST /api/image/images/:id/extract`，`write+paid`）；工作台改为提示词内联 `{{image:素材 ID}}` 占位符并按序展开为「图 1 / 图 2」；聊天支持要求原图时以文件发送；`backup` 同步快照 `<data_dir>/images` 为 `.images/` 目录 | `guides/images.md`、`guides/chats.md`、`guides/maintenance.md`、`configuration/telegram.md`、`configuration/storage.md`、`developer/http/configuration.md`、`developer/http/playground-images.md` |
| Web Fetch 看图与搜索时效性 | `web_fetch` 保留页面图片链接并支持继续拉取 JPEG/PNG/WebP（最大 20 MiB，可选 `referer`）供多模态模型直接查看；`web_search` 强化时效性优先引导 | `guides/tools.md`、`configuration/web-fetch.md` |
| 保留清理、废弃字段与分页 | `serve` 启动时与每 24 小时自动执行保留清理，`retention.online_days` 热应用；新增 `deprecated.ts` 三项兼容废弃字段告警；Admin 列表接口采用 `offset` + `as_of` 快照分页 | `guides/maintenance.md`、`configuration/storage.md`、`configuration/lifecycle.md`、`developer/http/index.md` |
| 面板 Koi 迁移与四语言 RTL | 前端迁至 Vite + React 19 + Koi（Panda CSS），导航统一由 `src/nav.ts` 驱动；支持 English / 简体中文 / Deutsch / العربية（含完整 RTL 布局）；移除 config.jsonc 键名显示开关 | `guides/admin.md`、第 3.3 节、第 7.1 节 |
| 多 IM Host 解耦基础 | 存储、身份、配置投影（`projection.ts`）与入库（`ingress/intake/`）按 `HostKind` 解耦，当前仍仅开放 Telegram 与 Playground | `developer/extensions.md` |

## 3. 实际用户路径、概念和面板流程

### 3.1 建议的首次成功路径

以下步骤所需能力已经存在；把它们整理为连续教程、提供最小启动示例，属于待实施工作。

| 阶段 | 用户操作 | 成功标准 |
| --- | --- | --- |
| 安装 | 准备 Compose、数据目录和基础配置，开放回环面板端口 | 服务启动（日志见 `admin_started`） |
| 初始化与登录 | 在服务器 shell 运行 `pairing create --web` 生成一次性登录码（自动建无密码 `admin`），在登录页点「使用一次性码登录」；进入后在 Settings 设置用户名/密码，可选配 `public_url` 与 Passkey（亦支持停机用 `admin-account` 离线建号） | 登录成功，进入面板并留有持久登录方式 |
| 接入模型 | 在 **Providers** 新建 Provider 并获取模型（自动匹配 `models.dev` 元数据、必要时补全待确认项，可填 `nickname`），再在 **Models** 页（或「用作 / Use as」）选择 Agent 模型和 thinking，并可用健康检查验证回复 | 保存并应用成功，Agent 模型设置完整且健康检查返回文本 |
| 创建人设 | 在 **Prompts** 编写全局人格并保存 | 能读回当前正文和版本 |
| 首次试用 | 在 **Playground** 建房、选身份、发消息、Release | 有运行记录，能区分发送、主动沉默和失败 |
| 接入 Telegram | BotFather 建 Bot，在 **Telegram** 页设置 Token（写入 Keychain），在 **Chats** 添加允许的 Chat（或用管理员命令 `/allowlist`） | 连接正常，允许的消息入库并产生预期运行 |
| 调优 | 按费用、参与频率（含 `ask_only`、自适应批次时间、Decisions 入场闸门先 `shadow` 再 `enforce`）和回复表现调整；可在运行详情做 **批改（Reviews）** 导出交给 Coding Agent，或在失败后按需 **Resume** 续跑 | 用审计、闸门判断记录、批改记录和用量比较，不只看保存成功 |

依据：[Provider 新建与模型选择 E2E](../../apps/admin-next/e2e/08-models-adding.e2e.ts)、[Telegram Token 处理](../../src/ingress/admin/telegram.ts)、[Prompt 文件创建](../../src/ingress/admin/prompts.ts)、[配对与客户端 CLI](../../src/ingress/admin/clients/cli.ts)。

实施阶段应增加完整的新手流程验收，验证空部署配置经 `pairing create --web` 首次登录到第一次 Playground 输出能够连贯完成。本轮没有执行该验收。

### 3.2 核心概念

| 概念 | 当前实现关系 | 面向普通用户的表达 |
| --- | --- | --- |
| 塑料碗 Harness 实例 | 一个部署进程及配置、数据；项目本身是人设无关的 Harness 服务端 | 你部署的这套 Bot 运行框架与服务 |
| Telegram Bot | 单个可选 Token，连接可启停或更换 | Telegram 里与你互动的账号 |
| 人设 | 全局人格文件，加每 Chat 附加指令 | 它是谁、怎样说话、怎样参与 |
| Provider | 连接方式、凭据、协议及显式启用的模型 | 模型服务来源 |
| 模型与昵称 | Provider 下的模型及能力、窗口、成本等元数据；可选 `nickname` 仅用于 Telegram 命令展示 | 实际思考和生成的模型，以及群里可见的简称 |
| Agent / Vision / Tool Model | 主模型、独立图片分析模型、辅助任务模型（辞典融合、群聊记忆整理、MCP 描述起草、素材 AI 提取） | 聊天、细看图片、后台辅助处理的分工 |
| Decisions 入场闸门 | 在批次交给主模型前先问小决策模型值不值得回复，支持 `shadow` 观察与 `enforce` 拦截 | 省钱防刷屏的前置筛选闸门 |
| Keychain（`key.json`） | 与配置同目录的命名密钥仓库，配置文件仅写 `{ "jar": "<name>" }` 引用，可共用与原地轮换 | 存放 Token 和 API key 的本地钥匙串 |
| Chat / Topic | Chat 允许范围及覆盖配置（模型、参与/`ask_only`、主动回复、入场闸门、群聊记忆、MCP 绑定）；Topic 继承 Chat 配置但隔离对话 Context | 在哪些地方活动、是否有当地规则 |
| Context / Memo / 群聊记忆 / 辞典 | 连续对话、持久条目、按日期整理事件（支持 30 小时制检索）、术语知识 | 当下聊天、记下的事、过去发生的事、专有词 |
| Alarm 与循环闹钟 | Alarm 为对话中 Bot 自建的一次性稍后提醒；循环闹钟为管理员在面板设定的周期可信提示词任务 | 群友托付的一次性提醒 vs 管理员排好的定时任务 |
| 出站 MCP 与反向 MCP | 出站 MCP（`mcp.servers`，支持直接或渐进式 `mcp` 网关与 `mcp-skill://`）给 Bot 调用外部工具，可按 Chat 收窄；反向 MCP（`/mcp`）给外部 Coding Agent 管理塑料碗 | Bot 往外接的工具 vs 让外部 Agent 来管塑料碗的入口 |

没有发现独立人设库、角色卡导入或多 Bot 管理实体。「你的第一个人设」可以作为教程标题，但应描述当前 Prompt 工作流，不能画出不存在的角色管理页面。

依据：[根 Schema](../../src/platform/config/schema.ts)、[配置分段](../../src/platform/config/schema-sections.ts)、[模型和密钥 Schema](../../src/platform/config/schema-model.ts)、[默认及覆盖](../../src/platform/config/resolve.ts)。

### 3.3 Admin Panel 的任务导航

按当前真实导航（7 组 32 页）按用户任务归类：

| 用户任务 | 页面 |
| --- | --- |
| 看运行状态、批改与查失败 | Overview、Warnings、Invocations（含实时自动刷新、详情自动滚动、批改与失败 Resume）、Reviews、Contexts、Messages |
| 配置人格、模型与工具 | Models、Providers、Prompts、Harness、Entry gate（`/decision-gate`）、MCP servers、Search settings |
| 接入和管理 Telegram | Telegram（含 Token 与消息批次时间）、Chats（含活跃时段/`ask_only`、主动回复、入场闸门覆盖、群聊记忆、MCP 绑定）、Bot admins、Bot sticker sets |
| 管理知识与提醒 | Memories、Group memories、Dictionary、Alarms、Recurring alarms |
| 图片处理与素材 | Image generate、Image generations、Image assets（含 Agent 可见性与 AI 提取）、Image settings |
| 试验与系统维护 | Playground、API keys、Keychain、Developer（含 `models_dev` 目录源）、Settings、Preferences |

依据：[真实导航定义](../../apps/admin-next/src/nav.ts) 和 `apps/admin-next/src/routes/`。

不必每个路由各写一篇。指南只解释任务需要的页面，字段、权限、错误及精确请求放在参考页。Invocation 重放目前没有独立页面入口，按 CLI/API 工作流说明；Invocation 批改（Reviews）则完全在浏览器本地 `localStorage` 中运行，没有后端存储接口。

### 3.4 已澄清：人设设计与真实平台接入的边界

2026-11-06，维护者明确两篇入门教程的不同目标：前者教设计自己 Bot 的行为、口癖，并在虚拟群聊试聊；后者教接入真实平台。当前真实平台只有 Telegram，不因此引入尚未实现的平台接入能力。

| 文档 | 读者要完成什么 | 主要内容 | 完成标准 |
| --- | --- | --- | --- |
| 你的第一个人设 | 设计并试验 Bot 的行为 | 身份与关系、行为倾向、口吻与口癖；写入 Prompt；在虚拟群聊构造场景、试聊、修改 | 在虚拟群聊得到基本符合预期的表现 |
| 你的第一只 Bot | 把已试好的人设接入真实平台 | 创建 Telegram Bot、设置 Token、消息可见性、Chat/Topic 允许范围、首次真实互动 | 在允许的真实聊天中收到消息并完成互动 |

人设教程围绕「写一份简短人设 → 试几个场景 → 找出不符合预期的表现 → 修改再试」展开。重点是行为设计和反馈迭代，不以长 Prompt 或编辑器功能清单作为入门目标。只介绍完成试聊所需的 Playground 操作；房间、重试、媒体等完整操作仍由 Playground 专题承载。

真实平台教程复用已有的人设和模型，链接回前篇，不重复教学。重点补充真实环境特有的问题：群友互动、平台权限、允许范围，以及虚拟群聊成功后真实群仍可能不回复的排查入口。标题可保留「你的第一只 Bot」，描述建议为「把试好的人设带进 Telegram」。

两篇的共同前置条件是面板可用、已选好可运行的 Agent 模型。前置准备集中在安装流程，完整模型接入操作由「接入和更换模型」承载；两篇均不重复 Provider 配置。该安排同步替换本规划原先将首次模型连接纳入人设教程的建议，整体规划的其他待确认事项保持待确认。

### 3.5 已澄清：双语文档、默认路径、内置手册语种与 Playwright 双语截图范围

2026-11-23，维护者明确了文档语种、站点默认路径、镜像内置手册语种与截图自动化的范围：

- **文档语种**：目前只做 **简体中文（`zh-CN`）** 与 **English（`en`）** 两种语言的公开文档，不同步建设德语、阿拉伯语等其他语言文档站。
- **默认根路径**：站点默认根路径走 **简体中文（`zh`）**，英文文档挂载在 `/en/` 前缀下（延续既有中文站点的根路径体验，也减少旧中文 URL 重定向跳转）。
- **镜像内置手册语种**：打包进运行时镜像供 Bot 按需读取的用户手册（`src/manual/`）仅打包 **English（`en`）** 版本，不同时塞入中文重复页，控制索引长度并便于各类模型按需检索。
- **截图方式**：在编写文档阶段使用 **Playwright** 等自动化方式直接从构建后的真实 Admin Panel 截取页面与对话框截图，不手工截屏或拼接假图。
- **截图语种**：虽然 Admin Panel 自身提供四种界面语言（English、简体中文、Deutsch、العربية），文档自动化截图**只需截取简体中文（`zh-CN`）与 English（`en`）两种版本**，分别供中文文档与英文文档引用。

对应的结构与构建约定：

- Rspress 2 启用原生双语 `locales`（默认根语言 `lang: 'zh'`，英文路由前缀 `/en/`，配 `apps/docs/i18n.json`），两套语言共享同一套目录树、页面路径、`examples/` 与 `config.schema.json`，避免中英文路径分叉。
- 自动生成的配置字段参考（`prepare.ts`）与接口目录生成同时输出 `zh` 与 `en` 两套产物，确保任一语言不缺字段页。
- `manual-prepare.ts` 固定从 `en` 源文档目录打包 `src/manual/`，`src/platform/prompts/2-product-knowledge.md` 的手册路径与意图索引同步对齐英文手册。
- Playwright 截图脚本在同一批场景定义下按 `['zh-CN', 'en']` 双语矩阵执行，通过 `admin-language` 切换面板语言并加载对应语言的虚构合成数据（群名、人设、消息、备注），避免「英文界面里塞中文假消息」或反过来。
- 文档校验（dead-link、dead-image、搜索、`llms.txt`/`llms-full.txt` 与双 base 构建）覆盖 `zh`（根路径）与 `en`（`/en/`）两条路径。

## 4. 建议目录树

以下为单个语言根目录（`apps/docs/content/<locale>/docs/`，其中 `<locale>` 为 `zh` 与 `en`；站点构建后 `zh` 挂在默认根路径，`en` 挂在 `/en/`；`src/manual/` 仅从 `en` 目录打包）下的统一结构。首页为入口，不增加第四个顶层分类；公共静态下载示例、JSON Schema 与双语截图资产统一放在 `apps/docs/content/public/` 下由双语正文按 `__DOCS_BASE__/` 引用。

```text
index.md                              使用文档：选择你的任务

guides/                               指南
├── index.md                          从这里开始
├── installation.md                   安装与首次登录
├── first-persona.md                  你的第一个人设
├── first-bot.md                      你的第一只 Bot
├── tuning.md                         按表现和费用调优
├── agent-assisted.md                 让你的本地 Agent 帮你调整塑料碗
├── models.md                         接入和更换模型
├── playground.md                     用虚拟群聊试验人设和工具
├── chats.md                          为不同群和话题设置边界
├── knowledge.md                      管理记忆与辞典
├── images.md                         看图、Sticker 与图片生成
├── tools.md                          开启搜索、定时任务与外部工具
├── admin.md                          管理面板、密钥与访问安全
├── maintenance.md                    升级、备份与恢复
└── troubleshooting.md                排查启动失败和不回复

configuration/                        配置文件参考
├── index.md                          配置格式、查找与最小示例
├── lifecycle.md                      默认、继承、应用、重启与废弃字段
├── secrets.md                        SecretRef、Keychain 与路径规则
├── telegram.md                       Telegram、Chat 与 Topic
├── providers.md                      Provider 与模型定义
├── models-dev.md                     模型元数据目录（models_dev）
├── agent.md                          Agent
├── vision.md                         Vision
├── tool-model.md                     Tool Model
├── image.md                          图片生成
├── dictionary.md                     辞典
├── web-search.md                     网络搜索
├── web-fetch.md                      网页读取
├── mcp.md                            Bot 连接的外部 MCP
├── admin.md                          Admin Panel 服务
├── developer.md                      调试记录
└── storage.md                        数据路径与保留

developer/                            开发者参考
├── index.md                          接口选择、版本与支持边界
├── http/
│   ├── index.md                      HTTP 鉴权、配对签名与公共约定
│   ├── audit.md                      审计、续跑、查询与导出
│   ├── configuration.md              模型、Prompt、Chat、闸门、MCP 与配置管理
│   ├── data.md                       Memo、辞典、群聊记忆与闹钟
│   └── playground-images.md          虚拟群聊与图片接口
├── mcp-server.md                     外部 Agent 使用的 MCP Server
├── service-cli.md                    服务端 CLI
├── client-cli.md                     surowan-utils
├── replay.md                         Invocation 预检与重放
├── telegram-commands.md              Telegram 命令
└── extensions.md                     System Skills、插件与多 IM 扩展边界
```

活跃时段、`ask_only`、自适应批次时间、主动回复、Decisions 入场闸门、预算、睡眠、发送规则、批改与续跑首先服务「调优」与「群聊边界」，循环闹钟与出站 MCP 服务「搜索、定时任务与外部工具」，不各自新增零散指南。配置页保留精确字段入口，新增 `configuration/models-dev.md` 与 `ConfigSchema` 顶层段保持 1:1 对应。

## 5. 逐篇文档清单

### 5.1 代码依据缩写与维护约定

| 缩写 | 事实来源 |
| --- | --- |
| C | `src/platform/config/{schema,schema-sections,schema-model,deprecated,resolve,validate,semantics,semantics-decision-gate,projection,index}.ts` |
| L | `src/platform/config/{diff,diff-merge,diff-providers}.ts`、`src/adapters/local-monolith/config/` |
| P | `src/ingress/admin/` 对应业务及 `routes/`，`apps/admin-next/src/{nav,pages/,routes/}` 和对应 E2E |
| H | `packages/admin-surface/src/specs/`、`types.ts`，实际 HTTP handler（含 Session-only 的 `routes/keychain.ts` 与 `routes/auth.ts`） |
| M | `src/ingress/admin/mcp/{index,tools,skills}.ts` |
| CLI | `src/cli.ts`、`src/cli-options.ts`、`src/ingress/admin/clients/cli.ts`、`packages/cli/src/` |
| X | `src/plugins/{plugin,builtin}.ts`、`src/system-resources/`、插件 Skills、`src/capabilities/mcp/`、`src/platform/im-host/`、`src/ingress/intake/` |
| D | `scripts/docs/`、`scripts/manual-prepare.ts`、文档测试及构建配置 |

「混合维护」表示字段或接口表自动生成（同步输出 `zh` 与 `en` 两套）、解释与示例人工维护，不把生成结果复制进手写正文。下文每篇均提供简体中文与 English 两个版本。

### 5.2 指南

| 标题与路径 | 读者、问题及主要内容 | 依据、素材、维护与处理方式 |
| --- | --- | --- |
| 从这里开始 `guides/index.md` | 新用户：说明塑料碗 Harness 定位，选择首次安装、已有实例或排障路径；只解释必要概念 | 现有文档首页、README、C；无截图；双语人工；重写 |
| 安装与首次登录 `guides/installation.md` | 自部署用户：Docker 主路径、基础文件、端口；服务器 `pairing create --web`（含 Docker `exec -u surowan`）一次性码首次登录与补设密码/Passkey（或离线 `admin-account`）；引导选好可运行的 Agent 模型；宿主机次路径 | installation/quick-start/admin、Compose、CLI、模型指南；配置、命令、登录页一次性码双语截图；双语人工；合并重写 |
| 你的第一个人设 `guides/first-persona.md` | 人设设计新手：设计身份、行为、口吻与口癖，写入 Prompt，在虚拟群聊试聊并迭代 | personality/admin-prompts/playground、C/P；人设及试聊场景示例、Prompt/试聊双语截图；双语人工；重写 |
| 你的第一只 Bot `guides/first-bot.md` | 已试好人设的用户：接入真实平台（当前 Telegram），BotFather、Token、收消息条件、Chat ID、allowlist（或 `/allowlist`）、`/help` 验证、真实互动验证 | telegram、P、Telegram ingress；空 Token 表单、连接状态、Chat 双语截图；双语人工；重写 |
| 按表现和费用调优 `guides/tuning.md` | 已运行用户：按太吵、太慢、太贵、不接话选择调整；涵盖自适应消息批次时间（window/bump/max）、**Decisions 入场闸门（先 `shadow` 观察一周再 `enforce` 拦截、与主动回复抽样及预算的关系、豁免范围）**、Harness 预算与发送保护、主动回复、利用 **Reviews（批改）** 逐条标注运行事件并导出、失败运行的 **Resume** 续跑 | budgets/participation/proactive-replies/entry-gate/harness/admin-invocation-review、C/L/P；片段、批次/入场闸门/预算/批改/续跑双语截图；双语人工；合并重写 |
| 本地 Agent 协助 `guides/agent-assisted.md` | Coding Agent 用户：对比 SSH 一次性配对（`pairing create` + `surowan-utils auth pair`，Ed25519 私钥签名不暴露长期凭据、支持预绑定公钥与撤销）、API key 与 MCP Server；承接 **Reviews** 导出的批改 Markdown；先读后给变更方案、应用核对 | agent-assisted/admin-agent-pairing/admin-invocation-review、两套外部 Skill、M/CLI/H；客户端配置、配对流程、key 模式双语截图；双语人工；合并重写 |
| 接入和更换模型 `guides/models.md` | 管理员：区分 **Providers**（维护连接、自动获取模型、按 `models.dev` 补全与最高价回退、自定义 `models_dev` 镜像、设 `nickname`、批量健康检查并查看模型原话回复）与 **Models**（Agent/Vision/Tool Model 角色分配与思考强度，统一保存栏、切换中止旧会话确认） | models/admin-developer、C/P；Providers/Models 双页、模型拉取与健康检查双语截图；双语人工；重写 |
| 虚拟群聊试验 `guides/playground.md` | 人设作者：身份、Hold/Release、回复与沉默、失败重试（与 Telegram 的 Resume 区分）、生图费用边界、作为循环闹钟的试运行目标（且不经入场闸门） | playground、P、Playground runtime；待处理/完成双语截图；双语人工；迁移修订 |
| 不同群和话题 `guides/chats.md` | 群管理员：范围、模型与指令覆盖、时区、忽略名单、活跃时段与 **`ask_only` 仅 `/ask` 唤起**、主动回复、**每群 Decisions 入场闸门覆盖**、**每群 MCP 绑定与 Tool 收窄**、快捷跳转带 `?chat=` 参数、移除与删除区别 | per-chat/telegram/participation/entry-gate/extensions、C/L/P；Chat 编辑/时段/ask-only/入场闸门覆盖/MCP 绑定双语截图、配置；双语人工；合并 |
| 管理记忆与辞典 `guides/knowledge.md` | 管理员：按用途选择 Context/Memo/群聊记忆/辞典；群聊记忆补齐 **30 小时制（`thirty_hour_clock`）**、整理进度与回填通道、按字段编辑与批次排查；辞典冲突、AI 融合与导入导出 | memory/dictionary、相关 store/插件/P；局部双语截图（含 30 小时制设置与进度）、导入示例；双语人工；合并重写 |
| 看图、Sticker 与图片生成 `guides/images.md` | 图片用户：直接图片输入、Vision、Telegram **贴纸集管理（Bot sticker sets 昵称/备注/索引进度）**、图片生成设置/工作台（提示词内联 `{{image:素材 ID}}` 按序展开）/记录/**生图素材（Image assets，含关键词、「Agent 可用」开关与 AI 提取）**、聊天中请求原图文件发送与备份配对 | images/telegram、C/P、image-service；设置/工作台/记录/素材（含 AI 提取）/贴纸集双语截图、配置；双语人工；重写 |
| 搜索、定时任务与外部工具 `guides/tools.md` | 高级用户：网络搜索（含时效性使用与 URL 过滤）、**循环闹钟（Recurring alarms，区别于 Bot 一次性 Alarm）**、**出站 MCP 管理页（HTTP 增改删、stdio 只读、直接暴露 vs 渐进式 `mcp` 网关与工具模型起草描述、`mcp-skill://` 开关、后台建连/`degraded` 降级与按群绑定）**、`web_fetch` 网页读取与查看网页图片（JPEG/PNG/WebP、referer）及授权边界 | web-search/recurring-alarms/extensions、C/X/P、MCP client/Alarm；搜索/循环闹钟/MCP 服务器页双语截图、配置示例；双语人工；合并重写 |
| 管理面板、密钥与访问安全 `guides/admin.md` | 运维者：入口、任务地图、远程访问、无网页建号与一次性码登录（`pairing create --web`）、密码锁定（按 TCP 对端地址）、Passkey 与 `admin-account` 恢复、**Keychain（密钥）页**查看/新建/原地轮换/孤儿清理、Invocation 列表/详情实时自动刷新与自动滚动、四语言与阿拉伯语 RTL 偏好 | admin/api-keys/admin-keychain、P/CLI；导航、登录一次性码、Keychain 与 Passkey 双语截图；双语人工；合并重写 |
| 升级、备份与恢复 `guides/maintenance.md` | 运维者：标签、升级、`key.json` 自动迁移与废弃字段清理、**`serve` 启动与每 24 小时自动保留清理**、`backup` 同步快照 SQLite 与 `.images/` 目录、停机恢复及隔离检查 | upgrade/backup-restore、CLI、数据库/图片/镜像流程；命令与目录，无强制截图；双语人工；合并 |
| 排查问题 `guides/troubleshooting.md` | 所有用户：启动、面板、配对与签名错误码、模型、图片、Decisions 入场闸门拦截（`decision_gate_dropped`）与密钥未解析放行（`secret_unresolved`）、出站 MCP `degraded` 与 `mcp_description_missing` 告警、群聊记忆批次失败、废弃字段告警、不回复与失败运行 **Resume**；按证据分流 | troubleshooting/entry-gate/admin-agent-pairing/extensions、P/CLI、运行及审计；失败状态/Resume/MCP 降级/工具审计双语截图；双语人工；重写 |

安装流程引导读者完成一次性码首次登录与可运行模型的准备，完整 Provider/Models 操作集中于模型指南。首个人设与首只 Bot 共享此前置，不重复模型接入；两篇职责见 3.4。调优引用配置参考解释数值，不重新维护字段全集。

### 5.3 配置文件参考

每个字段应能检索到完整路径、类型、相对必填性、枚举/范围、缺省行为、启用条件、覆盖关系、生效方式、示例及代码来源。此分类不需要 Admin 截图；自动生成的字段页与人工解释均提供 `zh` 与 `en` 两套。

| 标题与路径 | 读者的问题及主要内容 | 依据、示例、维护与处理方式 |
| --- | --- | --- |
| 配置入口 `configuration/index.md` | 手改配置者：JSONC、未知字段、版本、必填段、全部顶层段索引（含 `models_dev`）、最小完整示例、Schema 下载 | C/D、config-file/config/fields；完整配置；双语混合；重写 |
| 配置生命周期 `configuration/lifecycle.md` | 管理员：缺省与 null、继承、文件/运行快照、显式应用、部分应用、热应用（含 MCP、入场闸门、自适应批次、贴纸集、删除 Chat、`retention.online_days`、`models_dev`、Keychain 轮换）与重启边界、Prompt 影响、**废弃兼容字段清单与告警** | C/L、deprecated.ts、config-file；行为矩阵及前后示例；双语人工；合并重写 |
| 密钥与路径 `configuration/secrets.md` | 运维者：三种 SecretRef、**Keychain（`key.json`）命名/共享/原地轮换/孤儿清理/旧格式迁移**、解析失败、权限、路径基准；文件与输入接口的区别 | schema-model/keychain/secrets/loader、admin-keychain；安全片段；双语混合；抽取重写 |
| Telegram `configuration/telegram.md` | 高级用户：Token、**自适应聚合窗口（`bucket_window_seconds`/`bucket_max_seconds`/`bucket_bump_seconds` 及与 `idle_grace_seconds` 约束）**、**`decision_gate` 与 `chats[].decision_gate`（含私聊禁止与密钥必填约束）**、Chat/Topic、管理员、**`sticker_sets`（alias/name/note）**、参与策略（含 `ask_only`）、主动回复、群聊记忆（含 `thirty_hour_clock`）、**`chats[].mcp` 按群绑定**、忽略名单 | C/L；字段和覆盖示例；双语混合；重组生成内容 |
| Provider `configuration/providers.md` | 接入者：builtin/custom、API、模型元数据、**`nickname`**、`compat`、`tool_schema_keywords`、`thinking_levels`、成本 | C、providers/thinking-levels；两种 Provider 示例；双语混合；重组补语义 |
| 模型目录源 `configuration/models-dev.md` | 管理员/镜像部署者：`models_dev.api_url` 合法性约束（无凭据与片段、兼容 JSON 格式）、缺省与热生效 | C、admin-developer；镜像配置片段；双语混合；新增 |
| Agent `configuration/agent.md` | 调优者：身份三元组、预算、发送、Context、并发限流、废弃字段（`memory_ttl_warning_days`、`send_empty_text_fallback_enabled`）与替代项 | C/L、deprecated.ts、消费代码；字段组合；双语混合；重组 |
| Vision `configuration/vision.md` | 图片管理员：模型对、**`thinking_level`** 缺省规则、独立预算并发、缺省不可用状态、废弃字段（`background_sticker_concurrency`） | C、deprecated.ts、媒体/Vision；最小启用示例；双语混合；重组 |
| Tool Model `configuration/tool-model.md` | 辅助任务用户：配置、继承全局 Agent、不跟随 Chat 覆盖 | C、辅助模型解析/辞典融合/群聊记忆整理/MCP 描述起草/素材 AI 提取；示例；双语混合；新增完整参考 |
| 图片生成 `configuration/image.md` | 图片管理员：credentials、模型（含 `description` 备注）、capabilities、领域校验、禁用降级 | C、image-service、热加载；示例；双语混合；重组补充 |
| 辞典 `configuration/dictionary.md` | 管理员：注入模式及 Chat 覆盖 | C、dictionary 插件；示例；双语混合；新增集中参考 |
| 网络搜索 `configuration/web-search.md` | 管理员：开关、引擎、服务商、密钥/endpoint、URL 正则过滤（RE2）和默认 | C、web-search/搜索插件；示例；双语混合；抽取重写 |
| 网页读取 `configuration/web-fetch.md` | 高级运维者：Markdown 协商、代理 fake-ip 与全 IP 放行风险、**图片拉取格式/大小上限与 `referer` 边界** | C、web-fetch 实现；示例；双语混合；新增 |
| 外部 MCP `configuration/mcp.md` | 集成者：stdio/HTTP、allowlist、policy、超时、载荷和结果上限、**`exposure`（`direct`/`progressive`）、`description`、`skills` 开关**、**后台建连与 `degraded` 降级、热应用与受影响会话自动续跑、与 `chats[].mcp` 收窄关系、`required` 废弃说明** | C、MCP client；两种 transport、渐进式与每群绑定示例；双语混合；抽取重写 |
| Admin `configuration/admin.md` | 运维者：host/port/TTL/static/public_url、启用、Passkey RP 限制与重启 | C/P；示例；双语混合；重组 |
| 调试记录 `configuration/developer.md` | 排障者：payload/thinking 开关、缺省、批量清除行为和生效范围 | C/L/P；示例；双语混合；迁移扩充 |
| 数据与保留 `configuration/storage.md` | 运维者：根级标量、paths、retention（含 `warning_read_days` 与 `online_days` 热应用）、**`serve` 与 `backup` 保留清理时机**、清理对象与 **`.images/` 备份目录** | C、backup/清理实现；目录和配置；双语混合；合并新增 |

短配置段可短写，不要求每篇同样篇幅。

### 5.4 开发者参考

| 标题与路径 | 读者的问题及主要内容 | 依据、示例、维护与处理方式 |
| --- | --- | --- |
| 接口入口 `developer/index.md` | 集成者：何时选 HTTP/MCP/CLI（及配对签名 vs API key），版本匹配（`/api/version`），公开契约与内部模块边界 | H/M/CLI/X；关系表；双语人工；新增 |
| HTTP 公共契约 `developer/http/index.md` | API 调用者：基地址、Session/Bearer API key/**已配对客户端 Ed25519 请求签名**（`instance_id`/body 摘要/±300s 时钟窗口/防重放 nonce）、四种权限模式、Session-only 边界（Auth/API keys/**Keychain**）、Origin、ID、**`offset` + `as_of` 快照分页**、revision、错误（含 `pairing_*`/`signature_*`）、计费重试 | H、AdminServer/auth/http/api-keys/clients；curl、签名约定、成功失败 JSON；双语混合；新增 |
| 审计、续跑与导出 `developer/http/audit.md` | 审计工具作者：Overview/Usage/Warnings/Invocation/消息/Context/Sticker/媒体、过滤（含 `model`/`host`）、快照与 **`POST /api/invocations/:id/resume`**（`write+paid` 真实续跑） | H audit/control、inspection/audit；请求响应；双语混合；抽取补齐 |
| 配置、闸门与工具管理 `developer/http/configuration.md` | 管理工具作者：Provider/模型（含 `model_in_use` + `abort_running` 与批量删除）/Prompt/Chat（含 `participation` 含 `ask_only`、`proactive-reply`、**`chats/:id/decision-gate`**、`group-memory` 含 30 小时制、**`chats/:id/mcp`**）/Harness/**`decision-gate`（show/update/decisions）**/搜索/Telegram（含 **`telegram/bucket-timing`**）/**`sticker-sets`**/**出站 `mcp-servers`**（HTTP 建改、stdio 限制、`exposure`/`description`/`skills`、付费 **`description-draft`**、删除解绑）/Developer（含 `models_dev_url`），注明 **`/api/keychain*` 为 Session-only 面板内部接口**，冲突和应用失败 | H/P/L；写入与冲突示例；双语混合；新增 |
| 知识与闹钟数据 `developer/http/data.md` | 数据工具作者：Memo/Blob/辞典/群聊记忆（含按字段编辑）/一次性 Alarm/**循环闹钟（`recurring-alarms` 列表、targets、preview、CRUD 与 `run` 及 `write+paid` 权限）**，作用域、revision、导入导出和删除 | H/P；请求响应、导入格式；双语混合；新增 |
| 虚拟群聊与图片 `developer/http/playground-images.md` | 自动化客户端作者：身份、Hold/Release/重试、上传、生成取消输出和资产（含 **`image/images/:id` 关键词与 Agent 可见性更新**及付费 **`image/images/:id/extract` AI 提取**） | H/P、image-service；状态及请求响应；双语混合；新增 |
| MCP Server `developer/mcp-server.md` | 外部 Agent/Harness 作者：`/mcp`（仅接受 Bearer API key，不接受配对签名）、协议分支、参数、权限、已纳入的新 spec 工具（`decision-gate`、`recurring-alarm`、`mcp-server` 含 `describe`、`sticker-set`、`image asset extract`、`invocation resume`、`chat mcp`/`chat decision-gate`、`telegram bucket-timing` 等）与排除项（Auth/API keys/Keychain）、资源/Skills、错误及二进制 | mcp-server、M/H、surowan-mcp Skill；客户端/协议示例；双语混合；重写 |
| 服务端 CLI `developer/service-cli.md` | 运维脚本作者：**八个命令**（`serve`、`check-config`、`doctor`、`backup`、`configure`、`admin-account`、**`pairing` (`create [--web]`/`list`/`cancel`)**、**`clients` (`list`/`revoke`)**），区分需停机的 `admin-account` 与需和 `serve` 共存的 `pairing`/`clients`、Docker `exec -u surowan`、`doctor` 开启入场闸门时实测连通性且对不可达 MCP 仅告警、退出码与 TTY | cli、CLI、doctor/account/clients；命令与 JSON；双语人工加可提取命令表；补全重写 |
| 客户端 CLI `developer/client-cli.md` | 管理脚本作者：安装、两种凭据（`login` API key 与 **`auth init/pair/status/permissions/logout`** 客户端签名及 `client-key.pem` 权限）、凭据优先级、专用命令、通用面板命令（含 `decision-gate`/`recurring-alarm`/`mcp-server`/`sticker-set`/`image asset extract`/`invocation resume`）、body、revision、确认导出 | 三篇 utils 文档 + admin-agent-pairing、CLI/H；命令及 stdout/stderr；双语混合；合并重写 |
| Invocation 重放 `developer/replay.md` | 评估者：预检、当前/历史差异、切片、覆盖、保真限制、计费及无 Telegram 发送（与真实运行的 `resume` 对比） | replay 文档与实现、CLI/M；完整流程和响应；双语人工；迁移重写 |
| Telegram 命令 `developer/telegram-commands.md` | 管理员/集成者：权限、参数、Chat/Topic 作用域、生效失败；补齐 **`/help`**（按角色与忽略状态动态过滤）、**`/ask`**（匿名/频道、已忽略成员例外、ask-only 0 秒 Bucket）、**`/model`**（昵称展示与立即终止旧模型会话回执）与 **`/effort`**、启动积压命令处理边界 | telegram/participation、bot-commands；命令示例；双语人工；抽取补齐 |
| 扩展与多 IM 边界 `developer/extensions.md` | 二次开发者：System Skills（含 `mcp-skill://` 外部 Skill 校验与信任边界）、`execute` 与 `mcp` 渐进式网关、内置 Plugin（含插件依赖与 `web_fetch` 图片能力）、**多 IM Host 解耦边界**（`HostKind`、`platform/im-host/`、`host-profile.ts`、`config/projection.ts`、`ingress/intake/`，明确不承诺未实现的第三方平台）、宿主可用性和权限 | X、host-tooling；最小源码例子；双语人工；重写 |

开发者页主要用协议和代码示例，不依赖截图。HTTP 四组分页在完整 body/response 补齐后按实际大小调整，不一端点一页面。

## 6. 参考自动化方案

### 6.1 配置参考

保留现有生成器，升级为 **双语（`zh` + `en`）输出**，并补齐缺省和语义。当前生成器能遍历对象、数组、动态名称和 union 分支，按顶层段分页（含新增的 `models_dev`），并已输出 `deprecated` 废弃提示，主要输出类型、必填性和部分约束：

- 不输出运行时默认值。
- 尚未覆盖 `maxLength`、`description` 等所有已使用 Schema 元信息，目前生成文案仅硬编码中文，需支持按 `zh`/`en` 双语模板输出。
- 不解释启用条件、覆盖关系及热更新。
- JSON Schema 通过不代表跨字段验证（如 `bucket_max_seconds >= bucket_window_seconds`、`idle_grace_seconds >= bucket_max_seconds`、`chats[].mcp` 引用有效 alias、`decision_gate` 启用时要求全局 `api_key` 且私聊禁止配置）或运行时准备成功。
- `image` 存在结构不合法时警告并禁用的特殊处理，不能写成任何错误均拒绝启动。
- 三个兼容废弃字段（`agent.memory_ttl_warning_days`、`agent.send_empty_text_fallback_enabled`、`vision.background_sticker_concurrency`）与 `mcp.servers[].required` 仍被 Schema 接受但不生效并触发告警，参考页需明确区分「可写但已废弃」。

建议分三层维护：

| 内容 | 推荐来源 |
| --- | --- |
| 字段路径、类型、必填性、范围、枚举、Schema 声明默认与 `deprecated` 标注 | 从 Schema 双语生成（`zh` 与 `en`） |
| Agent/Vision/DecisionGate 等集中默认与 `DEPRECATED_CONFIG_FIELDS` 清单 | 从现有默认常量、废弃清单及解析函数提取，标为运行时缺省或已废弃 |
| 分散默认、条件启用、继承、跨字段限制、用户影响 | 双语人工解释，链接实际解析/消费位置，以行为测试约束 |

不能从示例反推默认：Agent 日预算缺省为 `1_000_000_000` Token，公开示例为 `300000`；`idle_grace_seconds` 缺省为 `0`，公开示例为 `30`；`bucket_bump_seconds` 缺省为 `0`、`bucket_max_seconds` 缺省等于 `bucket_window_seconds`；`decision_gate.threshold` 缺省为 `0.57`、`model` 为 `typesafe/jev-1.14`。主 Agent 身份三项不完整时不运行，不能替用户补模型。Telegram 整段缺省与已写对象内哪些字段必填也应分别说明。

依据：[默认解析](../../src/platform/config/resolve.ts)、[废弃字段](../../src/platform/config/deprecated.ts)、[校验特殊处理](../../src/platform/config/validate.ts)、[生成器](../../scripts/docs/prepare.ts)。

生效方式不能只对字段路径调用 `classify()` 就生成结论：新增/移除 Chat、Prompt 内容变化、Provider 合并、MCP 变更（停跑受影响 Chat 并续跑）、入场闸门热应用以及 Keychain 轮换触发应用都存在专门逻辑。应以 `diffConfig` 的代表性变更结果校验生命周期表。

不为写文档先重构所有默认值。先复用集中常量，对分散行为做有来源的人工补充。

### 6.2 HTTP、MCP 和 CLI

复用 `ADMIN_SURFACE_SPECS` 自动列出 method/path、参数入口、权限、revision 类别、破坏性/计费确认和响应大类（已涵盖新增的 `decision-gate`、`recurring-alarms`、`mcp-servers` 含 `describe`、`sticker-sets`、`image asset extract`、`chats/:id/mcp`、`chats/:id/decision-gate`、`telegram/bucket-timing`、`invocations/:id/resume`）；CLI 通用命令目录使用同一来源。MCP 工具目录从真实 `TOOL_CATALOG` 导出，不重写名称转换、截断和冲突处理。Session-only 路由（含 `routes/keychain.ts`、`routes/auth.ts` 一次性码登录与 Passkey 流程）单独从路由实现核对并标注「仅面板 Session」。服务端 CLI 单独核对 `cli-options.ts`（含 `pairing` 与 `clients`），与 `surowan-utils`（含 `auth`）区分。

必须人工补齐（双语维护）：

- body/response 字段、枚举、单位、可空性。
- 各分页接口默认、`offset` + `as_of` 快照分页含义、过滤组合。
- 错误状态及错误码（含 `pairing_*`、`signature_*`、`model_in_use`、`mcp_server_in_use`、`keychain_*`）。
- 并发冲突、保存但未应用、中止旧会话（`abort_running`）、取消、结果未知。
- 上传、导出、二进制和大小限制。
- `read`、`read_write`、`read_paid`、`all`（以及 `write+paid` / `paid` 端点如循环闹钟创建/编辑/立即执行、`invocation resume`、`mcp-server describe`、`image asset extract`）各自的操作范围。

区分服务端权限、CLI/MCP 的 `--yes`/`confirm`/`dry_run`、Skill 用户确认流程。不能把客户端确认参数写成所有 HTTP 接口统一接收的字段，也不能混淆 MCP `isError` 和 JSON-RPC 协议错误。

OpenAPI 暂缓作为前置条件。当前没有找到完整 OpenAPI/Swagger 生成链。第一阶段生成准确目录并补关键请求响应；若明确承诺第三方 SDK，再逐步共享边界 Schema 并输出 OpenAPI。

## 7. 自动化截图方案

### 7.1 复用现有 Playwright 和真实面板（简体中文 + English 双语）

Admin Panel 已完成 Koi 设计系统迁移，当前技术栈为 **Vite + React 19 + Koi（Panda CSS）+ TanStack Router/Query** 与 `@playwright/test`。编写文档阶段将通过独立的 Playwright 截图套件，使用构建后的真实 SPA、真实 AdminServer、临时 SQLite、双语合成数据及本地 Provider 替身自动生成截图（仓库另有 `pnpm run admin:dev:mock` 用于本地快速预览，但文档截图基于真实 AdminServer 与临时 SQLite，以保证接口与交互真实）。

**已确认语种边界**：仅截取 **简体中文（`zh-CN`）** 与 **English（`en`）** 两个版本，覆盖文档站的双语需求；不截取德语（`de-DE`）与阿拉伯语（`ar` RTL）。

依据：[Playwright 配置](../../apps/admin-next/playwright.config.ts)、[服务启动](../../apps/admin-next/e2e/server-boot.ts)、[数据及 Faux runtime](../../apps/admin-next/e2e/server-fixtures.ts)、[已有截图](../../apps/admin-next/e2e/19-harness.e2e.ts)、[MCP Servers E2E](../../apps/admin-next/e2e/37-mcp-servers.e2e.ts)。

| 环节 | 建议实现 |
| --- | --- |
| 启动 | 构建图片包及 SPA，派生独立文档截图 Playwright 入口（例如 `pnpm run docs:screenshots`）；随机回环端口，ready 日志判断就绪，结束关闭 |
| 双语矩阵 | Playwright 设两个固定项目/参数组合：`zh-CN` 与 `en`，分别在首次导航前写入 `admin-language`（`zh-CN` / `en`）与 `admin-theme`（`light`），保留原 E2E 套件不受影响 |
| 数据 | 复用 seed/helper，为 `zh-CN` 与 `en` 分别提供对应语言的精简虚构数据（群名、模型昵称、人设、消息、备注、素材名）；固定 ID，保证中英文截图内容与界面语言一致 |
| 登录 | 面板已无网页首次建号页；常规截图复用真实登录与临时 storageState，安装/登录截图直接打开未登录状态的登录页（含「使用一次性码登录」/「Sign in with one-time code」表单，不注入真实一次性码） |
| 页面状态 | 真实点击填表保存，读 API 核对；不改 DOM 伪造数据 |
| 网络 | 发现/健康检查/AI 提取/描述起草走本地 fixture，拒绝意外外部请求，不注入真实凭据 |
| 显示 | 固定 Chromium、Linux、如 1440×1000、DPR=1、浅色、固定时区与侧栏展开状态（旧版 config.jsonc 键名显示开关已移除） |
| 稳定 | 等目标文字、数据和 `fonts.ready`；关闭动画，等 toast 消失，固定滚动，不靠任意 sleep |
| 时间 | 浏览器与后端时间用同一基准，不能只冻浏览器让后端清理预算仍走真实时间 |
| 输出 | 优先任务卡片/对话框，少用长全页图；每个场景同时输出 `zh-CN` 与 `en` 两张图，并生成记录场景、语言、提交、浏览器和尺寸的 manifest |

现有测试服务并非完整生产 `serve`，部分连接、重启和运行状态由 fixture 控制。截图证明真实 UI 在指定数据下的显示，不代表 Provider 连通或 Telegram 发送验收。

### 7.2 截图清单

以下每个场景均由 Playwright 自动产出 `zh-CN` 与 `en` 两套浅色截图：

| 使用文档 | 展示内容 |
| --- | --- |
| 安装与首次登录 | 登录页与「使用一次性码登录」表单（替代已移除的网页首次建号页） |
| 模型 | **Providers** 页（非敏感连接步骤、模型拉取与健康检查含模型回复）与 **Models** 页（三角色选择与底部保存栏） |
| 首个人设 | Prompt 保存和版本、用于检验行为与口吻的虚拟群聊场景 |
| 首只 Bot | Token 未输入的表单、连接状态、Chat allowlist |
| Playground | Hold 待处理、Release 输出及审计入口 |
| 调优、群边界 | Telegram 消息批次时间、**Entry gate（入场闸门）** 全局设置与 Chats 单群覆盖、Harness 预算与发送设置、活跃时段与仅 `/ask` 唤起、主动回复、Chats 每群 MCP 绑定、**Reviews（批改）** 草稿与导出弹窗 |
| 记忆与辞典 | Memo 编辑、群聊记忆整理进度与 **30 小时制** 对话框、事件原文入口、辞典冲突/导入预览 |
| 图片与贴纸 | 图片设置就绪、生成工作台（含 `{{image:…}}` 内联引用）、完成记录、**生图素材（Image assets，含 Agent 可见开关与 AI 提取）** 与虚构示例图、Telegram **贴纸集管理** |
| 工具与定时任务 | 搜索设置、**循环闹钟（Recurring alarms）** 规则/Cron 与预览、**出站 MCP servers** 页状态（含渐进式暴露、描述起草与 Skill 列表） |
| 管理、密钥与 Agent 协助 | Koi 侧栏导航、**Keychain（密钥）** 列表与引用位置、API key 权限模式、Passkey 管理列表 |
| 排障 | 文件/运行配置不同、失败运行与 **Resume** 按钮（含实时自动刷新栏）、MCP `degraded` 告警、工具调用与发送结果 |

不截图真实 key 创建后的明文结果、真实一次性配对/登录码、Cookie、系统凭据选择器或真实用户消息。BotFather 优先文字及官方链接，不自动登录截图。

### 7.3 文件、引用和 CI

建议资产结构（同一场景的 `zh-CN` 与 `en` 成对存放）：

```text
apps/docs/content/public/screenshots/
  first-persona/prompt-editor.zh-CN.light.png
  first-persona/prompt-editor.en.light.png
  first-persona/playground-result.zh-CN.light.png
  first-persona/playground-result.en.light.png
  first-bot/chat-allowlist.zh-CN.light.png
  first-bot/chat-allowlist.en.light.png
  tuning/entry-gate.zh-CN.light.png
  tuning/entry-gate.en.light.png
```

场景清单记录截图 ID、支持语言（固定 `['zh-CN', 'en']`）、目标状态、依赖模块及引用文档。名称按任务和状态，不用日期、数据库 ID 或随机端口。

正文使用支持部署 base 的资源路径（中文页引 `*.zh-CN.light.png`，英文页引 `*.en.light.png`），alt 用对应语言描述操作目的。Bot 镜像内置手册仅打包英文（`en`）Markdown 和示例，新增图片须明确链接处理：建议网站保留双语截图，离线英文手册保留完整英文文字步骤和图注，不依赖不能访问的静态资源。

更新流程：编写或修改文档/UI 后运行 Playwright 截图命令重新生成 `zh-CN` 与 `en` 两套图 → 本地或 CI 输出前后对比 artifact → 人工确认后提交仓库图片 → 文档构建检查双语引用配对、孤立资产及 manifest 来源。

CI 复用现有 Chromium 安装（PR #122 已在 CI 中补齐 Playwright 浏览器安装）。初期手动触发或相关路径变更触发，单浏览器、单主题（浅色）、双语（`zh-CN` + `en`）；不把逐像素一致设为强制门禁，降低字体渲染升级噪声，不建设完整视觉回归平台。

## 8. 迁移计划

### 8.1 内容映射

| 现有内容（中文） | 处理（输出至 `zh` 与 `en` 双语） |
| --- | --- |
| `start/installation`、`start/quick-start` | 合并安装、一次性码首次登录及共同模型前置；模型细节归模型指南，人设设计与 Telegram 接入分别进入首个人设/首只 Bot |
| `start/agent-assisted`、`configure/admin-agent-pairing`、`reference/cli-surowan-utils-skill` | 合并 Agent 协助指南（含 SSH 配对签名、API key、MCP 与批改导出交接），命令参数与错误码归开发者参考 |
| `guides/personality`、`configure/admin-prompts` | 操作合并首个人设，字段和版本契约归参考 |
| `configure/models`、`configure/admin-developer`（模型参数来源段） | 操作归模型指南（Providers/Models 双页、nickname、健康检查回复），字段归配置参考（含 `configuration/models-dev.md`） |
| `configure/telegram`、`guides/per-chat` | 归首只 Bot、群边界（含每群 MCP、入场闸门覆盖与 `ask_only`）、图片与贴纸（贴纸集管理）、调优（自适应批次）、Telegram 命令（含 `/help` 与 `/ask`） |
| `guides/budgets`、`guides/participation`、`guides/proactive-replies`、`guides/entry-gate`、`configure/admin-harness-tuning`、`configure/admin-invocation-review` | 归调优/群边界（含 Decisions 入场闸门、`/ask`、`ask_only`、批改导出与失败续跑）；字段只在配置参考维护 |
| `guides/memory`、`guides/dictionary` | 合并知识任务入口（含群聊记忆 30 小时制与回填进度），保留机制独立解释 |
| `guides/images` | 重写图片/贴纸指南（补齐生图素材页含 Agent 可见性与 AI 提取、`{{image:…}}` 工作台引用、原图文件发送与 `.images/` 备份联动） |
| `guides/web-search`、`guides/recurring-alarms`、`guides/extensions` | 合并重写「搜索、定时任务与外部工具」（含循环闹钟、出站 MCP 页、渐进式暴露、`mcp-skill://`、按群绑定、`web_fetch` 看图），源码与多 IM 扩展边界归开发者参考 |
| `configure/admin`、`configure/admin-api-keys`、`configure/admin-keychain`、`configure/admin-developer` | 访问、一次性码登录、Keychain、Invocation 自动刷新与多语言维护归 `guides/admin.md`，密钥文件与 SecretRef 归 `configuration/secrets.md`，权限与鉴权归 HTTP/MCP，调试开关归排障与 `configuration/developer.md` |
| `operations/` 三篇 | 归维护（含 `serve` 周期保留清理与 `.images/` 恢复）及排障 |
| `reference/config`、`reference/fields` 和生成分页（含 `fields-models-dev`） | 迁 `configuration/`，更新双语生成路径规则 |
| `reference/cli` 及三篇 `cli-surowan-utils*`、`configure/admin-invocation-replay`、`configure/mcp-server` | 归服务端 CLI（含 `pairing`/`clients`）、客户端 CLI（含 `auth`）、重放与 MCP Server 参考 |
| `agent-doc/`、PRD、历史资料 | 保留职责，不批量搬进公开正文 |

迁移后取消旧正文独立维护，保留必要旧 URL 兼容（含 2026-11-06 之后新增的五篇路径：`configure/admin-agent-pairing`、`configure/admin-invocation-review`、`configure/admin-keychain`、`guides/recurring-alarms`、`guides/entry-gate`）。因默认根路径走中文，旧中文路径可在根路径直接重定向到新路径；优先静态托管重定向，并单独核对 `.md` 下载链接。Bot 镜像内置手册改为从英文源目录打包，旧路径不能依靠 HTTP 重定向解决，须同步更新产品知识索引。

### 8.2 迁移依赖

- `apps/docs/rspress.config.ts` 启用双语 `locales`（`lang: 'zh'` 走默认根路径、`/en/` 为英文前缀）、`i18n.json`、双语 `_nav.json` / `_meta.json`、README 和正文链接。
- `prepare.ts` 双语生成路径与模板文案、生成页识别（含 `models_dev` 与废弃字段渲染）。
- `manual-prepare.ts` 和手册测试：改为从 `en` 源目录打包英文版 `src/manual/`（注意每页单次读取上限 `DOC_READ_MAX_BYTES`）。
- 产品知识索引（`src/platform/prompts/2-product-knowledge.md`）的意图、英文 manual 路径与新功能事实。
- 搜索、示例、来源控件、`llms.txt`/`llms-full.txt` 与双语截图配对校验。
- docs workflow 写死的 `start/quick-start.md` 镜像 smoke 断言（更新为新版英文手册路径）。
- Playwright 双语截图脚本（`zh-CN` + `en`）与离线英文手册图片链接降级处理。

产品知识索引变化影响稳定 system prompt 哈希，可能沿现有机制让相关 Context 下一次运行重建；交付时应记录。

## 9. 实施顺序与验证

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| P0：搭建双语骨架、截图流水线与修事实 | 确认默认先 Playground、无网页 setup 后的一次性码登录路径；配置 Rspress 双语结构（`zh` 默认根路径 + `/en/` 英文前缀）与 Playwright 双语截图脚手架（`zh-CN` + `en`）；修权限、MCP/Chat 热更新、废弃字段、模型能力漂移 | 双语构建与最小 Playwright 双语截图跑通，关键说明与源码一致，入口不冲突 |
| P1：首次成功闭环（双语） | 安装（含 `pairing create --web`）、首个人设、首只 Bot、最小配置、基础排障与首批 `zh-CN`/`en` 截图 | 隔离部署按教程完成一次性码登录、Playground 和 Telegram 验证，中英文档与截图齐全 |
| P2：完整配置参考（双语） | 双语生成增强（含 `models_dev` 与废弃标注）、默认/生命周期（含热应用与废弃字段）、全部 Schema 段、Keychain 语义、示例校验 | 中英字段覆盖完整，默认继承、废弃和降级有来源 |
| P3：对外接口参考（双语） | HTTP（含配对 Ed25519 签名、`offset`+`as_of` 分页、Resume、Decisions 入场闸门、出站 MCP 含渐进式与起草、循环闹钟、贴纸集、素材 AI 提取、Keychain Session-only 边界）/MCP/两套 CLI（含 `pairing`/`clients`/`auth`）、权限、重放和错误示例 | 无需猜 body/revision/副作用，目录与实现一致 |
| P4：高级任务与维护（双语） | 知识（含 30 小时制）、图片与贴纸集（含素材 Agent 可见性与 AI 提取）、工具与循环闹钟/出站 MCP（含渐进式与 `mcp-skill://`）、调优（含入场闸门、自适应批次与批改导出）、Keychain、备份恢复（含 `.images/` 与 `serve` 周期清理）和剩余双语截图 | 任务闭环，不与参考重复维护，所有场景具备 `zh-CN` 与 `en` 截图 |
| 发布收尾 | 旧 URL（含新增 5 篇）、手册、知识索引、双语双 base 构建、离线镜像产物 | 网站/Markdown/搜索/手册/双语截图一致，无敏感数据 |

若 MCP/API/CLI（含 Agent SSH 配对）是 Public Release 主宣传能力，P3 应是发布门槛。

实施时沿用仓库验证要求，特别覆盖：

- 最小启动示例独立校验，不能只合并到完整 baseline 后校验。
- 实际新手路径验收（含 `pairing create --web` 首次登录），明确真实外部与 Faux 覆盖差异。
- Schema 字段及生成目录完整性（含 `models_dev` 与废弃字段、双语一致性）、默认和生命周期的代表性验证。
- 接口表与实际路由（含 Session-only 的 Keychain/Auth）、MCP catalog、两套 CLI 命令的差异检查。
- Playwright 双语截图前页面关键状态及 API 读回断言，检查每个场景 `zh-CN` 与 `en` 成对产物及无孤立资产。
- 受影响文档测试、类型和 lint；文档构建/verify 的 `zh`+`en` 与根/子路径两种 base。
- 英文手册打包（`en` 源目录 → `src/manual/`）、单页读取上限、知识索引路径和镜像 smoke。
- 生产 Provider/Telegram 验收与离线 fixture 验证分别报告。

## 10. 待维护者确认

| 决策 | 推荐及备选取舍 |
| --- | --- |
| 首次体验顺序 | 默认先 Playground 再 Telegram，减少并发出错因素；保留直接 Telegram 分支 |
| 品牌与定位表述 | `README.md` 已改为「塑料碗 Harness（Surowan Harness）」；建议中英首页与导览同步采用这一区分，正文仍自然简称「塑料碗」/「Surowan」 |
| 公开接口承诺 | 明确 HTTP/MCP/CLI（含配对客户端签名协议）的稳定范围；有实现不等于承诺长期兼容 |
| 版本策略 | 当前站点跟源码、Compose latest 跟稳定版可能不同；推荐发布正文跟稳定版，保留提交来源 |
| 入门配置 | 新增面板最小示例，完整示例保留高级能力；保守预算由维护者决定，不把源码缺省当推荐 |
| Bot 的含义 | 明确为部署连接的 Telegram 账号，不暗示多 Bot 或独立人设实体；多 IM 仅在开发者扩展边界中提及，不作为用户承诺 |
| 扩展支持 | 解释内置契约及源码开发边界，不承诺市场、任意上传 Skill、热装第三方插件 |
| 新功能指南合并粒度 | 推荐把**循环闹钟**与**出站 MCP 页**并入 `guides/tools.md`、把 **Decisions 入场闸门**、**Reviews 批改与 Resume 续跑**并入 `guides/tuning.md`（交接部分入 `guides/agent-assisted.md`）、把 **Keychain** 并入 `guides/admin.md`；若入场闸门、循环闹钟或出站 MCP 篇幅过长再单拆 |
| 截图视觉扩展 | 已确认基于 Playwright 自动截取 **简体中文 + English** 两种语言；默认浅色桌面单尺寸，深色/移动按需再加 |
| OpenAPI 投入 | 先准确目录和关键契约；明确第三方生态支持后再完整 Schema/SDK |
| 旧链接期限 | 至少覆盖首次 Public Release 迁移周期（含 2026-11-06 之后新增的 5 篇路径），兼顾网页、Markdown、镜像手册 |
| 知识页是否合并 | 先合并记忆（含 30 小时制）与辞典任务入口，篇幅或用户反馈证明需要时再拆 |

除 3.4 已澄清的教程边界与 3.5 已澄清的双语文档、默认根路径、英文内置手册及 Playwright 双语截图范围外，整体规划仍等待维护者确认后进入实施。保存及更新本文件不表示其他建议已获采纳。
