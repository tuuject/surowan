---
title: 知识与闹钟数据接口
description: Memo Pad 条目与 Blob、辞典的导入与合并流程、群聊记忆事件、一次性提醒与循环闹钟。
---

# 知识与闹钟数据接口

这组接口读写 Bot 为自己留下的那些行：记忆条目、辞典、整理好的群聊记忆事件、一次性提醒，以及管理员定义的循环闹钟。它们都不改 `config.jsonc`，所以都不带配置版本；带版本的行用自己的版本号。

逐条清单在生成的[数据接口目录](endpoints-data.md)里。

## Memo Pad

一条 Memo 属于一个 Chat（它的所有 Topic 共用），有简短 summary 与 Markdown detail。Memo ID 形如 `mem_<32 位十六进制>`，不是十进制。

| 路由 | 请求 |
| --- | --- |
| `GET /api/memories?chat=&state=&limit=&offset=&as_of=` | — |
| `GET /api/memories/chats` | — |
| `POST /api/memories` | `{chat_id, summary, detail, ttl_seconds?}` |
| `PUT /api/memories/:id` | `{summary?, detail?, ttl_seconds?}` |
| `DELETE /api/memories/:id` | — |
| `GET /api/memories/blobs/:id/content` | —（字节） |

- `chat_id` 是 Telegram Chat ID；Bot 从没见过的 Chat 返回 `404 chat_not_found`。
- `summary` 1–150 字符，`detail` 1–32768 字符。这两个接口的请求体上限是 256 KiB，因为转义会把完整 detail 撑大。
- `ttl_seconds` 是 60–157680000（五年）或 `null`。创建时不传就是永久条目；更新时传 `null` 会把限期条目变成永久。
- `state` 过滤列表：`active`、`expired`、`short`（有期限且仍有效）、`long`（永久），其他值 `400 invalid_state`。
- 每项都给出 `expires_at`、`remaining_seconds`、`expired` 与 `short_term`，客户端不必拿自己的时钟再算一遍。
- `PUT` 至少给三个字段之一。改 detail 会顺带清理旧文本引用的 Blob，`DELETE` 删掉条目以及只有它引用的 Blob。
- `GET /api/memories/blobs/:id/content` 返回图片字节，带 `content-disposition: inline` 与 `cache-control: private, no-store`。Blob ID 是 `blb_…`，其他形式 `400 invalid_id`，文件缺失 `404`。

Blob 由 Agent 在会话里上传，不经过这些接口；这里只负责读取与清理。操作流程见[管理记忆与辞典](../../guides/knowledge.md)。

## 群聊记忆

群聊记忆是生成的，不是手写的：sleeping 任务把一个安静的 Chat 整理成若干事件，每个事件带一段 Telegram message-id 区间。这里只有 summary 可改。

| 路由 | 请求 |
| --- | --- |
| `GET /api/group-memories?chat=&day=&search=&limit=&offset=&as_of=` | — |
| `GET /api/group-memories/progress` | — |
| `GET /api/group-memories/runs?chat=&state=&limit=&offset=&as_of=` | — |
| `GET /api/group-memories/:id/messages` | — |
| `PUT /api/group-memories/:id` | `{summary}` |
| `DELETE /api/group-memories/:id` | — |

- 事件 ID 是 `gmem_<32 位十六进制>`；`day` 是 Chat 本地日期 `YYYY-MM-DD`，并按这个格式校验。
- `summary` 1–200 字符，会去掉首尾空白；全空白是 `400 invalid_body`。
- `GET …/:id/messages` 用事件保存的区间去读当前的消息行，超过读取上限时截断并追加标记——和 Bot 的 `read_group_messages` 用同一个上限。
- `progress` 是运维视图：每个 Chat 的通道、积压、退避与近期失败。`runs` 列出整理批次及其结果与失败原因。
- `DELETE` 删掉事件，但**不**回拨 sleeping 水位，所以同一批消息不会再被整理一次。就这点而言删除是最终的。

