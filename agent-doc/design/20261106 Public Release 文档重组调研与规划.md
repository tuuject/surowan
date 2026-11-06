# Public Release 文档重组调研与规划

- 日期：2026-11-06。
- 状态：调研完成，整体方案待维护者确认；两篇入门教程的职责已澄清，见 3.4。本文件不代表已审核 PRD，也不授权实施。
- 调研基线：`7daebf39e685b84d314dbca77d07730718a939d8`。
- 范围：保留「指南」「配置文件参考」「开发者参考」三个顶层分类，规划公开文档重组、参考生成及截图自动化。
- 原始调研仅进行只读探索，未修改仓库、启动服务、运行构建或测试，未连接真实 Telegram、Provider，未生成截图。随后按用户要求将报告保存为本文件。
- 本文描述的是上述提交的调查结果；实施前须重新核对源码。下文目录、拆分、自动化及实施顺序均为建议。

## 1. 建议结论

保留三个顶层分类，把新手主线调整为：

> 安装并打开面板、接入可运行的模型 → 设计人设并在虚拟群聊试聊 → 接入真实平台（目前为 Telegram）→ 按实际表现调优。

现有内容大多可以复用。主要工作是重排任务路径、修正已漂移的行为说明，并补齐接口契约。暂时不需要更换文档框架或增加截图依赖。

## 2. 调研范围与现状分析

调查覆盖了公开文档及导航、配置 Schema/解析/验证/热更新、Admin 路由和部分操作测试、两套 CLI、反向 MCP Server、相关 Skill、文档构建部署及截图基础设施。遵循仓库规则，没有读取历史设计归档和冻结 devlog 正文。

### 2.1 已有文档及可复用基础

| 区域 | 已有内容 | 规划中的定位 |
| --- | --- | --- |
| `apps/docs/content/docs/` | 开始使用、配置与接入、个性化指南、维护排障、参考 | 公开正文来源，重组为三个分类 |
| `apps/docs/examples/` | 完整配置、人设示例 | 保留示例唯一源，补充更小的入门示例 |
| 根 `docker-compose.yml` | 部署模板，与文档下载共用 | 保留唯一源，不在文档另存副本 |
| `agent-doc/` | 架构、数据、配置、运维、验证等维护者资料 | 继续服务代码维护，不整体搬进公开文档 |
| `packages/cli/` | `surowan-utils` 客户端及说明 | 开发者参考的代码依据 |
| `skills/surowan-utils/`、`skills/surowan-mcp/` | 外部 Agent 操作流程与边界 | 保留可安装资源，文档解释安装与使用 |
| `src/system-resources/`、插件内 Skills | Bot 自己使用的只读能力说明 | 与外部 Coding Agent Skill 明确区分 |

现有文档站基础：

- Rspress 2 中文、单版本静态站，支持搜索、逐页 Markdown、`llms.txt` 和 `llms-full.txt`。
- 从当前 `ConfigSchema` 生成字段页和可下载 JSON Schema。
- 使用真实 `loadConfig` 离线校验完整示例和正文 JSONC 片段。
- 校验链接、图片、来源提交、搜索、下载文件、Markdown 产物及 HTTP 404。
- 同一份正文打包为镜像内置用户手册，供 Bot 按需读取。
- GitHub Actions 验证 `/`、`/surowan/` 两种部署 base；生产配置指向 Cloudflare Workers 静态发布。

依据：[文档站维护说明](../../apps/docs/README.md)、[Rspress 配置](../../apps/docs/rspress.config.ts)、[生成脚本](../../scripts/docs/prepare.ts)、[验证脚本](../../scripts/docs/verify.ts)、[文档 CI](../../.github/workflows/docs.yml)。

这里确认的是仓库中的发布配置与流程，没有验证 Cloudflare Dashboard 当前设置或线上发布状态。

### 2.2 主要问题

#### 新手主线仍以手改完整配置为中心

当前快速开始要求读者先理解 Provider 协议、模型能力和元数据、Agent/Vision 引用、Telegram Chat ID，以及可选生图段。源码和面板已支持分阶段设置：先启动面板，再添加 Provider、选模型、写人设，通过 Playground 验证。

#### 任务内容和精确参考交错

Telegram 接入页同时承载首次接入、发送去重、空文本策略和命令；Admin 总览同时承担页面索引、登录、恢复和部分接口说明。读者完成一个任务时容易进入细节分支。

#### 已确认的行为漂移

