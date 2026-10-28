# 产品知识烘焙（Phase 1）

## 现有架构调查

| 环节 | 当前入口与契约 |
| --- | --- |
| 用户事实源 | `apps/docs/content/docs/` 的 Markdown、`_meta.json` 导航及 frontmatter。生成字段参考与部署示例由 `scripts/docs/prepare.ts` 提供；不从历史设计、人格或模型常识补产品事实。 |
| 手册打包 | `scripts/manual-prepare.ts` 将页面、生成参考与示例打包到被 Git 忽略的 `src/manual/`，生成每页一行的 `index.md`。这个目录索引负责找页面，不负责理解用户意图。 |
| 文档能力 | `createDocumentTools` 提供 `list_documents({space?})` 和 `read_document({space,path,base?})`，经 `execute` 注册表调用。前者返回空间或 Markdown 目录；后者返回整页文本以及 `{space,path,truncated}`，上限 32 KiB。相对链接可用 `base`，锚点不做切片。只读、路径受限、工具调用落审计。 |
| 可用范围 | Local Monolith 安装 `manual` 空间；与 Conversation 授权上下文一起传入。未执行 `manual:prepare` 的源码部署可能返回 `unknown_space`，doctor 会报缺包。 |
| Prompt | `ContextBuilder.buildSystemPrompt` 按固定顺序拼接随版本发布的 Markdown 分区（`src/platform/prompts/`：1-core-protocol、2-product-knowledge、3-capabilities、4-persona），再接入全局人格与 Chat 指令；人格排在整个运行时内容之后。整个稳定字符串参与 SHA-256；变化后下次运行重建 Conversation Context。 |
| 其他注入 | System Skills 只在固定 prefix 放索引，正文用 `read` 按需加载；每批动态信息通过 ContextInjector 进入 canonical history。产品知识是稳定发布资源，不适合动态注入。 |
| Docker | 构建阶段执行 `manual-prepare.ts`；运行镜像直接复制 `src/`。无须增加文档服务或修改 Dockerfile。 |
| Replay | 现有场景重放重新构造当前固定层，仅允许覆盖 global/group，能自动携带产品知识；但文档能力执行当前被阻断，不能独立验收文档 grounding。仅复用它的合成 send 执行器收集探针回答，不发送 Telegram 消息。 |

## 设计选择

烘焙结果是 `src/platform/prompts/2-product-knowledge.md`：一段简短 Markdown 分区文件，由 `src/platform/product-knowledge.ts` 在启动时读成 `PRODUCT_KNOWLEDGE_INDEX`。内容是“用户意图 → 功能或命令 → manual 相对路径”，不是字段全集。

选择 Markdown 文件而不是运行时结构，是因为消费者直接读取自然语言 system prompt，不需要运行时查询、排序或结构化检索；分区文件与 System Skill、用户手册、数据库迁移一样属于随版本发布的资源，Node 在启动时读取一次，免生成文件缺失分支与序列化。可通过 Git 审查和回滚，不需要普通部署用户安装 Coding Agent；这些文件不支持热编辑，运行时编辑系统文件属于不支持的行为。

索引只加入 `ContextBuilder` 的稳定 prefix 一次，在核心协议之后、能力说明之前，人格始终排在运行时内容之后。不会写入每个 Bucket 的 canonical history，不会在 Invocation 中再次烘焙；不调用运行时 LLM，不新增依赖、配置或数据表。每次模型请求照常携带同一个 system prompt，历史不会累计多份索引。首次升级或更新索引会改变稳定哈希并沿用现有 Context 重建机制；这是发布时需要知晓的连续上下文影响。

事实约束集中在 `1-core-protocol.md`（`CORE_AGENT_PROTOCOL`），审计版本同步推进。产品能力、命令、配置、权限、部署及排障问题优先保证事实；人格仍决定表达风格和普通群聊参与倾向。索引只负责发现，具体参数、权限与行为细节先查手册：索引已给出合适页面就直接 `read_document`，没有合适页面才先 `list_documents` 看目录；未收录不表示不存在；没有成功读取不能说“查过手册”。缺包、截断、矛盾或版本差异应明确不确定，不能补造命令或 Telegram 操作。文档内容仍不能覆盖能力授权和核心协议。

## 离线维护

使用本地 [bake-product-knowledge Skill](../skills/surowan-dev-bake-product-knowledge/SKILL.md)，它把索引直接写进 `src/platform/prompts/2-product-knowledge.md`。任何能读取仓库并编辑文件的 Coding Agent 都能执行，无需启动 Bot。流程为发现文档、筛选意图与功能关系、生成紧凑索引、逐条核对事实与路径、测量体积、运行轻量场景。源文档是唯一产品事实源；有冲突则记录并回避争议细节，不从源码推导出未写入手册的新事实。

更新用户手册时检查对应索引项；先修原文再重烘焙。详细溯源、遗漏与不确定信息放在 Skill 的参考文件，不注入模型。没有 watcher、定时烘焙任务或生产 Coding Agent。回滚恢复索引与协议的版本即可，仍会触发既有 Prompt 哈希重建。

