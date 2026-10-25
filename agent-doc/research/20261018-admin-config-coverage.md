# Admin Panel 配置覆盖与补齐方案

调研日期：2026-10-18。依据：当前工作区源码，基线提交 `e3dca01`。本文是研究报告；下面标为“建议”的页面、端点和行为尚未实现。

## 结论

Admin Panel 已覆盖多数 Agent 日常调参，但还不能完整替代 `config.jsonc`。主要缺口是 Telegram 基础行为、全局参与策略及群级策略的部分字段、忽略用户、Vision 运行参数、贴纸集合配置、MCP、网页读取策略、保留与备份，以及 Admin/存储部署参数。

补齐大部分缺口可以复用现有 `ConfigController → ConfigReloader → writeConfigEdits` 链路。建议先开放字段编辑，保持当前 `hot / restart / outside_serve` 生效规则；不用为了做表单而同时改造所有组件的热切换生命周期。

这里有三类不同的问题，实施时必须分别处理：

- **缺表单和写端点**：例如忽略用户、全局参与策略、Vision 输出上限。运行时部分已经支持热更新。
- **后端支持，但 UI 只开放部分操作**：主要是图片模型的高级定义、已有图片凭据切换复用来源。
- **部署或身份操作**：例如数据库路径、Bot Token、MCP 命令、Admin 地址、SecretRef 的 `command`。需要额外的生命周期、凭据和恢复设计，不能只添加一个输入框。

“可以在面板配置”不等于“立即生效”；“配置只读接口能返回”也不等于“有可编辑页面”。本报告按这两个维度分别核对。

## 已经具备的配置能力

| 配置域 | 已有页面与范围 | 剩余边界 |
| --- | --- | --- |
| Agent | Models 管理全局模型/thinking；Harness tuning 管理预算、并发、历史、发送策略、Context、限流；Prompts 管理全局人格正文 | `agent.system_prompt_file` 路径不能自由改；正文已能编辑 |
| Provider 与语言/视觉模型定义 | Models 支持 Provider 增删、连接地址/API/key/header；模型增删及名称、输入能力、reasoning、thinking_levels、context_window、max_tokens、四项 cost、compat、tool_schema_keywords | Provider alias/kind/builtin provider 及已有模型 id 不能原地改名；SecretRef 不能直接选 env/command |
| Chat | Chats 支持新增/删除 Chat、Topic 白名单、模型/thinking 覆盖、群活跃时段；Prompts 编辑群指令正文 | 时区、忽略用户、触发词、注意力窗口及指令路径仍不完整 |
| Telegram 管理员 | Bot admins 增删 `telegram.admins` | 已有配置能力；不同于面板登录账号 |
| Vision | Models 切换 `vision.provider` / `vision.model` | 其余 Vision 参数没有编辑入口 |
| Dictionary / Tool Model | Dictionary 管理全局/群级注入模式；Models 管理 `tool_model` 或恢复继承 | 这两章的业务配置已有入口 |
| Developer | Developer 管理 `record_model_payloads`、`record_agent_thinking` | 已有配置能力 |
| Image | Image settings 启停、生图模型目录选择、路由选择、新模型的凭据绑定、凭据录入/复用、模型备注、移除模型 | 高级定义与凭据生命周期仍有缺口，见后文 |
| 配置生效 | Settings 的 Apply config file；Models/Chats 的待重启提示与受监督重启 | Apply 只重新加载文件，不提供任意配置编辑 |

