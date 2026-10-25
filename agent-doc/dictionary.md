# 辞典与辅助模型

辞典用于解释群聊词语，不替代记忆或人格 Prompt。产品原始需求见 [辞典系统 PRD](design/archived/20261010%20辞典系统.md)；当前行为以源码与测试为准。

实现位置：辞典插件整体在 [src/plugins/dictionary/](../src/plugins/dictionary/)——存储与工具在 [dictionary.ts](../src/plugins/dictionary/tools.ts)，CSV/JSONL 核心在 [format.ts](../src/plugins/dictionary/format.ts)，注入渲染、去重与注入模式解析在 [injection.ts](../src/plugins/dictionary/injection.ts)（`ContextInjector` 契约见 [src/context/injector.ts](../src/context/injector.ts)），融合建议在 [merge.ts](../src/plugins/dictionary/merge.ts)，Tool Model 选择在 [src/platform/tool-model.ts](../src/platform/tool-model.ts)，Admin 端点在 [admin.ts](../src/plugins/dictionary/admin.ts)（由 [server.ts](../src/ingress/admin/index.ts) 引入），表定义在迁移 [034_dictionary.sql](../src/store/migrations/034_dictionary.sql)（表仍由核心 schema 持有）。行为测试见 [test/dictionary/dictionary.test.ts](../test/dictionary/dictionary.test.ts)。

## 作用域和信任边界

全局词条对所有正常会话可读；群组词条按 Telegram Chat 隔离，同群 Forum Topic 共用辞典，各 Topic 的 canonical Conversation Context 仍独立。私聊只读取全局辞典，不能通过群组写入能力维护词条。

Agent 只能创建或修改当前群组的词条，不能指定任意群、写全局或通过修改作用域提升词条。工具执行边界验证所属群，词条 ID 本身不是授权。Admin 管理端点只接受面板 Session，程序化 Bearer key 不获得辞典权限。

词条与导入文件、模型融合建议均是不可信数据，解释不能成为系统指令。自动注入写在 user 消息的不可信区块，不进入稳定 system prompt；词条内容变化不会单独重建整个 Conversation Context。

## 匹配、冲突和注入

Term 和 Aliases 区分大小写，按字面字符串在消息中匹配；匹配时忽略汉字与 ASCII 字母／数字之间的水平空白，例如 `AB钙` 和 `AB 钙` 等价。英文词之间的空格及换行不忽略，存储和返回的词条、别名原文不变。不使用向量、分词或模糊搜索。多个匹配保留多个解释，不做全局覆盖群级或自动合并。同一词条内的别名去重，不同词条可以同名。

冲突按当前有效辞典（全局 + 本群）检查规范化后相同的 Term/Term、Term/Alias、Alias/Alias；`AB钙` 与 `AB 钙` 也会报告潜在冲突，其他群的词条不参与。冲突不阻止写入、查询或注入，供管理员判断歧义是否需要处理。

注入模式为 `off`、`on_demand`、`aggressive`，默认 `on_demand`；可按 Chat 覆盖全局设置。`on_demand` 仅在命中时附带解释，`aggressive` 预加载有效词条。去重以实际保留的 canonical Context 为依据：同版本词条仍在保留段时不重注，随 checkpoint GC 淘汰后可以重注，更新可刷新。不能用永久的“已注入”数据库标记代替保留段状态。

辞典没有独立 Token 预算；必须与本批消息、已保留 transcript、工具定义和输出预留共享现有上下文窗口限制。新消息优先于额外预加载，不能为装下全量辞典突破窗口。Context GC 与缓存重建规则见 [Telegram 与 Agent 流程](telegram-agent-flow.md#context-生命周期)。

## 管理、导入与融合

CRUD 按独立 ID 操作，更新/删除携带词条 revision 防止旧表单覆盖并发修改。关闭词条阻止后续查询和自动注入，不抹去已持久化的历史文本。

导入核心与文件上传界面分离。CSV 使用标准单元格引号规则，Aliases 以 `|` 分隔，`\|` 表示字面竖线，`\\` 表示反斜杠；JSONL 使用字符串数组。预览只解析、校验、报告潜在冲突，确认批量导入在事务内创建新 ID，不按名称覆盖旧条目。导出文件重新导入会创建新条目。

融合分两步：Tool Model 产生建议，不修改词条；管理员审阅内容、明确目标作用域及来源保留/删除后确认保存。确认需检查来源 revision，保存结果和显式删除来源在同一事务内完成。模型失败不影响 CRUD、查询、注入、导入导出。

Tool Model 是系统级辅助模型选择，复用 Provider 注册表、凭据和 thinking 支持列表；未单独配置时继承全局 Agent 设置，不继承每 Chat 覆盖。辅助调用不接入生产 Agent Conversation Context。模型选择热应用，开始的调用钉住配置快照，模型错误与取消必须落终态审计（`model_calls.role = 'tool'`，不挂 `invocation_id`，不计入 Chat 的每日 Token 预算）。融合输出通过严格 Schema 校验，非法结构、空字段、超长字段或非正常停止记为失败；审计保留用量和耗时。

`lookup_dictionary` 通过 `offset` 分页返回 `{ entries, total, offset, next_offset, more }`，页面按实际 `execute` 信封编码体积限长，避免通用截断破坏 JSON。`more` 为真时必须继续取 `next_offset` 才能获取所有匹配。群作用域读取及写入同时解析 `chat_migrations`，迁移前后的同群词条继续可见，但不扩大到其他群。真实生命周期回归见 [test/dictionary/runtime.test.ts](../test/dictionary/runtime.test.ts)，覆盖 canonical 落盘、缓存重建、更新和 GC 后重注入；`context_injected.injections` 按注入器名记录本批实际注入数量（辞典的键是 `dictionary`）。

面向用户的步骤见 [辞典指南](../apps/docs/content/docs/guides/dictionary.md)。Admin 路由及写端点白名单见 [Admin Panel](admin-panel.md#api)，配置字段见 [配置](configuration.md#dictionary-与-tool-model)，表结构见 [数据层](data-layer.md#dictionary_entries迁移-034)，注入与能力边界见 [Telegram 与 Agent 流程](telegram-agent-flow.md#skills-与受控能力调用)。