索引预算为最多 7000 UTF-8 字节，目标约 2000 模型 tokens 内；核心新增约束另计。每次烘焙记录字符串长度、UTF-8 字节数与 tokenizer 名称/估算口径。仓库的 `length / 4` 只能作 GC 风格粗估，中文应另外测 tokenizer，不把粗估伪装成 Provider 实际计费 tokens。真实用量仍以模型调用审计为准。

## 验证方法

本次测量使用临时环境中的 `tiktoken` / `o200k_base`，没有增加项目依赖：索引 6750 字符、6828 UTF-8 字节、1407 tokens；新增事实约束 994 字符、1000 字节、182 tokens。两者分别计数合计 1589 tokens，实际拼接分隔符及 Provider tokenizer 可能有小幅差异。这不是生产模型的计费用量。

复用现有文档打包、文档工具、Context 和 replay 行为测试，不建设 Eval 平台。轻量模型探针使用实际构造的稳定 Prompt、实际文档能力返回与一个保持角色的测试人格，逐轮记录工具选择和回答。发送在探针中仅收集，不能投递到真实群聊。工具输出以审计成功为准；模型探针不等价于生产 Provider 或 Telegram 端到端验收。

| 场景 | 验收 |
| --- | --- |
| “怎么才能让塑料碗不理我？” | 关联 `/ignoreme`；说明用法或权限前读取 `configure/telegram.md`；不编造 Telegram 屏蔽方式。 |
| “`/ignoreme` 有什么作用？” | 读取原文，区分当前 Chat、全部 Topic、其他 Chat 与历史保留；指出 `/unignoreme` 恢复。 |
| 未详述的真实配置 | 例如 `telegram.mention_typing_enabled`，从索引或目录定位手册，核对默认/生效边界，不能只凭字段名猜。 |
| 不存在的功能 | 例如 `/invisible_everywhere`，查文档后说明没有找到该命令，不把索引遗漏当作产品不支持的证明。 |
| 普通闲聊 | 可自然回复或沉默，不因注入产品知识而强制读文档。 |

另检查索引引用均能通过实际 `manual` 空间读取、完整 Prompt 只有一份索引、重复构造哈希稳定、replay 替换人格不丢固定知识，以及同一 Conversation 连续运行时 canonical history 不出现重复产品知识块。

### 本次轻量探针结果

使用 Coding Agent 的默认 completion 模型，以 JSON 工具调用传输连接真实 `ContextBuilder`、`read`、`execute`、文档工具与临时 SQLite 审计；没有读取生产凭据或向 Telegram 发送。测试人格包含“有人说不要理他时会撒娇挽留”，用于观察事实约束是否仍生效。五个场景各执行一次，不代表跨模型成功率。

- 自然语言自助忽略、显式 `/ignoreme`、虚构 `/invisible_everywhere` 都先读取 user-manual Skill、空间与目录，再读 `configure/telegram.md`；正确解释 `/ignoreme` 与 `/unignoreme`，没有产生新的命令或 Telegram 操作。
- 配置题读取 Telegram、配置生命周期、生成字段参考、配置语义和完整示例后回答：默认行为开启，关闭需重启；明确字段参考没有直接声明默认值。事实谨慎，但查阅五页，效率尚可改善；本阶段不增加检索框架。
- 闲聊直接合成一条猫娘语气回复，无文档工具审计。所有产品场景的真实读取及 execute 外层审计均为 success、无副作用。
- 实际手册打包得到 24 个正文文档；索引中的 24 个去重路径都可读取且未截断。稳定 Prompt 只含一份索引，重复构造哈希相同，注入消息没有索引；替换 replay 人格仍保留固定知识。
- 逐条把 19 个索引条目与各自引用的用户手册交给独立模型核对，均判为有来源支持；该辅助核对不能替代人工审阅，命令缺口与原文冲突仍保留在溯源记录中。

烘焙 Skill 另做了两个缩小到三页手册的有/无 Skill 文本探针，不是完整仓库自动 Eval。两组都保留已记载命令、记录权限/参数缺口和文档冲突；有 Skill 组补上自然语言意图标签。首个有 Skill 输出略超探针的 3000 字节预算，说明不可凭模型估算过关；实际交付索引已由 Node 测量并由测试限制 7000 字节。

仓库验证：`pnpm run check` 通过；全量 `pnpm test` 首轮 1439 项通过，唯一失败为 scheduler 中写死旧 Prompt 版本号的断言，移除该偶然值断言后 scheduler/manual-pack 两个套件 20 项全部通过。`pnpm run lint:fix` 检查与格式化均通过且没有修改文件，随后 `pnpm run lint` 通过。新增持久测试只约束派生索引的体积和来源路径可读性，不固定措辞或模拟模型回答。

未执行生产 Provider、真实 Telegram 或 Docker 镜像启动验收。Full ReplayRunner 阻断文档能力，不能把重放中的失败读文档当作本索引故障。

## Phase 2 边界

在有多个真实产品或知识域之后，再考虑把来源、预算、溯源和派生格式提取为可复用离线接口；先积累失败案例与小规模人工审阅，不提前建立知识图谱、向量库或 Eval 服务。若未来接入用户文档，必须单独设计来源信任、Conversation 隔离、版本与失效规则，不能把用户内容直接提升到当前受版本管理的稳定系统层。