| 现有表述 | 源码事实 | 影响与建议 |
| --- | --- | --- |
| 配置页、配置参考把删除 Chat 列为需要重启 | `mergeChats` 将移除 Chat 作为热更新；通过配置移除会停止授权与相关运行，保留存储数据 | 修正生命周期，区别移出配置与删除数据 |
| Prompt 管理页称 API key 不能编辑 Prompt | API key 经权限检查后进入共用路由；Prompt 保存、恢复已列入接口表 | 删除仅 Session 的旧限制，按权限说明 |
| 产品知识索引称 API key 不能改配置，删除 Chat 要重启 | 已被当前权限及热更新实现取代 | 正文修正后同步索引，避免 Bot 继续引用旧事实 |
| 首次运行要求文本和图片模型，并同步设置 Vision | 主 Agent 只要求 `text`；Vision 可不配置，直接看图和独立 Vision 是不同能力 | 首次主线只要求实际任务所需能力 |
| 顶层配置概览未完整覆盖 `image`、`dictionary`、`tool_model`、`web_fetch` 等段 | 当前 Schema 包含这些段，字段生成器也会遍历 | 从 Schema 自动建立完整目录，避免手写漏项 |

证据：[Chat 配置合并](../../src/platform/config/diff.ts)、[Chat 删除端点](../../src/ingress/admin/routes/chats.ts)、[API key 路由授权](../../src/ingress/admin/index.ts)、[Prompt 接口表](../../packages/admin-surface/src/specs/prompts.ts)、[旧 Prompt 文档](../../apps/docs/content/docs/configure/admin-prompts.md)、[产品知识索引](../../src/platform/prompts/2-product-knowledge.md)。

必须保留这个区别：从配置中移除 Chat 与调用面板/API 删除 Chat 不是同一个数据操作。后者还会在停止运行、核对授权状态后删除相关数据；停止未完成时可能返回待处理错误并保留数据。

#### 接口目录存在，但完整接口文档尚未形成

`packages/admin-surface` 能提供方法、路径、参数入口、权限、并发版本和确认要求；它没有逐字段描述请求 body，也没有完整响应 Schema。当前不能仅凭该表宣称已有可直接导出的完整 OpenAPI。

#### 截图没有文档资产流程

部分 E2E 已调用 `page.screenshot`，但图片写入临时测试产物。尚未形成中文文档场景、资产命名、引用关系、更新命令及审核机制。

## 3. 实际用户路径、概念和面板流程

### 3.1 建议的首次成功路径

以下步骤所需能力已经存在；把它们整理为连续教程、提供最小启动示例，属于待实施工作。

| 阶段 | 用户操作 | 成功标准 |
| --- | --- | --- |
| 安装 | 准备 Compose、数据目录和基础配置，开放回环面板端口 | 服务启动，可进入首次设置 |
| 初始化 | 创建本地管理员账号 | 登录成功，进入面板 |
| 接入模型 | Models 新建 Provider、导入或补全元数据，选择 Agent 模型和 thinking | 保存并应用成功，Agent 模型设置完整 |
| 创建人设 | Prompts 编写全局人格并保存 | 能读回当前正文和版本 |
| 首次试用 | Playground 建房、选身份、发消息、Release | 有运行记录，能区分发送、主动沉默和失败 |
| 接入 Telegram | BotFather 建 Bot，在 Telegram 页设置 Token，Chats 添加允许的 Chat | 连接正常，允许的消息入库并产生预期运行 |
| 调优 | 按费用、参与频率和回复表现调整 | 用审计和用量比较，不只看保存成功 |

依据：[Provider 新建与模型选择 E2E](../../apps/admin-next/e2e/08-models-editing.e2e.ts)、[Telegram Token 处理](../../src/ingress/admin/telegram.ts)、[Prompt 文件创建](../../src/ingress/admin/prompts.ts)。

实施阶段应增加完整的新手流程验收，验证空部署配置到第一次 Playground 输出能够连贯完成。本轮没有执行该验收。

### 3.2 核心概念

| 概念 | 当前实现关系 | 面向普通用户的表达 |
| --- | --- | --- |
| 塑料碗实例 | 一个部署进程及配置、数据 | 你部署的这套服务 |
| Telegram Bot | 单个可选 Token，连接可启停或更换 | Telegram 里与你互动的账号 |
| 人设 | 全局人格文件，加每 Chat 附加指令 | 它是谁、怎样说话、怎样参与 |
| Provider | 连接方式、凭据、协议及显式启用的模型 | 模型服务来源 |
| 模型 | Provider 下的模型及能力、窗口、成本等元数据 | 实际思考和生成的模型 |
| Agent / Vision / Tool Model | 主模型、独立图片分析模型、辅助任务模型 | 聊天、细看图片、辅助处理的分工 |
| Chat / Topic | Chat 允许范围及覆盖配置；Topic 继承 Chat 的模型和指令 | 在哪些地方活动、是否有当地规则 |
| Context / Memo / 群聊记忆 / 辞典 | 连续对话、持久条目、整理事件、术语知识 | 当下聊天、记下的事、过去发生的事、专有词 |

没有发现独立人设库、角色卡导入或多 Bot 管理实体。「你的第一个人设」可以作为教程标题，但应描述当前 Prompt 工作流，不能画出不存在的角色管理页面。

依据：[根 Schema](../../src/platform/config/schema.ts)、[配置分段](../../src/platform/config/schema-sections.ts)、[模型和密钥 Schema](../../src/platform/config/schema-model.ts)、[默认及覆盖](../../src/platform/config/resolve.ts)。

