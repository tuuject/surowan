---
title: 审计、续跑与导出接口
description: 读取运行、用量与警告数据，下载媒体，真实续跑一次失败的运行，并弄清 Invocation 查询能过滤什么。
---

# 审计、续跑与导出接口

这一组接口回答「刚才发生了什么」。它们读运行期写下的审计表，其中只有 `POST /api/invocations/:id/resume` 会真的发动一次运行，可能发 Telegram 消息，也会花 Token。

逐条的接口清单在生成的[审计接口目录](endpoints-audit.md)里，本页说明每个接口返回什么、拒绝什么。

## 概览与用量

`GET /api/overview` 就是面板「概览」页的 JSON，不带过滤：

```json
{
  "generated_at": "2026-11-20T09:12:44.501Z",
  "invocation_states": [{ "label": "completed", "count": 812 }],
  "sticker_index_states": [{ "label": "indexed", "count": 240 }],
  "top_tools": [{ "label": "send", "count": 904 }],
  "daily_usage": [{ "resource": "agent", "metric": "model_tokens", "scope": "global", "amount": 812300 }],
  "runtime_status": { "sleeping": false, "sleep_until": null, "paused_chats": [] },
  "message_count": 24011,
  "cached_analysis_count": 118
}
```

`generated_at` 是服务器时钟，调用方据此分辨缓存与实时。`runtime_status.sleep_until` 只在睡眠期间有值，`paused_chats` 是面板里被暂停的 Chat。

`GET /api/usage?days=N` 每个 UTC 日返回一个点，没有活动的日子也在：

```json
{
  "days": 3,
  "series": [
    { "date": "2026-11-18", "model_tokens": 0, "vision_tokens": 0, "tool_calls": 0, "agent_invocations": 0 },
    { "date": "2026-11-19", "model_tokens": 120334, "vision_tokens": 4021, "tool_calls": 63, "agent_invocations": 21 }
  ]
}
```

`days` 默认 7，取值 1–90 的整数，其余是 `400 invalid_days`。Token 数来自每日用量记录，而 `tool_calls` 与 `agent_invocations` 是数审计表算出来的，所以它们和同一天的 `daily_usage` 行不一定对得上。

## 配置、Prompt 与模型视图

有三个只读视图，用来比对「正在跑的」和「磁盘上的」。三者都接受 `?source=active|file`，默认 `active`，其他参数一律 `400 invalid_query`。

- `GET /api/config/view`：脱敏后的配置。`active` 描述运行中的进程（`generation`、`active_hash`、`file_hash`、`restart_required`），`file` 重新读 `config.jsonc`（`file_hash`，文件无法安全加载时 `422 config_invalid`）。凭据、SecretRef 与命令 argv 永不出现。
- `GET /api/prompts/global`：全局人设模板。
- `GET /api/prompts/group?chat=<id>`：某个 Chat 的群指令。`chat` 必填，必须是已配置或已迁移的 Telegram Chat ID，否则 `400 invalid_chat` / `404`。

`GET /api/models` 列出活动配置里的文本模型（`{source, generation, models}`），不接受任何查询参数。`GET /api/key` 返回调用凭据自己的身份（见 [HTTP 公共约定](index.md)）。`GET /api/version` 返回 `{version, channel}`，同样拒绝查询参数。

这些都只是读。要改，去[配置接口页](configuration.md)。

## Invocation

`GET /api/invocations` 是列表接口。所有过滤条件都可选，且可以叠加：

