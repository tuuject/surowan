---
title: Developer 调试开关
description: 记录模型请求报文与 Agent 思考过程的调试开关。
---

# Developer 调试开关


Developer 页提供两个调试开关，都写回 `config.jsonc`，保存成功后立即应用：

```jsonc
{
  "developer": {
    "record_model_payloads": false,
    "record_agent_thinking": false
  }
}
```

- **记录原始请求报文以便调试**：开启后在 Invocation 详情里保存模型调用的原始请求与响应快照，供排查问题；可能显著增加数据库占用。

整个 `developer` 节和其中的字段均可省略，缺省为 `false`。关闭后仍记录 Invocation、模型与工具调用、Token/缓存用量、费用、状态和错误；已保存的历史报文不会自动删除。开启会增加数据库占用，建议只在排查问题时启用。现有调试快照包含模型请求（内联图片正文替换为摘要）与 HTTP 响应状态，不保存完整响应流。

- **记录 Agent 思考过程（CoT）**：开启后把 Assistant 消息的思考文本（模型的 CoT）与 response 正文分开保存在 Agent transcript 与时间线里，可折叠查看；Agent transcript 依然只展示私有推理，不会发布到 Telegram。同样缺省关闭、可热应用，开启前的消息不补录。

「清除此前记录的原始请求报文」需要二次确认，只清除模型调用的请求/响应调试快照，不影响基于公开消息的场景重放。调用记录、关联关系和统计保留；详情页会显示报文未记录或已清除。记录开关仍开启时，新报文会继续保存。清除按批执行；若中途失败，已完成的批次不会恢复，可重试清除。清除不会删除 `thinking_text`：CoT 属于 Agent transcript 审计，随在线保留窗口一起清理。

SQLite 释放的页可供后续写入复用，但数据库文件不一定立即缩小。此操作不会执行 `VACUUM`，也不清理已有备份；备份与恢复仍遵循[原有维护流程](../operations/backup-restore.md)。