### 3.3 Admin Panel 的任务导航

| 用户任务 | 页面 |
| --- | --- |
| 看运行状态、查失败 | Overview、Warnings、Invocations、Messages、Contexts |
| 配置人格和模型 | Models、Prompts、Harness、Search settings |
| 接入和管理 Telegram | Telegram、Chats、Bot admins |
| 管理知识和提醒 | Memories、Group memories、Dictionary、Alarms |
| 图片处理 | Stickers、Image generate、Image generations、Image settings |
| 试验与维护 | Playground、API keys、Developer、Settings、Preferences |

依据：[真实侧栏定义](../../apps/admin-next/src/components/layout/app-sidebar.tsx) 和 `apps/admin-next/src/routes/`。

不必每个路由各写一篇。指南只解释任务需要的页面，字段、权限、错误及精确请求放在参考页。Invocation 重放目前没有独立页面入口，按 CLI/API 工作流说明。

### 3.4 已澄清：人设设计与真实平台接入的边界

2026-11-06，维护者明确两篇入门教程的不同目标：前者教设计自己 Bot 的行为、口癖，并在虚拟群聊试聊；后者教接入真实平台。当前真实平台只有 Telegram，不因此引入尚未实现的平台接入能力。

| 文档 | 读者要完成什么 | 主要内容 | 完成标准 |
| --- | --- | --- | --- |
| 你的第一个人设 | 设计并试验 Bot 的行为 | 身份与关系、行为倾向、口吻与口癖；写入 Prompt；在虚拟群聊构造场景、试聊、修改 | 在虚拟群聊得到基本符合预期的表现 |
| 你的第一只 Bot | 把已试好的人设接入真实平台 | 创建 Telegram Bot、设置 Token、消息可见性、Chat/Topic 允许范围、首次真实互动 | 在允许的真实聊天中收到消息并完成互动 |

人设教程围绕「写一份简短人设 → 试几个场景 → 找出不符合预期的表现 → 修改再试」展开。重点是行为设计和反馈迭代，不以长 Prompt 或编辑器功能清单作为入门目标。只介绍完成试聊所需的 Playground 操作；房间、重试、媒体等完整操作仍由 Playground 专题承载。

真实平台教程复用已有的人设和模型，链接回前篇，不重复教学。重点补充真实环境特有的问题：群友互动、平台权限、允许范围，以及虚拟群聊成功后真实群仍可能不回复的排查入口。标题可保留「你的第一只 Bot」，描述建议为「把试好的人设带进 Telegram」。

两篇的共同前置条件是面板可用、已选好可运行的 Agent 模型。前置准备集中在安装流程，完整模型接入操作由「接入和更换模型」承载；两篇均不重复 Provider 配置。该安排同步替换本规划原先将首次模型连接纳入人设教程的建议，整体规划的其他待确认事项保持待确认。

## 4. 建议目录树

路径相对 `apps/docs/content/docs/`。首页为入口，不增加第四个顶层分类。

```text
index.md                              使用文档：选择你的任务

guides/                               指南
├── index.md                          从这里开始
├── installation.md                   安装
├── first-persona.md                  你的第一个人设
├── first-bot.md                      你的第一只 Bot
├── tuning.md                         按表现和费用调优
├── agent-assisted.md                 让你的本地 Agent 帮你调整塑料碗
├── models.md                         接入和更换模型
├── playground.md                     用虚拟群聊试验人设和工具
├── chats.md                          为不同群和话题设置边界
├── knowledge.md                      管理记忆与辞典
├── images.md                         看图、Sticker 与图片生成
├── tools.md                          开启搜索、提醒和外部工具
├── admin.md                          管理面板与访问安全
├── maintenance.md                    升级、备份与恢复
└── troubleshooting.md                排查启动失败和不回复

configuration/                        配置文件参考
├── index.md                          配置格式、查找与最小示例
├── lifecycle.md                      默认、继承、应用与重启
├── secrets.md                        SecretRef 与路径规则
├── telegram.md                       Telegram、Chat 与 Topic
├── providers.md                      Provider 与模型定义
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
│   ├── index.md                      HTTP 鉴权与公共约定
│   ├── audit.md                      审计、查询与导出
│   ├── configuration.md              模型、Prompt、Chat 与配置管理
│   ├── data.md                       Memo、辞典、群聊记忆与提醒
│   └── playground-images.md          虚拟群聊与图片接口
├── mcp-server.md                     外部 Agent 使用的 MCP Server
├── service-cli.md                    服务端 CLI
├── client-cli.md                     surowan-utils
├── replay.md                         Invocation 预检与重放
├── telegram-commands.md              Telegram 命令
└── extensions.md                     System Skills 与源码扩展边界
```

活跃时段、主动回复、预算、睡眠、发送规则首先服务「调优」与「群聊边界」，不各自新增指南。配置页保留精确字段入口。

