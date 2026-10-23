---
title: 编辑 Prompt 与版本历史
description: 编辑全局与按群 Prompt，并查看版本历史与差异。
---

# 编辑 Prompt 与版本历史


面板的 **Prompts** 页面直接编辑两层 Prompt：全局人格（配置里的 `agent.system_prompt_file`）与每个群的附加指令（`telegram.chats[].instructions_file`）。编辑的就是配置文件引用的那两个文件，保存写入去掉 HTML 注释后的正文，文件里原先的 HTML 注释不会保留；两层 Prompt 的含义、模板变量与手工修改方式见[配置人格与每群指令](../guides/personality.md)。这些操作只接受面板登录 Session，API 密钥不能编辑 Prompt。

- **生效时机**：保存后按热更新流程应用，**下一次**开始的 Invocation 使用新内容；正在运行的 Invocation 继续用启动时的快照。Prompt 变化会重建受影响的 Conversation Context，该会话下一轮按新的稳定提示重新开始。
- **并发保护**：编辑器基于打开时的 Prompt 内容哈希。文件在打开后被别人改过时，保存返回冲突并要求重新加载，不会静默覆盖；只改注释不算冲突，也不产生新版本。
- **版本历史**：每次保存追加一个版本；手改 Prompt 文件后，启动服务或下一次显式应用会把它记成 `external` 版本（去注释后内容与上一条相同则不记录）。恢复旧版本不会删除任何历史，而是追加一个 `rollback` 版本（默认备注 `Restored from version N`）。每个范围只保留最近 100 个版本，且不随在线保留期清理——Prompt 历史是配置，不是会话数据。任意两个同范围版本之间可查看 unified 风格的差异（上下文/删除/新增行与两侧行号）。
- **新建群指令**：某个群还没有 `instructions_file` 时，保存会在配置文件旁生成 `prompts/chat-<id>.md` 并把它补进配置；该路径已存在未被引用的文件时会拒绝保存而不是覆盖它。
- **取消仍按旧 Prompt 运行的 Invocation**：保存或恢复后，如果有仍在旧 Prompt 上运行的 Invocation，面板会先询问是否取消，不会自动执行。确认后只取消这些运行：它们已挂载但尚未注入的批次会过期，已发出的消息与已完成的效果不会被撤销；正在收集或已排队的批次不受影响，因为它们是尚未开始的 Invocation，会以新 Prompt 起步。
- **失败时**：Prompt 文件已写入、版本已记录但配置没有应用时，面板会明确提示；按显示的 `last error` 处理，不要当作已回滚。
