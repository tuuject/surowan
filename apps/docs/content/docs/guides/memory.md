---
title: 管理 Memo Pad（Chat 记忆）
description: 按 Chat 共享的记忆：summary 与 Markdown 详情、可选期限、图片附件和 Admin Panel 管理方式。
---

# 管理 Memo Pad

Surowan 的记忆是一块 **Memo Pad**，属于一个 Chat：同一个群的所有 Forum Topic 共用一份，私聊各自一份，不同 Chat 互不可见。Topic 之间的 Context、消息与回复范围仍然隔离，只有 Memo Pad 是 Chat 级共享的。

每个条目有两层内容：

- **summary**：最多 150 字符，列表、搜索结果与自动注入看到的就是它。
- **detail**：最多 32768 字符的 Markdown，只有真正读取条目时才返回；图片以 `pwblob://` 引用。

不需要额外配置。期限由创建者（Agent 或管理员）在创建或修改时决定：

- 不设期限 = **长期条目**，不会自动出现在对话里。
- 设了期限 = **短期条目**，自动列进 Context，到期后不再注入，并在清理时删除。

## Agent 如何使用

- 短期且未过期的条目按创建顺序进入注入的 `<memo_list>`。列表预算约为 Context 窗口的 10%，超出时隐藏最早的条目并提示隐藏数量，模型可以搜索补回。
- 完整列表只在首批、Context 重建，或上次渲染列表的批次已被淘汰时重新发送；其他变化以 `<memo_updates>` 增量出现在消息之后。没有变化时不发送任何内容。
- 长期条目不注入。需要时模型用 `search_memory` 按关键词或创建日期搜索，再用 `read_memory` 读取详情。
- 新增、修改、删除条目与保存图片由 `add_memo`、`update_memo`、`delete_memo`、`save_memo_image` 完成，经由受控的 `execute` 调用。修改前必须先读取当前版本；如果读取后有人（包括面板）改过它，写入会被拒绝并要求重读。
- `save_memo_image` 把对话里可见的图片复制成 Chat 自己的 Blob，返回 `pwblob://` 地址；原图引用会随 Context 淘汰失效，Blob 不会。detail 不再引用某个 Blob，且同 Chat 没有其他条目引用它时，系统把行与文件一起清理；刚保存不到 10 分钟的 Blob 不会被清理，给写入 detail 留出窗口。

## 在面板查看和处理

1. 登录 Admin Panel，进入 **Memories**。
2. 按 Chat 或状态筛选：**Active**（未过期，含永久）、**Expired**、**Short-term**、**Long-term**。
3. 列表只显示 summary；点开后在详情弹窗查看 Markdown 全文与图片。
4. 新建、编辑或删除条目。期限留空即永久，填天数即短期；删除需要确认。
5. 需要长期稳定的知识仍应写进 `agents.md`，不要只放在 Memo Pad。

面板里的图片通过受控的字节端点读取，只在登录会话中可用；detail 里的 HTML 不会被执行。

## 何时生效

- 写操作成功即对后续读取可见；下一次该 Chat 的批次会以增量形式看到变化。
- 短期条目到期后不再出现在 Agent 的注入列表或搜索结果中，并在保留清理时删除（面板仍可用 Expired 筛选审阅待清理的行）。
- 修改 Prompt 或切换模型导致 Context 重建时，下一次运行会重新发送完整列表。
- 手改配置移除 Chat 只会停止它的运行并强制下次刷新，不会删数据；在面板删除 Chat 会立即停止并删除该 Chat 的 Memo Pad、Blob、Context 与消息。

## 常见误区

- Memo Pad 不是全局知识库：它按 Chat 隔离，Topic 共用。
- summary 是检索用的索引，不是完整内容；写得太含糊会让模型搜不到。
- 长期条目不等于「更重要」，只是不自动注入；需要模型随时知道的事实应设为短期条目，或写进 Prompt。
- 删除消息或切换模型不会清除 Memo Pad。
- 不要把 Token、API key 或其他凭据写进 Memo Pad。

相关页面：[管理面板](../configure/admin.md)、[Telegram 与 Topic](../configure/telegram.md)、[配置参考](../reference/config.md)。