## 5. 逐篇文档清单

### 5.1 代码依据缩写与维护约定

| 缩写 | 事实来源 |
| --- | --- |
| C | `src/platform/config/{schema,schema-sections,schema-model,resolve,validate,semantics,index}.ts` |
| L | `src/platform/config/{diff,diff-merge,diff-providers}.ts`、`src/adapters/local-monolith/config/` |
| P | `src/ingress/admin/` 对应业务及 `routes/`，`apps/admin-next/src/pages/`、`routes/` 和对应 E2E |
| H | `packages/admin-surface/src/specs/`、`types.ts`，实际 HTTP handler |
| M | `src/ingress/admin/mcp/{index,tools,skills}.ts` |
| CLI | `src/cli.ts`、`src/cli-options.ts`、`packages/cli/src/` |
| X | `src/plugins/{plugin,builtin}.ts`、`src/system-resources/`、插件 Skills |
| D | `scripts/docs/`、`scripts/manual-prepare.ts`、文档测试及构建配置 |

「混合维护」表示字段或接口表自动生成、解释与示例人工维护，不把生成结果复制进手写正文。

### 5.2 指南

| 标题与路径 | 读者、问题及主要内容 | 依据、素材、维护与处理方式 |
| --- | --- | --- |
| 从这里开始 `guides/index.md` | 新用户：选择首次安装、已有实例或排障路径；只解释必要概念 | 现有文档首页、C；无截图；人工；重写 |
| 安装 `guides/installation.md` | 自部署用户：Docker 主路径、基础文件、端口、首次管理员；引导选好可运行的 Agent 模型；宿主机次路径 | installation/quick-start、Compose、CLI、模型指南；配置、命令、首设截图；人工；合并重写 |
| 你的第一个人设 `guides/first-persona.md` | 人设设计新手：设计身份、行为、口吻与口癖，写入 Prompt，在虚拟群聊试聊并迭代 | personality/admin-prompts/playground、C/P；人设及试聊场景示例、Prompt/试聊截图；人工；重写 |
| 你的第一只 Bot `guides/first-bot.md` | 已试好人设的用户：接入真实平台（当前 Telegram），BotFather、Token、收消息条件、Chat ID、allowlist、真实互动验证 | telegram、P、Telegram ingress；空 Token 表单、连接状态、Chat 截图；人工；重写 |
| 按表现和费用调优 `guides/tuning.md` | 已运行用户：按太吵、太慢、太贵、不接话选择调整，控制变量并读审计 | budgets/participation/proactive-replies/harness、C/L/P；片段、预算/审计截图；人工；合并重写 |
| 本地 Agent 协助 `guides/agent-assisted.md` | Coding Agent 用户：选 MCP/CLI、配权限、先读后给变更方案、应用核对 | agent-assisted、两套外部 Skill、M/CLI/H；客户端配置、key 模式截图；人工；重写 |
| 接入和更换模型 `guides/models.md` | 管理员：Provider 向导、模型发现确认、角色选择、thinking、健康检查 | models、C/P；向导及模型选择截图；人工；重写 |
| 虚拟群聊试验 `guides/playground.md` | 人设作者：身份、Hold/Release、回复与沉默、失败重试、生图费用边界 | playground、P、Playground runtime；待处理/完成截图；人工；迁移修订 |
| 不同群和话题 `guides/chats.md` | 群管理员：范围、模型与指令覆盖、时区、忽略名单、参与策略、移除与删除 | per-chat/telegram/participation、C/L/P；Chat 编辑/时段截图、配置；人工；合并 |
| 管理记忆与辞典 `guides/knowledge.md` | 管理员：按用途选择 Context/Memo/群聊记忆/辞典，编辑清理、导入导出 | memory/dictionary、相关 store/插件/P；局部截图、导入示例；人工；合并重写 |
| 看图与生成图片 `guides/images.md` | 图片用户：直接图片输入、Vision、Sticker、生成编辑、记录资产 | images、C/P、image-service；设置/工作台/记录截图、配置；人工；重写 |
| 搜索、提醒和外部工具 `guides/tools.md` | 高级用户：完成搜索提醒任务，何时需 MCP，受限网页读取与授权边界 | web-search/extensions、C/X、MCP client/Alarm；搜索截图、MCP 示例；人工；合并 |
| 管理面板与访问安全 `guides/admin.md` | 运维者：入口、任务地图、远程访问、Session/Passkey/恢复、浏览器偏好 | admin/api-keys、P/CLI；导航与 Passkey 管理截图；人工；重写 |
| 升级、备份与恢复 `guides/maintenance.md` | 运维者：标签、升级、配置迁移、备份覆盖、停机恢复及检查 | upgrade/backup-restore、CLI、数据库/镜像流程；命令与目录，无强制截图；人工；合并 |
| 排查问题 `guides/troubleshooting.md` | 所有用户：启动、面板、模型、图片、不回复；按证据分流 | troubleshooting、P/CLI、运行及审计；失败状态/工具审计截图；人工；重写 |

