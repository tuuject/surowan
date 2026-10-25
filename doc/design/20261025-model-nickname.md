## Model Nickname

### 为什么要做？

塑料碗的 `/status` 命令会暴露 Provider 和 Model 名称。有些 Provider 是专门为赞助 Token 的朋友创建的，群友看到后经常询问 Provider 是什么、是不是中转站、能否介绍，每次解释很麻烦。

### 希望实现什么？

- 允许给模型设置 Nickname，例如「常用聊天模型 A」。
- 执行 `/status` 和 `/model` 命令时，可以只显示 Nickname，完全不暴露 Provider 名称和 Model 名称。
- `/model` 命令仍然采用现有交互方式：先查询模型列表，再输入对应的数字代号切换模型，不支持自定义输入模型名称。

## 打算怎么做？

## 还有什么没想清楚？