| 参数 | 含义 |
| --- | --- |
| `state` | 精确的运行状态，例如 `failed`、`completed`、`running` |
| `host` | `telegram` 或 `playground` |
| `chat` | Telegram Chat ID；房间里的运行没有 Telegram ID，所以这个过滤会排除虚拟群聊的行 |
| `model` | **Agent** 调用实际用过的模型 ID；Vision 与辅助调用不参与匹配 |
| `search` | 必须出现在该会话某条消息里的文字 |
| `at` | 某一分钟/秒的时间窗口，按 Chat 或全局时区解析 |
| `from` / `to` | 下界（含）与上界（不含），语法同 `at` |
| `limit` `offset` `as_of` | [快照分页](index.md#快照分页) |

`at` 不能与 `from` 或 `to` 同时出现（`400 invalid_time_range`），消息过滤必须至少命中一条消息。每行带着运行期记下的计数（`sends_used`、`tool_calls_used`、`turns_used`、`tool_call_count`）、按日预算口径算出的 `total_tokens`（`cache_read_tokens` / `cache_write_tokens` 是它的拆分）、Provider 报告过的 `total_cost`，以及 Chat 身份块（`host_kind`、`telegram_chat_id`、`chat_type`、`message_thread_id`）。

`GET /api/invocations/:id` 返回详情：模型调用、工具调用、发送、这次运行保留的 Context 消息（新消息带 `source_bucket_id`，标明属于哪一批），以及 `buckets`：这次运行收下的每一批消息与模型读到它的时间 `injected_at`（还没读到或运行先结束时为 `null`）。它还带续跑判定，客户端据此只在点下去能成功时才显示按钮：

```json
{ "…": "…", "resume": { "available": true, "reason": null } }
```

不可续跑时，`reason` 就是续跑会返回的错误码（`resume_not_latest`、`resume_conversation_busy` 等）。

`GET /api/invocations/:id/prompts` 显示今天重放会用到的模板文本，特意不是当时那次运行用的文本。`GET /api/invocations/:id/replay-preflight` 回答能否重放，最多接受一个 `before_send_id`、一个 `provider`、一个 `model` 与一个 `thinking_level`，且不调用模型。

## 媒体与导出

Telegram 的字节留在服务器上，调用方只能点出快照授权的那些媒体。

- `GET /api/invocations/:id/media` 列出一次运行的媒体。
- `GET /api/invocations/:id/media/:media_id/content?variant=original|preview` 返回字节，带 `content-disposition: attachment`、`cache-control: private, no-store` 与 `x-plasticwan-media-variant`。`variant` 默认 `original`，除 `original`/`preview` 之外都是 `400 invalid_variant`。快照的授权核对已不成立时返回 `409`，而不是把文件发出去。
- `GET /api/invocations/:id/tools/:tool_call_id/images/:asset_id` 与 `GET /api/contexts/:conversation_id/messages/:seq/images/:asset_id` 提供工具产出或保留消息携带的图片。

没有批量审计导出接口，批改由面板从浏览器本地数据导出，其余就是这些读接口加上你自己脚本写的东西。[数据接口页](data.md)里的 `dictionary/export` 是唯一一个服务端文本导出。

## 消息、Context 与 Sticker

`GET /api/messages?chat=&search=&limit=&offset=&as_of=` 列出已入库的 Telegram 消息（新的在前，快照分页）。`GET /api/messages/:id` 返回一条消息的**全部修订**与媒体，包括编辑历史与那次修订记录的发送者。这是唯一保留编辑前文本的审计面，其他视图一律解析最新修订。

`GET /api/contexts?chat=` 列出会话 Context，一行一个会话，带保留消息数与活动指针。`GET /api/contexts/:id` 返回保留的消息与模型仍可读取的引用。Context 保存的是 Agent 实际看到的 canonical history（区别于 Chat 的原始聊天记录），按[调优指南](../../guides/tuning.md)里的 GC 规则裁剪。

`GET /api/stickers?set=&state=&search=` 列出 Sticker 视觉索引（`set` 用配置里的别名）。

## 续跑一次失败的运行

`POST /api/invocations/:id/resume` 用**当前**生效的配置，真实重跑该会话最近一次失败的运行。它需要 `write+paid`，可能发 Telegram 消息，也会花 Token。

```bash
curl -sS -X POST http://127.0.0.1:8787/api/invocations/912/resume \
  -H "Authorization: Bearer $SUROWAN_API_KEY"
```

```http
202 Accepted

{
  "invocation_id": "913",
  "bucket_id": "1402",
  "resumed_from_invocation_id": "912"
}
```

响应体指向**新的**运行，`resumed_from_invocation_id` 让客户端接上链条。拒绝原因写得很直白：

| 错误码 | 状态 | 含义 |
| --- | --- | --- |
| `not_found` | 404 | 没有这个 ID 的运行 |
| `resume_not_failed` | 409 | 只有 `failed`、`aborted` 或结果未知的运行能续跑 |
| `resume_not_latest` | 409 | 同一会话里已有更晚的运行 |
| `resume_conversation_busy` | 409 | 该会话已有排队或运行中的 Invocation |
| `resume_unsupported_host` | 409 | 虚拟群聊的运行走它自己的 Release 重试 |
| `resume_host_unavailable` | 409 | Telegram 已停用或未连接 |
| `resume_sleeping` | 409 | Bot 因为日预算在睡眠 |
| `resume_chat_removed`、`resume_topic_removed` | 409 | 该 Chat 或 Topic 已不在允许范围 |
| `resume_chat_paused` | 409 | 该 Chat 已暂停 |
| `resume_agent_unconfigured` | 409 | 该 Chat 没有完整的 Agent 模型配置 |

续跑不接受请求体，收到也忽略。运行是异步发生的，所以要轮询返回的 `invocation_id`（或用实时流）看它怎么结束。续跑本身会记一条管理员操作日志。

重放是同一家族的另一个操作，保证不同。`POST /api/invocations/:id/replay` 用可编辑的模板与模型覆盖重跑一次记录下来的 Invocation，计费，并且刻意不发送。它需要 `paid` 授权，请求体只接受 `before_send_id`、成对出现的 `provider` + `model`、`thinking_level`，以及两个 Prompt 模板（各最多 65536 字符），其他字段是 `400 invalid_body`。保真限制见 [Invocation 预检与重放](../replay.md)。

## 本页的运行控制

- `POST /api/cancel-ongoing-sessions` 中止所有运行中与排队的 Invocation，让它们的 Bucket 过期，返回 `{canceled_buckets, canceled_invocations}`（运行中的也计入后一个数）。这是破坏性操作，那些运行正在回答的批次不会得到回复。
- `POST /api/wake` 清除持久化的睡眠状态并唤醒调度器，`was_sleeping` 告诉你它到底做没做事。
- `POST /api/restart` 返回 `202 {status: "restarting"}` 并以重启码退出。只有部署声明了 supervisor（`PLASTICWAN_SUPERVISED=1`）时才存在，否则 `409 restart_unsupported`。