依据：[Agent 字段 Schema](../../src/platform/config/schema-sections.ts#L82)、[Harness 白名单](../../src/ingress/admin/harness.ts#L30)、[模型完整编辑表单](../../apps/admin-next/src/components/models/model-edit-dialog.tsx#L148)、[管理端写端点说明](../admin-panel.md#api)。

Panel preferences 只控制当前浏览器的语言、主题、是否展示配置键名，不写 Bot 配置。Settings 中的账号、密码、Passkey 操作管理数据库中的认证状态，也不是 `admin.*` 配置编辑器。依据：[preferences.tsx](../../apps/admin-next/src/pages/preferences.tsx#L12)、[settings.tsx](../../apps/admin-next/src/pages/settings.tsx)。

## 尚不能完整配置的字段

下面的“热更新”指保存并成功应用后发布新配置；具体消费时机可能是下一条消息、下一次 Invocation 或下一次辅助调用。已有 Invocation 的快照规则保持不变。

### 缺少表单与写端点的业务设置

| 字段 | 当前面板/API 状态 | 当前生效方式 | 建议入口与实现 |
| --- | --- | --- | --- |
| `timezone` | 配置 inspection 可读，不能编辑 | 重启 | 新增 Bot settings 的默认时区；复用 IANA 时区校验 |
| `telegram.process_bot_messages` | inspection 可读，不能编辑 | 重启 | Bot settings 的消息处理开关 |
| `telegram.sticker_trigger_enabled` | inspection 可读，不能编辑 | 重启 | Bot settings 的贴纸触发开关，区分缺省与显式值 |
| `telegram.mention_typing_enabled` | 无编辑入口；当前 inspection 也未投影 | 重启 | Bot settings 的提及时显示 typing 开关，缺省行为为开启 |
| `telegram.bucket_window_seconds` | inspection 可读，不能编辑 | 重启 | Bot settings 的消息聚合窗口；0 仍是合法值 |
| `telegram.participation.active_windows` | Chats 读取全局值用于继承提示，但不能编辑全局值 | 热更新 | Chats 增加全局参与策略区域，复用活跃时段编辑器 |
| `telegram.participation.trigger_keywords`、`.attention_window_seconds` | 可读，不能编辑 | 热更新 | 同一全局参与策略区域 |
| `telegram.chats[].participation.trigger_keywords`、`.attention_window_seconds` | 群参与策略响应包含原值，但现有写端点只接受 `active_windows` | 热更新 | 扩展群参与策略表单及专用 DTO |
| `telegram.chats[].ignored_user_ids` | inspection 可读；Chats 编辑器/API 不接受；成员只能用 `/ignoreme`、`/unignoreme` 管理自己 | 热更新 | Chats 的忽略用户列表；ID 经十进制字符串传输并校验安全整数 |
| `telegram.chats[].timezone` | Chats 显示/返回时区，但不能编辑 | 已有 Chat 修改须重启 | Chats 高级设置；可删除覆盖恢复全局 |
| `telegram.sticker_sets[].alias`、`.name` | Bot sticker sets 只查看/搜索已索引集合，不管理配置列表 | 重启 | 贴纸页增加“配置集合”区域，按配置文件列出，不能以索引数据库代替已保存配置 |
| `vision.max_output_tokens` | inspection 可读；`PUT /vision` 只接受 provider/model | 热更新 | Models 的 Vision 设置扩展；支持与模型选择一次保存 |
| `vision.max_concurrency`、`.prompt_version`、`.daily_budget.max_tokens`、`.daily_budget.max_images` | inspection 可读，不能编辑 | 重启 | 同一 Vision 参数区，逐字段标明重启要求 |
| `web_fetch.allow_proxy_synthetic_addresses`、`.dangerously_allow_all_ip_addresses`、`.accept_markdown` | inspection 可读，不能编辑 | 重启 | 新增 Tools settings 的网页读取区 |
| `retention.online_days`、`.backup_copies` | inspection 可读，不能编辑 | `outside_serve`，下一次 backup 读取 | Maintenance 设置，显示“下次备份任务使用”，保存不执行清理 |

完整字段依据：[配置 Schema](../../src/platform/config/schema-sections.ts#L12)、[顶层 Schema](../../src/platform/config/schema.ts#L125)。覆盖边界依据：[Chats 请求 Schema](../../src/ingress/admin/chats.ts#L31)、[Vision 请求 Schema](../../src/ingress/admin/providers/index.ts#L101)、[配置 inspection 投影](../../src/ingress/admin/config-inspection.ts#L74)。生效分类依据：[config-diff.ts](../../src/platform/config/diff.ts#L35)、[Chat 专属分类](../../src/platform/config/diff.ts#L258)。

特别说明：新增 Chat 时整项配置可热加入；表中的群时区“重启”是指修改已存在的 Chat。删除 Chat、修改已有 Chat 的 Topic 白名单虽然需要重启，面板已经可以操作，不属于配置入口缺失。

### MCP 整章

`mcp.servers[]` 没有配置页面或写端点；inspection 仅返回不含连接敏感信息的部分字段。

| 类型 | 尚不能编辑的字段 | 建议 |
| --- | --- | --- |
| 通用 | `alias`、`transport`、`required`、`tools`、`payload_max_bytes`、`result_max_bytes` | Tools settings 下独立 MCP 列表及新增/编辑/删除表单 |
| stdio | `command` argv 数组、`env` 名称与 SecretRef | 明确按 argv 编辑，不引入 shell 命令字符串；程序必须已在宿主/容器可用 |
| Streamable HTTP | `url`、`headers` 名称与 SecretRef | 沿用 URL 校验、禁止 URL 凭据与重定向；密钥只写不读 |
| 策略 | `tool_policies[].name/read_only/timeout_seconds`、`default_tool_policy.read_only/timeout_seconds` | 工具白名单与策略一起校验；显式工具必须有对应策略，`tools: "*"` 必须有 default policy |

MCP 全部保留当前“保存后待重启”。`follow_redirects` 在 Schema 中只能是 `false`，显示为固定约束即可，不做可开启的开关。依据：[MCP Schema](../../src/platform/config/schema.ts#L32)、[策略语义校验](../../src/platform/config/semantics.ts#L168)。

MCP 热替换还涉及连接、发现工具、运行中调用和模型工具定义的同步，已经超出配置表单的必要改动。首次补齐无需改造这套生命周期。

### 部署、身份与文件位置

| 字段 | 当前能力与生效方式 | 建议处理 |
| --- | --- | --- |
| `telegram.token` | 无读取/编辑 UI；重启生效 | 部署设置增加只写的 Token 替换，保留原值/输入新值；先处理旧凭据生命周期 |
| `admin.enabled` | 不能编辑；重启生效 | 已启用面板可以提供关闭入口；关闭后再次开启必须走文件/部署引导 |
| `admin.host`、`.port`、`.public_url` | 不能编辑；public_url 未出现在 inspection；重启生效 | 部署设置，保存前展示下一次访问地址及认证影响；保留离线恢复途径 |
| `admin.session_ttl_hours` | inspection 可读，不能编辑；重启生效 | 部署设置中的会话期限 |
| `admin.static_dir` | inspection 隐藏，不能编辑；重启生效 | 高级部署设置；仅有路径值不能证明目录里有可用 bundle |
| `data_dir`、`paths.database`、`paths.media_cache` | inspection 隐藏，不能编辑；重启生效 | 明确区分“切换已有位置”和“迁移现有数据”；推荐日常面板只读，需要写入时采用专门部署流程 |
| `paths.backups` | inspection 隐藏，不能编辑 | Maintenance 高级项；下次 backup 使用，也用于下次启动发生迁移时的迁移前备份 |
| `agent.system_prompt_file`、`telegram.chats[].instructions_file` | 已支持编辑所指文件的正文；不能任意选择/更改路径，群指令缺失时可由面板自动创建路径 | 日常继续使用正文编辑器；若要文件级覆盖，增加受配置目录约束的资源绑定/新建/解除绑定流程 |

路径变更不是数据迁移。`data_dir` 关联 serve lock 和图片资源；`paths.database` 关联业务数据、认证和审计。直接改成新路径可能启动一套新库或丢失对原资源的访问，不能给出“已搬迁”的成功提示。专门迁移需要停机、备份、复制与完整性验证、修改配置、重新启动及验收；仅表单写路径无法完成。

新配置/错误配置导致 `serve` 无法启动时，当前面板也不可用。尤其 required MCP 在 Admin 创建前启动，不能假定“坏了再进面板改回来”。依据：[启动顺序](../../src/adapters/local-monolith/runtime/index.ts#L351)、[数据库与备份实现](../../src/adapters/local-monolith/database.ts)。

`public_url` 决定 WebAuthn origin/RP ID，更换域名会影响已有 Passkey。现有密码恢复依赖离线 `admin-account`，不能把地址变更当作普通文案设置。依据：[Passkey 认证说明](../admin-panel.md#passkey-登录与凭据)。

### 已有配置器的局部缺口

| 项目 | 精确边界 | 建议 |
| --- | --- | --- |
| SecretRef 形式 | Provider/image 页面可录入明文并写入 jar，但不能直接配置 `{env}`、`{command}` 或任意已有 jar 条目；已有引用通常可以保留 | 普通表单继续使用“保留/替换”与名称隐藏的状态；若要求完整文件表达能力，再提供受控高级凭据来源编辑 |
| Provider 身份 | 新建时可选 alias/kind/builtin provider，创建后不可原地改；custom 的 api/base_url 已能改 | 日常用新建、切换所有引用、删除旧项；若需原地转换，专用原子操作迁移 agent、vision、tool_model、Chat 等引用 |
| 普通模型 id | 新建时可填，已有模型 id 锁定 | 保持新增/迁移引用/删除旧项；无需把“没有重命名按钮”等同于不能配置模型 |
| 图片模型 | 新增通过目录生成 `id/name/provider/upstreamModel/providerTag/credentialRef/capabilities`；已有模型只直接编辑 `description` 或移除 | 增加高级编辑，允许合法的 id/name、路由与凭据绑定；能力参数应受图片服务契约校验 |
| 图片能力参数 | `imageInput`、`maxInputImages`、`maxOutputs`、`aspectRatios`、`resolutionClasses` 在 UI 只显示；API 可接收合法模型定义 | 常规流程继续目录发现；需要手动定义时增加高级表单，保存前验证枚举与组合约束 |
| 图片已有凭据的来源 | `credential_sources` API 可把同名凭据改为复用 builtin OpenRouter Provider 的引用，UI 未给已有凭据该选项 | 为已有凭据增加来源切换控件；继续不回显实际 SecretRef/密钥 |
| 图片凭据单项删除/改名 | API 从已保存 credentials 开始合并，只增加或替换，没有单项删除；省略、空字符串、null 都不能表达删除 | 增加显式删除操作；若仍有模型引用则拒绝，或在同次提交迁移引用。禁用整个 image 删除整章不能替代单项删除 |
| `image.models: []` | 文件 Schema 允许空数组，但面板/API 启用图片要求至少一个模型 | 保持产品约束并明确提示；若要求字面级全覆盖，需要明确“已启用但没有模型”的业务意义后调整 UI/API |

图片并不支持任意 Provider：外层配置 Schema 的 `provider` 是 string，但实际图片服务约束为 `openrouter`。不能把它误报为“只是 UI 没有多 Provider 下拉框”。依据：[图片服务契约](../../packages/image-service/src/contracts.ts#L112)。

以上局部边界依据：[Provider 请求结构](../../src/ingress/admin/providers/index.ts#L47)、[图片新增与编辑](../../apps/admin-next/src/pages/image-settings.tsx#L195)、[图片已有模型区域](../../apps/admin-next/src/pages/image-settings.tsx#L479)、[图片配置写入](../../src/ingress/admin/index.ts#L1870)。

### 应显示为固定规则的字段

- `version` 当前只能为 `1`。
- `vision.background_sticker_concurrency` 当前只能为 `1`。
- MCP HTTP `follow_redirects` 当前只能为 `false`。
- 图片服务目前只支持 `provider: "openrouter"`。

这些值可以展示，但增加可编辑输入不会带来合法的新配置。要改变它们意味着改变 runtime/schema 能力，不能混入“补齐配置入口”的工作量。

## 建议的实现结构

### 页面与 API 分域

以下为建议接口，不是现有 API。保持现有页面职责，新接口只允许该域的明确字段，不提供任意 JSON path 或 raw JSON 全文件写入口。

| 页面 | 建议接口方向 | 范围 |
| --- | --- | --- |
| Bot settings | `GET/PUT /api/bot-settings` | 默认时区、Telegram 行为开关、Bucket；全局 participation 也可放此端点，UI 在 Chats 提供入口 |
| Chats | 扩展 `/api/chats/:id` 与 `/api/chats/:id/participation` 的严格 DTO | 群时区、忽略列表、完整群参与策略；保留现有模型/Topic 语义 |
| Models | 扩展 `PUT /api/vision` 并提供完整 saved/active 读视图 | 允许同次改模型和 max_output_tokens，避免中间状态不合法 |
| Bot sticker sets | 配置专用 `GET/PUT /api/sticker-set-config` | alias/name 列表；与索引查询 API 分离 |
| Tools settings | `GET/PUT /api/web-fetch-settings`、`GET/POST/PUT/DELETE /api/mcp-servers[...]` | 网页策略、MCP 连接与策略 |
| Maintenance | `GET/PUT /api/maintenance-settings` | retention、专用备份目录；不隐式运行 backup |
| Deployment | `GET/PUT /api/deployment-settings` | Token、Admin 地址/会话、部署路径及高级绑定，使用专用安全投影 |
| Image settings | 扩展模型编辑 UI 与图片凭据操作契约 | 复用现有 `PUT /api/image/config`；不另建图片配置存储 |

配置继续以 JSONC 为事实源，不新增数据库配置表。报表、页面名称和分组可以微调；域边界与权限边界应保持清晰。

### 复用的后端链路

1. 认证、Origin、请求体大小限制由 `AdminServer` 统一执行；所有新写入口只允许面板 Session。Bearer API key 保持 inspection/replay 的既有范围。
2. 读端点返回该域的 `saved`、`active`、`revision`、`restart_required`，必要时包含 `supervised` 与继承后的 `effective`。revision 必须与返回的文件内容来自同一次稳定读取。
3. TypeBox 请求 Schema 尽量引用 `ConfigSchema` 的字段，避免复制一套范围；HTTP ID 继续用字符串。业务约束仍交给整份配置语义校验。
4. 端点只将受管字段转为 `ConfigEdit[]`。省略字段表示不改，删除可选值由契约明确表达，避免覆盖同章其它配置与 JSONC 注释。
5. `writeAndApply(edits, revision)` 在现有锁中完成写入和应用。文件校验通过后才 rename；新模型、Provider 和图片快照按现有链路发布。
6. 成功与失败都刷新配置相关 query，防止新 revision 下仍显示旧的已保存值。

复用位置：[配置控制契约](../../src/platform/config/write.ts#L96)、[JSONC 写入](../../src/adapters/local-monolith/config/file.ts#L56)、[reloader](../../src/adapters/local-monolith/config/reload.ts#L99)、[稳定读取 helper](../../src/ingress/admin/index.ts#L1570)、[前端刷新机制](../../apps/admin-next/src/lib/use-provider-write.ts#L19)。

`GET /api/config/view` 不能直接作为通用表单 DTO：它是有损的安全投影，刻意隐藏路径、SecretRef、MCP command/URL 等，且没有写入所需的 config revision。也不能为了表单把这些内容直接加入 Bearer 可读的 inspection。新建 Session-only 的分域视图更符合现有边界。

### 保存状态必须表达真实结果

界面至少区分：已写入并热应用、已写入待重启、已写入待下一次 backup、已写入但应用失败，以及写入前校验/冲突失败。

现有 `applyFeedback()` 处理了 applied/restart，尚未专门说明 `outside_serve`。开放 Maintenance 时要补齐该提示；“保存 retention”不触发清理，下一次 backup 才执行。并且 backup 当前先清理源库再创建备份，调低 `online_days` 影响的是下一次任务的源数据保留，不只是备份文件保留。

保存后应用失败不会自动回滚文件。本次 smoke 中返回 `409 model_unusable`，文件的 `history_messages` 已为 22，运行值仍为 21；之后显式 Apply 成功。这一状态需要展示修复/重新应用入口，不能仅提示“保存失败”或“已恢复原值”。

依据：[保存后失败处理](../../src/adapters/local-monolith/config/reload.ts#L305)、[当前前端反馈](../../apps/admin-next/src/lib/model-manager.ts#L493)、[backup 执行顺序](../../src/adapters/local-monolith/database.ts#L302)。

## 必须处理的具体边界

### 参与策略不能按普通覆盖对象编辑

当前合并规则为：

- 时段：群值替代全局值；缺省继承；空数组表示没有固定活跃时段。
- 触发词：群值追加到全局词后再按小写去重；群空数组不会屏蔽全局词。
- 注意力窗口：群值覆盖全局值，均未设置则 300 秒。
- 全局和群均无 participation 时不限制；留下空对象 `{}` 会启用无固定时段的参与闸门。

表单要区分“继承”“空数组”“删除整个策略”，展示合并后的触发词与时区。不能给群触发词的清空按钮标成“关闭所有关键词”。同时修改时区和时段时，应明确当前运行时区与待重启时区；不能预览成新时区已生效。私聊不接受 participation 配置。

依据：[compileParticipation](../../src/platform/participation.ts#L34)、[已有删除时段逻辑](../../src/ingress/admin/chats.ts#L157)、[配置语义校验](../../src/platform/config/semantics.ts#L70)。

### MCP 凭据必须保留旧运行态的可解析性

当前 jar 回收只比较旧磁盘配置与新磁盘配置，rename 之后就删除新文件不再引用的旧条目；没有考虑仍然运行的 active 配置，并且这发生在配置 apply 之前。

本次使用临时配置和合成凭据实际执行两次 `secretEdit + writeConfigEdits`：替换 MCP header 后，新 SecretRef 解析成功，旧 active SecretRef 解析失败（`Key jar has no entry`）。未连接真实 MCP；但源码明确表明 MCP 重连会根据启动时保留的配置重新解析 env/headers。

因此在开放 MCP Secret 的替换、删除前，需要把 jar 回收改为至少保留“磁盘配置引用 + 仍存活的运行配置引用”。被保留条目的后续清理由宿主在旧配置释放或下次启动时处理，不能无限遗留，也不能删除从未由配置管理器拥有的手工条目。应对“保存但 apply 失败”使用同样原则。

依据：[当前回收](../../src/adapters/local-monolith/config/file.ts#L133)、[每次重新读取 jar](../../src/platform/secrets.ts#L38)、[MCP 创建 transport](../../src/capabilities/mcp/index.ts#L231)、[MCP 重连](../../src/capabilities/mcp/index.ts#L372)。

普通表单输入密钥继续只写不读，Provider 沿用新 jar 名称轮换；不要从现有图片凭据更新的特殊实现推导通用约定。高级 env/command 来源编辑会扩大面板对宿主环境/进程的控制能力，应单独设计与测试，而不是把任意 SecretRef JSON 透传给普通配置端点。

### 重启和恢复不是保存接口的附带效果

`Restart now` 依赖外部进程监督器。`PLASTICWAN_SUPERVISED=1` 只是声明部署有监督器，本身不会创建它。未配置监督器时继续允许保存并明确提示人工重启，不伪造重启成功。

现有重启预检主要加载配置及验证权限，不等于外部依赖 `doctor`，也不保证新监听地址可绑定、Token/MCP 可连通。MCP required、Admin 关闭/改地址、数据库路径变更均须有离线修复路径。此轮建议保留现有 `serve` 拓扑，不引入第二个常驻管理进程。

`paths.backups` 需要专用目录：当前轮转遍历目录里的所有 `.sqlite` 文件，而不是仅匹配某个备份前缀。开放目录选择时必须展示这个真实约束或先收紧轮转范围。

依据：[重启实现](../../src/ingress/admin/index.ts#L1972)、[备份轮转](../../src/adapters/local-monolith/database.ts#L355)。

## 推荐实施顺序

| 阶段 | 交付范围 | 主要工作与验收 |
| --- | --- | --- |
| 1：日常控制 | 全局/群完整参与策略、忽略用户、群时区、Telegram 行为与 Bucket、Vision 参数 | 扩展表单与分域 DTO；复用当前生效分类；验证继承/删除/混合热与重启状态；Vision 模型与输出上限可同次修改 |
| 2：工具与维护 | 贴纸集合、web_fetch、retention/备份目录、图片高级编辑与凭据单项管理 | 新增相关白名单端点；补 outside_serve 提示；图片参数使用真实服务契约，删除仍被引用的凭据拒绝 |
| 3：MCP | Server 增删改、stdio/HTTP、工具策略与凭据 | 先修正 active SecretRef 回收边界，再开放写入；全部保持 restart；验证旧连接重连和重启恢复 |
| 4：部署与高级能力 | Telegram Token、Admin 参数、SecretRef 高级来源、Prompt 路径绑定；确有需要时提供存储切换/迁移流程 | 自身失联、Passkey 域名、宿主权限、数据迁移分别验证；初次启动和启动失败仍依赖部署入口 |

这是实现顺序建议，不表示只做前两阶段就达到字面级“所有 JSONC 字段可编辑”。如果目标是日常运营无需手改文件，前两阶段覆盖主要需求；如果要求完整替代文件编辑，必须完成 MCP、部署、高级凭据和文件绑定，并接受仍然存在首次引导/离线恢复边界。

不建议按 Schema 自动生成整张大表单：继承、SecretRef、Prompt 文件、引用迁移和混合生效规则都不是字段类型能表达的。可以复用字段校验和现有控件；无需引入第二套配置引擎。

## 实施验收要求

1. 每个开放字段验证：读取 saved/active、写入合法值、删除可选覆盖、并发 revision 冲突、未知字段拒绝、未管理字段与 JSONC 注释保留。
2. 生效结果验证真实消费点：忽略用户影响后续 ingestion；参与策略影响后续消息判定；Vision 下一次分析采用新输出上限；重启字段保存后仍使用旧运行值。
3. 写后 apply 失败时检查文件、active、错误状态和页面提示；修复后显式应用可恢复。不要只断言 HTTP 文案。
4. MCP 凭据替换/删除在重启前触发实际重连，证明旧运行态仍可使用；重启后再验证新凭据与旧条目回收。
5. 新管理端点验证 Session、Origin、Bearer 拒绝、密钥脱敏与请求体限制；改变 HTTP 连接地址时保持现有凭据重新提交防护。
6. Maintenance 保存不运行清理；用临时库执行 backup，验证保留天数、备份轮转与目录隔离。迁移前备份与常规 retention 任务分别验收。
7. 页面在真实 AdminServer + 构建产物下完成浏览器交互；涵盖英文 locale、继承、冲突、已保存但未应用、待重启与 outside_serve 提示。
8. 实施时运行受影响行为测试与 `pnpm run check`，跨模块改动运行完整 `pnpm test`；面板/API/文案变更运行受影响 `pnpm run admin:test:e2e` 套件。同步 `agent-doc/admin-panel.md` 写端点白名单、`configuration.md` 和用户指南。

本报告未把“扩大全量热更新”设为验收条件。若后续决定让 MCP/监听器/Token 等在线替换，应另做生命周期设计与验收。

## 本次验证证据与限制

本次没有修改 runtime、Admin 产品代码或实际运行配置，只新增这份报告。以下验证使用仓库现有实现和临时数据：

- `pnpm run admin:build` 成功，使用当前源码构建真实 SPA。
- 启动现有 `apps/admin-next/e2e/server.ts`，通过 Chromium 创建合成账号并观察 Chats 编辑器、群活跃时段编辑器、Models、Settings；已截图核对真实界面。
- 四个真实 HTTP 请求均返回 `400 invalid_body`：Chat 请求附加 `ignored_user_ids`；群 participation 附加 `trigger_keywords`；Vision 附加 `max_output_tokens`；Harness 请求 `telegram.bucket_window_seconds`。四次请求后配置 revision 未变。
- 合法 Harness 更新返回 200 且 saved/active 同步；新增 Chat 返回热应用；随后修改其 Topic 返回待重启，saved 是 `["88"]`、active 仍为不限制。
- 注入 fixture 的 apply 失败后，HTTP 返回 409，文件/运行值分离且 Settings 显示错误；再次 Apply 返回 200 并应用先前保存值。
- 直接运行 `validateFileConfig + diffConfig`，覆盖 15 类代表变更，证实 participation/ignored users/Vision output 为 hot，时区/Bucket/贴纸/MCP/Admin/web_fetch/数据库等为 restart，retention/备份路径为 outside_serve。
- 直接运行 `compileParticipation`，证实无配置与空对象不同，以及群空触发词仍继承全局关键词。
- 使用临时配置、合成 MCP header、真实 `writeConfigEdits` 和 `SecretStore`，证实旧 SecretRef 可被当前磁盘引用回收逻辑提前删除；没有执行真实 MCP 连接。
- 浏览器已关闭，隔离服务已正常退出（exit 0）；临时凭据验证目录已删除。

fixture 为随机监听端口在内存中改写了 `admin.port`，因此其 reload 结果额外包含 `admin.port` 待重启；这是测试宿主的已知差异，不是本报告发现的产品缺陷。

没有运行真实 Telegram、付费模型、生产 MCP、生产重启或数据迁移。也没有运行完整测试/类型检查：此次是研究与报告交付，证据为上述构建、浏览器、真实 HTTP 和临时运行实验；实施阶段的验收要求不代表已经执行。