安装流程引导读者完成可运行模型的准备，完整 Provider 操作集中于模型指南。首个人设与首只 Bot 共享此前置，不重复模型接入；两篇职责见 3.4。调优引用配置参考解释数值，不重新维护字段全集。

### 5.3 配置文件参考

每个字段应能检索到完整路径、类型、相对必填性、枚举/范围、缺省行为、启用条件、覆盖关系、生效方式、示例及代码来源。此分类不需要 Admin 截图。

| 标题与路径 | 读者的问题及主要内容 | 依据、示例、维护与处理方式 |
| --- | --- | --- |
| 配置入口 `configuration/index.md` | 手改配置者：JSONC、未知字段、版本、必填段、最小完整示例、Schema 下载 | C/D、config-file/config/fields；完整配置；混合；重写 |
| 配置生命周期 `configuration/lifecycle.md` | 管理员：缺省与 null、继承、文件/运行快照、显式应用、部分应用、重启、Prompt 影响 | C/L、config-file；行为矩阵及前后示例；人工；合并重写 |
| 密钥与路径 `configuration/secrets.md` | 运维者：三种 SecretRef、解析失败、权限、路径基准；文件与输入接口的区别 | schema-model/secrets/loader；安全片段；混合；抽取重写 |
| Telegram `configuration/telegram.md` | 高级用户：Token、聚合、Chat/Topic、管理员、参与策略、忽略名单 | C/L；字段和覆盖示例；混合；重组生成内容 |
| Provider `configuration/providers.md` | 接入者：builtin/custom、API、模型元数据、compat、thinking、成本 | C、providers/thinking-levels；两种 Provider 示例；混合；重组补语义 |
| Agent `configuration/agent.md` | 调优者：身份三元组、预算、发送、Context、并发限流、旧字段优先级 | C/L、消费代码；字段组合；混合；重组 |
| Vision `configuration/vision.md` | 图片管理员：模型对、独立预算并发、缺省不可用状态 | C、媒体/Vision；最小启用示例；混合；重组 |
| Tool Model `configuration/tool-model.md` | 辅助任务用户：配置、继承全局 Agent、不跟随 Chat 覆盖 | C、辅助模型解析/辞典融合；示例；混合；新增完整参考 |
| 图片生成 `configuration/image.md` | 图片管理员：credentials、模型、capabilities、领域校验、禁用降级 | C、image-service、热加载；示例；混合；重组补充 |
| 辞典 `configuration/dictionary.md` | 管理员：注入模式及 Chat 覆盖 | C、dictionary 插件；示例；混合；新增集中参考 |
| 网络搜索 `configuration/web-search.md` | 管理员：开关、引擎、服务商、密钥/endpoint、过滤和默认 | C、web-search/搜索插件；示例；混合；抽取重写 |
| 网页读取 `configuration/web-fetch.md` | 高级运维者：Markdown 协商、代理地址和 IP 放行 | C、web-fetch 实现；示例；混合；新增 |
| 外部 MCP `configuration/mcp.md` | 集成者：stdio/HTTP、allowlist、policy、超时、载荷和结果上限 | C、MCP client；两种 transport 示例；混合；抽取重写 |
| Admin `configuration/admin.md` | 运维者：host/port/TTL/static/public_url、启用和重启 | C/P；示例；混合；重组 |
| 调试记录 `configuration/developer.md` | 排障者：payload/thinking 开关、缺省和生效范围 | C/L/P；示例；混合；迁移扩充 |
| 数据与保留 `configuration/storage.md` | 运维者：根级标量、paths、retention、清理对象与执行时机 | C、backup/清理实现；目录和配置；混合；合并新增 |

短配置段可短写，不要求每篇同样篇幅。

### 5.4 开发者参考

