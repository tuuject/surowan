## Model Nickname

### 为什么要做？

塑料碗的 `/status` 命令会暴露 Provider 和 Model 名称。有些 Provider 是专门为赞助 Token 的朋友创建的，群友看到后经常询问 Provider 是什么、是不是中转站、能否介绍，每次解释很麻烦。

### 希望实现什么？

- 允许给模型设置 Nickname，例如「常用聊天模型 A」。
- 执行 `/status` 和 `/model` 命令时，可以只显示 Nickname，完全不暴露 Provider 名称和 Model 名称。
- `/model` 命令仍然采用现有交互方式：先查询模型列表，再输入对应的数字代号切换模型，不支持自定义输入模型名称。

## 打算怎么做？

### 配置

- 在 `providers.*.models[]` 的模型条目上新增可选字段 `nickname`（非空字符串）。粒度是模型而不是 Provider：同一个 Provider 下的不同模型可以有不同昵称。
- 不复用现有的 `name` 字段：`name` 来自 models.dev 等上游元数据，本身就是真实模型名。
- 昵称不要求唯一：`/model` 按序号切换，重名只影响回执可读性。
- Admin Panel 的模型编辑对话框增加昵称输入框；Admin Panel 是运维界面，继续显示真实 Provider 与 Model 名称。

### 显示规则

- 设置了昵称：只显示昵称，不显示 Provider、Model ID，也不显示括号里的 `name`。
- 没有设置昵称：保持现状，显示 `provider / model`。是否给模型设置昵称由运维自行决定，系统不做告警或拦截。

|场景|有昵称|无昵称|
|---|---|---|
|`/status` 的「本群模型」|昵称|`provider / model`|
|`/model` 菜单头的「本群模型」|昵称|`provider / model`|
|`/model` 列表每一行|`3. 常用聊天模型 A`|`3. agent / agent-model（Agent Model）`|
|`/model 序号` 切换成功回执|昵称|`provider / model`|
|`/model default` 回执中的「跟随全局」|昵称|`provider / model`|
|`/effort` 菜单头的「本群模型」|昵称|`provider / model`|
|`/effort` 的错误回执（模型未注册、不支持该级别）|昵称|`provider / model`|

### 交互

- `/model` 保持现有交互：列表、`/model 序号` 切换、`/model page 页码` 翻页、`/model default` 清除本群覆盖。不支持按名称或昵称切换。
- `/effort` 纳入本需求：菜单头的「本群模型」与其他回执同样改为显示昵称。
- `/effort` 展示的该模型支持的思考强度列表**不**纳入本需求：它由模型元数据决定，与昵称无关，保持现状输出。

### 模型自述身份

- 新增 prompt template 变量 `{{agent.nickname}}`：设置昵称时渲染为昵称，未设置时渲染为 `provider / model`，与表格中的显示规则一致。
- 运维可在 global / group prompt 层写「被问到身份时只输出 `{{agent.nickname}}`」。该变量与现有 `{{agent.provider}}`、`{{agent.model}}`、`{{vision.provider}}`、`{{vision.model}}`、`{{timezone}}` 同一套机制，校验与渲染复用 `src/platform/prompt-template.ts`。
- 厂商级系统提示词与模型自带的身份认知无法被本需求约束，属 out of scope。

### 实现要点

- 模型标签的拼接收敛到一个共用函数，`/status`、`/model`、`/effort` 都调用它，不再各自拼 `provider / model`。
- 昵称从配置文件的模型条目读取，修改后与其它模型字段一样热应用。

## 还有什么没想清楚？

- 无。
