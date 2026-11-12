---
title: 管理记忆（Memo Pad 与群聊记忆）
description: 按 Chat 共享的 Memo Pad 与可选的群聊记忆：摘要、详情、期限、图片附件、事件回忆与 Admin Panel 管理方式。
---

# 管理记忆

Surowan 有两类记忆：模型主动维护的 **Memo Pad**，以及可选的 **群聊记忆**。两者都属于一个 Chat：同一个群的所有 Forum Topic 共用一份，私聊各自一份，不同 Chat 互不可见。Topic 之间的 Context、消息与回复范围仍然隔离，只有记忆是 Chat 级共享的。

Memo Pad 的每个条目有两层内容：

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

## 群聊记忆（sleeping）

群聊记忆是另一项可选能力，用来记住群里发生过的事件，而不是模型主动保存的资料。它默认关闭，需要按 Chat 在配置里开启：

```jsonc
{
  "telegram": {
    "chats": [
      {
        "id": -1001234567890,
        "group_memory": { "enabled": true, "idle_minutes": 30 }
      }
    ]
  }
}
```

也可以直接在 Admin Panel 的 **Chats** 页点击群聊行的「群聊记忆」按钮开关。开关状态变化会先中止该 Chat 所有正在运行的 Invocation，并在请求返回前重建它的全部 Conversation Context。

开启后，后台 sleeping 整理会在群里安静 `idle_minutes` 分钟（或某个本地日期已经结束）时，把开启之后收到、还没整理的消息交给系统辅助模型，生成按日期组织的事件摘要。开启前的聊天记录不会被补整理；关闭再开启时，关闭期间的消息同样跳过。每条摘要都带对应的原始消息 ID 区间，例如：

```text
- gmem_... [2026-10-01; messages 4005-4114]: Natu 和 tcdw 讨论了 eSIM 的价格。
```

回忆分两层，模型按需调用：

1. `search_group_memory`：按 Chat 本地日期、关键词或条数上限查询事件摘要，只返回摘要与消息区间。
2. `read_group_messages`：用摘要带的 `first_message_id` / `last_message_id` 读取原始消息，核对当时的上下文。

要点：

- 群聊记忆按 Chat 共享，Topic 共用；不同 Chat 的摘要与原文互不可见。
- 摘要不会自动注入对话，只在模型判断需要回忆时查询，因此不会挤占普通上下文。
- 整理使用系统级 `tool_model`；未配置时继承全局 Agent 模型。这个后台调用不计入每日 Agent Token 预算，但全局 `zzz` 睡眠期间不会运行。
- 同一个 Chat 有正在运行或排队的对话、或正在收集新消息时会跳过一次整理。
- 群里执行 `/pause` 后整理也会暂停；`/resume` 后继续，暂停期间积压的消息会补整理。
- 整理落后超过一天（例如服务停机或模型连续失败）时，较早的积压会交给单独的回填通道，昨天和今天的消息不必等它清完；两边互不重复、互不遗漏。
- 系统辅助模型偶尔输出不合格时，会带着具体原因再请求一次；仍不合格则这一批 30 分钟后重试，不影响其它群和同一个群的其它通道。
- 不再需要时，可在配置里把 `group_memory.enabled` 改为 `false`；已有摘要与原文保留，模型不再获得回忆工具。之后重新开启只整理重新开启以后的消息。需要彻底清理时请连同 Chat 一起删除。
- 聊天消息、Revision、Media 与 Conversation Context 不再随在线保留窗口清理，会一直保留到 Chat 被删除；`read_group_messages` 可回溯任意保留区间的原文，磁盘占用也随聊天量增长。
- Admin Panel 的 **Group memory** 页顶部是「整理进度」：每个开启的群一行，显示已经整理到哪个时间、还有多少条待整理、回填进度、最近一次成功，以及连续失败时的原因和下次重试时间；「查看批次」列出最近每一批的结果。下方的事件列表可以按 Chat、日期或摘要筛选，查看原文区间、修改 summary（最多 200 字）或删除事件。删除不会回退整理进度，因此同一段聊天不会被重新总结；数据随 Chat 删除。

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