| 标题与路径 | 读者的问题及主要内容 | 依据、示例、维护与处理方式 |
| --- | --- | --- |
| 接口入口 `developer/index.md` | 集成者：何时选 HTTP/MCP/CLI，版本匹配，公开契约与内部模块边界 | H/M/CLI/X；关系表；人工；新增 |
| HTTP 公共契约 `developer/http/index.md` | API 调用者：基地址、Session/Bearer、四种 key 模式、Origin、ID、分页、revision、错误、计费重试 | H、AdminServer/auth/http/api-keys；curl、成功失败 JSON；混合；新增 |
| 审计与导出 `developer/http/audit.md` | 审计工具作者：Invocation/消息/Context/用量/告警/媒体、过滤和快照 | H audit/control、inspection/audit；请求响应；混合；抽取补齐 |
| 配置管理 `developer/http/configuration.md` | 管理工具作者：Provider/模型/Prompt/Chat/Harness/搜索/Telegram，冲突和应用失败 | H/P/L；写入与冲突示例；混合；新增 |
| 知识数据 `developer/http/data.md` | 数据工具作者：Memo/Blob/辞典/群聊记忆/Alarm，作用域、revision、导入导出和删除 | H/P；请求响应、导入格式；混合；新增 |
| 虚拟群聊与图片 `developer/http/playground-images.md` | 自动化客户端作者：身份、Hold/Release/重试、上传、生成取消输出和资产 | H/P、image-service；状态及请求响应；混合；新增 |
| MCP Server `developer/mcp-server.md` | 外部 Agent/Harness 作者：/mcp、协议分支、参数、权限、资源/Skills、错误及二进制 | mcp-server、M/H、surowan-mcp Skill；客户端/协议示例；混合；重写 |
| 服务端 CLI `developer/service-cli.md` | 运维脚本作者：六个命令、合法选项、输入输出、退出码、副作用和 TTY | cli、CLI、doctor/account；命令与 JSON；人工加可提取命令表；补全重写 |
| 客户端 CLI `developer/client-cli.md` | 管理脚本作者：安装登录、凭据优先级、专用命令、通用 body、revision、确认导出 | 三篇 utils 文档、CLI/H；命令及 stdout/stderr；混合；合并重写 |
| Invocation 重放 `developer/replay.md` | 评估者：预检、当前/历史差异、切片、覆盖、保真限制、计费及无 Telegram 发送 | replay 文档与实现、CLI/M；完整流程和响应；人工；迁移重写 |
| Telegram 命令 `developer/telegram-commands.md` | 管理员/集成者：权限、参数、Chat/Topic 作用域、生效失败 | telegram、bot-commands；命令示例；人工；抽取补齐 |
| 扩展边界 `developer/extensions.md` | 二次开发者：System Skills、execute、内置 Plugin、宿主可用性和权限 | X、host-tooling；最小源码例子；人工；重写 |

开发者页主要用协议和代码示例，不依赖截图。HTTP 四组分页在完整 body/response 补齐后按实际大小调整，不一端点一页面。

## 6. 参考自动化方案

### 6.1 配置参考

保留现有生成器，补齐缺省和语义。当前生成器能遍历对象、数组、动态名称和 union 分支，按顶层段分页，主要输出类型、必填性和部分约束：

- 不输出运行时默认值。
- 尚未覆盖 `maxLength` 等所有已使用约束。
- 不解释启用条件、覆盖关系及热更新。
- JSON Schema 通过不代表跨字段验证或运行时准备成功。
- `image` 存在结构不合法时警告并禁用的特殊处理，不能写成任何错误均拒绝启动。

建议分三层维护：

| 内容 | 推荐来源 |
| --- | --- |
| 字段路径、类型、必填性、范围、枚举、Schema 声明默认 | 从 Schema 生成 |
| Agent/Vision 等集中默认 | 从现有默认常量及解析函数提取，标为运行时缺省 |
| 分散默认、条件启用、继承、跨字段限制、用户影响 | 人工解释，链接实际解析/消费位置，以行为测试约束 |

不能从示例反推默认：Agent 日预算缺省为 `1_000_000_000` Token，公开示例为 `300000`；`idle_grace_seconds` 缺省为 `0`，公开示例为 `30`。主 Agent 身份三项不完整时不运行，不能替用户补模型。Telegram 整段缺省与已写对象内哪些字段必填也应分别说明。

依据：[默认解析](../../src/platform/config/resolve.ts)、[校验特殊处理](../../src/platform/config/validate.ts)、[生成器](../../scripts/docs/prepare.ts)。

生效方式不能只对字段路径调用 `classify()` 就生成结论：新增/移除 Chat、Prompt 内容变化及 Provider 合并存在专门逻辑。应以 `diffConfig` 的代表性变更结果校验生命周期表。

不为写文档先重构所有默认值。先复用集中常量，对分散行为做有来源的人工补充。

### 6.2 HTTP、MCP 和 CLI

复用 `ADMIN_SURFACE_SPECS` 自动列出 method/path、参数入口、权限、revision 类别、破坏性/计费确认和响应大类；CLI 通用命令目录使用同一来源。MCP 工具目录从真实 `TOOL_CATALOG` 导出，不重写名称转换、截断和冲突处理。服务端 CLI 单独核对 `cli-options.ts`，与 `surowan-utils` 区分。

必须人工补齐：

- body/response 字段、枚举、单位、可空性。
- 各分页接口默认、cursor 含义、过滤组合。
- 错误状态及错误码。
- 并发冲突、保存但未应用、取消、结果未知。
- 上传、导出、二进制和大小限制。
- write、paid、write+paid 各自的操作范围。

区分服务端权限、CLI/MCP 的 `--yes`/`confirm`/`dry_run`、Skill 用户确认流程。不能把客户端确认参数写成所有 HTTP 接口统一接收的字段，也不能混淆 MCP `isError` 和 JSON-RPC 协议错误。