30 小时制（`thirty_hour_clock`）是每群设置，写在[配置接口页](configuration.md#chat-与参与设置)；它改的是按日期检索事件的范围，不是这里的行。

## 辞典

辞典条目属于全局作用域或某一个 Chat，它的 `revision` 是编辑的乐观锁。同名冲突会被报告出来，但不会被拦——一个词条本来就可以有多条记录。

| 路由 | 请求 |
| --- | --- |
| `GET /api/dictionary?scope=&chat=&search=` | — |
| `GET /api/dictionary/chats` | — |
| `POST /api/dictionary` | 一条草稿 |
| `PUT /api/dictionary/:id` | 草稿，`If-Match: <条目 revision>` |
| `DELETE /api/dictionary/:id` | `If-Match: <条目 revision>` |
| `GET /api/dictionary/settings?chat=` | — |
| `PUT /api/dictionary/settings?chat=` | `{injection_mode}` |
| `POST /api/dictionary/import/preview` | `{format, content, scope, chat_id}` |
| `POST /api/dictionary/import` | `{entries: [...]}` |
| `GET /api/dictionary/export?scope=&chat=&format=csv｜jsonl` | — |
| `POST /api/dictionary/merge/preview` | `{ids: [...]}`（计费） |
| `POST /api/dictionary/merge` | `{entry, sources, delete_sources}` |

草稿是 `{term, definition, aliases: string[], scope: "global"｜"group", chat_id, enabled}`。全局条目不写 chat，群条目必须写；两条规则违反都是 `400 invalid_body`。`If-Match` 过期是 `409 dictionary_conflict`——专门的错误码，因为这是行冲突而不是配置冲突。

- `GET /api/dictionary` 返回该作用域的条目与同名冲突。`scope` 必填，`group` 必须带 `chat`。
- 设置：`injection_mode` 为 `off`、`on_demand`（默认）或 `aggressive`；`null` 清掉某个 Chat 的覆盖，但不能清全局模式。视图给出 `injection_mode`（全局）、`override_mode`（该 Chat，可能为 `null`）与 `effective_mode`。
- 导入是两步。`preview` 解析 CSV 或 JSONL 文档（最多 2000000 字符），返回规范化后的草稿，以及把文件自身行也算进去的冲突；`import` 在一个事务里创建最多 2000 条。预览不写任何东西，重复无成本。
- `export` 返回可下载的 `text/csv` 或 `application/x-ndjson` 正文，带 `content-disposition` 文件名。
- 合并也是两步。`merge/preview` 接受 2–20 个条目 ID，调一次 Tool Model，返回建议与源条目——计费，且不保存。`merge` 接受最终草稿、带版本的源 ID 列表与 `delete_sources`；删除源条目是不可逆的，所以它是破坏性操作。
- `PUT /api/tool-model` 设定辅助模型，供合并、群聊记忆整理、MCP 描述起草与素材提取使用：`{inherit: true}` 跟随 Agent 模型，`{provider, model, thinking_level}` 固定一个。

## 一次性提醒

`GET /api/alarms?state=&chat=&target=&limit=&offset=&as_of=` 列出长期任务的 Alarm 投影。`state` 是 `pending`、`firing`、`fired` 或 `cancelled`，其他值 `400 invalid_state`。

`DELETE /api/alarms/:id` 取消一条待触发的提醒，返回 `{status: "cancelled"}`。只有待触发状态能取消：其他状态是 `409 alarm_not_pending`，未知 ID 是 `404 not_found`。提醒由 Bot 在会话里创建，不经过这个接口。

## 循环闹钟

循环闹钟是管理员定义的：在一条规则上把一段可信提示词投进一个目标，有自己的时区与触发记录。创建、更新与立即执行会让 Bot 在没有人在场、且越过日预算的情况下调用模型，所以这三条路由需要 `write+paid`。

| 路由 | 请求 |
| --- | --- |
| `GET /api/recurring-alarms?chat=&enabled=&limit=&offset=&as_of=` | — |
| `GET /api/recurring-alarms/targets` | — |
| `POST /api/recurring-alarms/preview` | `{rules, time_zone}` |
| `POST /api/recurring-alarms` | `{chat_id, message_thread_id, title, prompt, rules, input_mode, time_zone, enabled}` |
| `GET /api/recurring-alarms/:id` | — |
| `PUT /api/recurring-alarms/:id` | 草稿字段，`If-Match: <闹钟 revision>` |
| `DELETE /api/recurring-alarms/:id` | — |
| `POST /api/recurring-alarms/:id/run` | — |

- `rules` 是规则数组；`input_mode` 为 `builder` 或 `cron`，表示规则是怎么写的。`time_zone` 是 IANA 名，全局时区改动不会影响已建闹钟。
- `preview` 在没有保存的情况下校验 `{rules, time_zone}`，返回 `{next, issues, time_zone, short_interval}`：最多五次未来触发（UTC 时间戳）、逐规则问题、规范化后的时区，以及是否有两次触发间隔不到五分钟。它只需要读授权。
- `POST` 对不是已配置 Chat、Topic 或虚拟房间的目标返回 `409 target_unavailable`，对超量返回 `409 too_many_recurring_alarms`。
- `targets` 列出可作目标的会话，并给出 `default_time_zone`——新闹钟默认从哪个全局时区开始。
- 规则不合法是 `400 invalid_rules` 并带 `issues` 数组；时区、标题或提示词不合法各有自己的 `400` 错误码。
- `PUT` 整体替换定义（包括启用与停用），需要这一行自己的版本；过期是 `409 revision_conflict`。
- `DELETE` 删掉闹钟并抑制它尚未投递的那次触发。
- `run` 让已保存的闹钟在计划之外立即触发一次，返回 `{firing_id, task_id, occurrence_at}`。它产生的 Invocation 是一次普通运行，会出现在审计列表里，也可以像别的一样续跑。

详情视图里的触发记录带最近 50 次触发，含结果、跳过原因与它们产生的 Invocation。上一次触发还没处理完时再次触发会被 `409 previous_pending` 拒绝。
