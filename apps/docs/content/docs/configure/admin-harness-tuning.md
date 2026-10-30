---
title: Harness tuning
description: 编辑 Agent 运行上限、发送规则、Context 保留与主动回复默认值。
---

# Harness tuning


Harness tuning 页集中编辑 `config.jsonc` 中 `agent` 段的运行参数：每日 Token 预算、并发、历史条数、Context 收尾比例、`send` 的文本规则与开关、发送限流、Conversation Context 的保留/裁剪/等待参数；「Proactive replies」一组编辑 `telegram.proactive_reply` 的全局默认值（开关、首次机会、每次增加、最多尝试次数，概率按 0–1 填写），单个群的覆盖仍在 **Chats** 页。Agent 模型与 thinking 档位仍在 **Models** 页，系统提示在 **Prompts** 页。

- 想对照 `config.jsonc` 时，在 **Panel preferences** 打开「显示 config.jsonc 键名」，每个字段下方会标出对应的配置路径（如 `agent.context.ref_ttl_hours`），可以对照[配置参考](../reference/config.md)。
- 可以一次改多项，点 **Save and apply** 一起写回 `config.jsonc` 并立即应用；**Discard changes** 恢复为文件里的值。只有真正改动的字段会写入文件，注释与格式保持不变。
- 超出范围的值在页面上直接标红；需要结合多个字段判断的规则（例如保留发送目标必须小于上限）由服务端校验，失败时文件保持不变并显示原因。
- **生效时机**：之后开始的 Invocation 使用新值，正在运行的 Invocation 继续用启动时的值。每日 Token 预算实时读取；引用有效期只影响之后签发或续期的引用；Agent 缓存数在下一次缓存时按新上限逐出，不会丢历史。
- 文件已写入但应用失败时，字段下会显示「Running: …」的运行值；修复后在 Settings 点击 **Apply config file**。