OpenAPI 暂缓作为前置条件。当前没有找到完整 OpenAPI/Swagger 生成链。第一阶段生成准确目录并补关键请求响应；若明确承诺第三方 SDK，再逐步共享边界 Schema 并输出 OpenAPI。

## 7. 自动化截图方案

### 7.1 复用现有 Playwright 和真实面板

已有 React 19、Rsbuild、TanStack Router/Query、Tailwind 和 `@playwright/test`。E2E 使用构建后的真实 SPA、真实 AdminServer、临时 SQLite、合成数据及本地 Provider 替身。

依据：[Playwright 配置](../../apps/admin-next/playwright.config.ts)、[服务启动](../../apps/admin-next/e2e/server-boot.ts)、[数据及 Faux runtime](../../apps/admin-next/e2e/server-fixtures.ts)、[已有截图](../../apps/admin-next/e2e/19-harness.e2e.ts)。

| 环节 | 建议实现 |
| --- | --- |
| 启动 | 构建图片包及 SPA，派生独立截图测试入口；随机回环端口，ready 日志判断就绪，结束关闭 |
| 数据 | 复用 seed/helper，提供精简中文场景；固定 ID，虚构群名、模型、人设和消息 |
| 登录 | 复用真实 setup/login 和临时 storageState；首设图用独立未初始化场景 |
| 页面状态 | 真实点击填表保存，读 API 核对；不改 DOM 伪造数据 |
| 网络 | 发现/健康检查走本地 fixture，拒绝意外外部请求，不注入真实凭据 |
| 显示 | 固定 Chromium、Linux、如 1440×1000、DPR=1、浅色、中文、时区、侧栏及配置键显示状态 |
| 稳定 | 等目标文字、数据和 fonts.ready；关闭动画，等 toast 消失，固定滚动，不靠任意 sleep |
| 时间 | 浏览器与后端时间用同一基准，不能只冻浏览器让后端清理预算仍走真实时间 |
| 输出 | 优先任务卡片/对话框，少用长全页图；输出场景、提交、浏览器和尺寸 manifest |

可在首次导航前设置 `admin-language`、`admin-theme`、`admin-show-config-keys`。现有 E2E 默认英文，截图采用独立中文项目配置，保留原测试语言。

现有测试服务并非完整生产 `serve`，部分连接、重启和运行状态由 fixture 控制。截图证明真实 UI 在指定数据下的显示，不代表 Provider 连通或 Telegram 发送验收。

### 7.2 截图清单

| 使用文档 | 展示内容 |
| --- | --- |
| 安装 | 首次管理员设置 |
| 模型 | Provider 非敏感步骤、Agent 选择 |
| 首个人设 | Prompt 保存和版本、用于检验行为与口吻的虚拟群聊场景 |
| 首只 Bot | Token 未输入的表单、连接状态、Chat allowlist |
| Playground | Hold 待处理、Release 输出及审计入口 |
| 调优、群边界 | 预算发送设置、活跃时段、主动回复 |
| 记忆与辞典 | Memo 编辑、群聊事件原文入口、冲突/导入预览 |
| 图片 | 配置就绪、生成工作台、完成记录、虚构示例图 |
| 工具 | 搜索设置 |
| 管理、Agent 协助 | 导航、key 权限模式、Passkey 管理列表 |
| 排障 | 文件/运行配置不同、失败运行、工具调用与发送结果 |

不截图真实 key 创建后的明文结果、Cookie、系统凭据选择器或真实用户消息。BotFather 优先文字及官方链接，不自动登录截图。

### 7.3 文件、引用和 CI

建议资产结构：

```text
apps/docs/content/public/screenshots/
  first-persona/prompt-editor.zh-CN.light.png
  first-persona/playground-result.zh-CN.light.png
  first-bot/chat-allowlist.zh-CN.light.png
  tuning/participation-window.zh-CN.light.png
```

场景清单记录截图 ID、目标状态、依赖模块及引用文档。名称按任务和状态，不用日期、数据库 ID 或随机端口。

正文使用支持部署 base 的资源路径，alt 描述操作目的。Bot 手册只打包 Markdown 和示例，新增图片须明确链接处理：建议网站保留图片，离线手册保留完整文字步骤和图注，不依赖不能访问的静态资源。

更新流程：重新生成 → 本地或 CI 输出前后对比 artifact → 人工确认后更新仓库图片 → 文档构建检查引用、孤立资产及 manifest 来源。

CI 复用现有 Chromium 安装。初期手动触发或相关路径变更触发，单浏览器/主题/语言；不把逐像素一致设为强制门禁，降低字体渲染升级噪声，不建设完整视觉回归平台。

## 8. 迁移计划

### 8.1 内容映射

| 现有内容 | 处理 |
| --- | --- |
| start/installation、start/quick-start | 合并安装及共同模型前置；模型细节归模型指南，人设设计与 Telegram 接入分别进入首个人设/首只 Bot |
| start/agent-assisted、utils Skill 使用页 | 合并 Agent 协助指南，参数归开发者参考 |
| guides/personality、configure/admin-prompts | 操作合并首个人设，字段和版本契约归参考 |
| configure/models | 操作归模型指南，字段归配置参考 |
| configure/telegram、guides/per-chat | 归首只 Bot、群边界、Telegram 命令 |
| budgets、participation、proactive-replies、harness | 归调优/群边界；字段只在配置参考维护 |
| memory、dictionary | 合并任务入口，保留机制独立解释 |
| images、web-search、extensions | 重写图片/工具指南，源码扩展归开发者参考 |
| admin、api-keys、developer | 访问维护归 admin，权限归 HTTP/MCP，调试归排障 |
| operations 三篇 | 归维护及排障 |
| config、fields 和生成分页 | 迁 configuration，更新生成路径规则 |
| cli 及三篇 utils | 归服务端 CLI、客户端 CLI、重放 |
| agent-doc、PRD、历史资料 | 保留职责，不批量搬进公开正文 |

迁移后取消旧正文独立维护，保留必要旧 URL 兼容。优先静态托管重定向，并单独核对 `.md` 下载链接。Bot 手册旧路径不能依靠 HTTP 重定向解决。

### 8.2 迁移依赖

- `_nav.json`、各层 `_meta.json`、README 和正文链接。
- `prepare.ts` 生成路径、生成页识别。
- `manual-prepare.ts` 和手册测试。
- 产品知识索引的意图、manual 路径。
- 搜索、示例、来源控件等校验。
- docs workflow 写死的 `start/quick-start.md` 镜像 smoke 断言。
- 截图链接和离线手册资源处理。

产品知识索引变化影响稳定 system prompt 哈希，可能沿现有机制让相关 Context 下一次运行重建；交付时应记录。

## 9. 实施顺序与验证

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| P0：确认路径与修事实 | 确认默认先 Playground；修权限、热更新、模型能力漂移 | 关键说明与源码一致，入口不冲突 |
| P1：首次成功闭环 | 安装、首个人设、首只 Bot、最小配置、基础排障和首批截图 | 隔离部署按教程完成 Playground 和 Telegram 验证 |
| P2：完整配置参考 | 生成增强、默认生命周期、全部 Schema 段、示例校验 | 字段覆盖完整，默认继承和降级有来源 |
| P3：对外接口参考 | HTTP/MCP/两套 CLI、权限、重放和错误示例 | 无需猜 body/revision/副作用，目录与实现一致 |
| P4：高级任务与维护 | 知识、图片、工具、调优、备份恢复和剩余截图 | 任务闭环，不与参考重复维护 |
| 发布收尾 | 旧 URL、手册、知识索引、双 base 构建、离线镜像产物 | 网站/Markdown/搜索/手册一致，无敏感数据 |

若 MCP/API/CLI 是 Public Release 主宣传能力，P3 应是发布门槛。

实施时沿用仓库验证要求，特别覆盖：

- 最小启动示例独立校验，不能只合并到完整 baseline 后校验。
- 实际新手路径验收，明确真实外部与 Faux 覆盖差异。
- Schema 字段及生成目录完整性、默认和生命周期的代表性验证。
- 接口表与实际路由、MCP catalog、CLI 命令的差异检查。
- 截图前页面关键状态及 API 读回断言。
- 受影响文档测试、类型和 lint；文档构建/verify 的根及子路径两种 base。
- 手册打包、单页读取上限、知识索引路径和镜像 smoke。
- 生产 Provider/Telegram 验收与离线 fixture 验证分别报告。

## 10. 待维护者确认

| 决策 | 推荐及备选取舍 |
| --- | --- |
| 首次体验顺序 | 默认先 Playground 再 Telegram，减少并发出错因素；保留直接 Telegram 分支 |
| 公开接口承诺 | 明确 HTTP/MCP/CLI 的稳定范围；有实现不等于承诺长期兼容 |
| 版本策略 | 当前站点跟源码、Compose latest 跟稳定版可能不同；推荐发布正文跟稳定版，保留提交来源 |
| 入门配置 | 新增面板最小示例，完整示例保留高级能力；保守预算由维护者决定，不把源码缺省当推荐 |
| Bot 的含义 | 明确为部署连接的 Telegram 账号，不暗示多 Bot 或独立人设实体 |
| 扩展支持 | 解释内置契约及源码开发边界，不承诺市场、任意上传 Skill、热装第三方插件 |
| 截图基准 | 中文浅色桌面单尺寸；英文/深色/移动按需 |
| OpenAPI 投入 | 先准确目录和关键契约；明确第三方生态支持后再完整 Schema/SDK |
| 旧链接期限 | 至少覆盖首次 Public Release 迁移周期，兼顾网页、Markdown、镜像手册 |
| 知识页是否合并 | 先合并记忆辞典任务入口，篇幅或用户反馈证明需要时再拆 |

除 3.4 已澄清的教程边界外，整体规划仍等待维护者确认后进入实施。保存及更新本文件不表示其他建议已获采纳。
