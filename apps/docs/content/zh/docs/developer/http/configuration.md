---
title: 配置、闸门与工具管理接口
description: 会写 config.jsonc 的那批接口——Provider 与模型、Prompt、Chat、入场闸门、运行参数、网络搜索、Telegram、贴纸集与出站 MCP 服务器，以及它们的冲突与应用结果。
---

# 配置、闸门与工具管理接口

本页的每条路由都在改 `config.jsonc`。它们共用三条规则，这里说一次，后文不再重复：

1. 请求带 `If-Match`，值来自 `GET /api/providers` 的 `revision`；缺少是 `400 revision_required`，过期是 `409 config_conflict`。
2. 写入先按文件自己的 Schema 与语义校验，**再**落盘，所以文件会拒绝的范围或枚举在这里就是 `400`，不会产出一个装不回去的文件。
3. 响应就是面板读的那份视图，外加 `apply: {applied, restart_required, outside_serve}`。含义见[保存了但没应用](index.md#保存了但没应用)。

请求体里的明文密钥会变成 Keychain 条目；`{ "entry": "name" }` 复用已有条目，且只有面板 Session 能引用条目。逐条的清单在生成的[配置接口目录](endpoints-configuration.md)里。

## Provider 与模型

`GET /api/providers` 是本页所有写操作的锚点，因为 `revision` 在它这里：

```json
{
  "revision": "0d6f2d…",
  "supervised": true,
  "agent": { "provider": "openrouter", "model": "…", "thinking_level": "medium" },
  "vision": { "provider": null, "model": null, "thinking_level": null },
  "tool_model": { "provider": null, "model": null, "thinking_level": null, "inherited": true },
  "restart_required": [],
  "providers": [
    {
      "alias": "openrouter",
      "kind": "custom",
      "api": "openai-completions",
      "base_url": "https://openrouter.ai/api/v1",
      "header_names": [],
      "models": [{ "id": "…", "name": "…" }]
    }
  ]
}
```

`agent` 里任何一项为 null 就表示启动不了运行。面板 Session 还能看到每个 Provider 的 `api_key_source` 与 `header_sources`；密钥与配对客户端看不到。

| 路由 | 请求体 | 说明 |
| --- | --- | --- |
| `POST /api/providers` | `{alias, kind: "builtin"｜"custom", provider?, base_url?, api?, api_key, headers?, models: [...]}` | `builtin` 需要 `provider`，`custom` 需要 `base_url` 与 `api`；1–200 个模型；请求体上限 512 KiB |
| `PUT /api/providers/:alias` | `{base_url?, api?, api_key?, headers?}` | 请求头设为 `null` 即删除，省略则保留；`builtin` Provider 只允许改 `api_key`，其他字段是 `400 immutable_field` |
| `DELETE /api/providers/:alias` | — | Agent、Vision 或任何 Chat 仍在用它时 `409 provider_in_use` |
| `POST /api/providers/:alias/models` | `{models: [...]}` | 追加模型定义 |
| `PUT /api/providers/:alias/models/:id` | 单个模型定义 | ID 必须百分号编码 |
| `POST /api/providers/models/delete` | `{models: [{provider, model}]}` | 一次删掉多个 Provider 的模型 |
| `DELETE /api/providers/:alias/models/:id` | — | 仍被引用时拒绝 |
| `PUT /api/model` | `{provider, model, abort_running?}` | 全局 Agent 模型 |
| `PUT /api/vision` | `{provider, model, thinking_level?}` | 独立的图片分析模型 |
| `PUT /api/thinking-level` | `{thinking_level}` | 保留每群覆盖 |
| `GET /api/provider-presets` | — | 面板可添加的内置 Provider 目录 |

`api` 是 `openai-responses`、`openai-completions`、`anthropic-messages`、`google-generative-ai` 之一。`custom` Provider 可以改 `base_url`，但密钥或配对客户端必须在同一个请求里重发 API key 与每个请求头的值（`400 credentials_required`），否则一段注入的提示词就能把已配置的凭据指向它自己的服务器；面板 Session 改地址则不需要重发。密钥字段接受明文字符串、`{ value, name? }` 或 `{ entry }`；明文在任何东西可能回显它之前就登记进 Keychain，所以被拒绝的写入也不会把它打印出来。

还有运行在用旧模型时切换 Agent 模型会被拒绝，而不是悄悄把它们弄坏：

```json
{
  "error": "model_in_use",
  "message": "3 running invocation(s) still use the current model; send abort_running: true to stop them and switch",
  "running_invocations": 3
}
```

带 `abort_running: true` 重发即中止它们——那几批消息不会得到回复——响应会同时给出 `aborted_invocations` 与新的 `revision`。`PUT /api/chats/:id` 换模型时对单个 Chat 用同一条规则。

发现与元数据是只读形状的 POST，什么也不写，所以不需要版本：

- `POST /api/providers/discover`——`{alias}` 用已保存的连接，或 `{kind, provider?, base_url?, api?, api_key?, headers?}` 临时连一次。临时连接只接受明文，不接受 Keychain 条目：本来就没有可复用对象，而允许条目引用等于让调用方拿已存的密钥去探测任意地址。返回 `{endpoint, models: [{…元数据, configured}], metadata_source_error}`；元数据拉取失败会报告出来，但不是致命错误。
- `POST /api/providers/lookup-metadata`——`{kind, provider?, base_url?, api?, ids: [...]}`（1–100 个 ID），给手填的模型 ID 补元数据。
- `POST /api/providers/health-check`——`{provider, model}`，计费。发一条真实提示词，返回 `{status, response_text, duration_ms, ttfb_ms, error}`。拒绝：`404 model_not_found`、`409 connection_not_applied`、`409 model_not_applied`、`409 model_not_registered`、`422 not_text_capable`、`429 health_check_busy`（同时最多三次）。

## Prompt

Prompt 是有版本的：每次保存都记一条版本，并发令牌是 Prompt 自己的内容哈希，不是配置版本。

| 路由 | 请求体 | 说明 |
| --- | --- | --- |
| `GET /api/prompts/versions?scope=global｜group&chat=` | — | 保留的版本，新的在前；`group` 必须带 `chat` |
| `GET /api/prompts/versions/:id` | 一个版本，含正文 |
| `GET /api/prompts/diff?from=&to=` | — | 同一作用域两个版本的 unified diff |
| `PUT /api/prompts/global` | `{prompt, note?}` | 最多 65536 字符；`If-Match` 是当前哈希 |
| `PUT /api/prompts/group?chat=<id>` | `{prompt, note?}` | 该 Chat 还没有文件时创建 `prompts/chat-<id>.md` |
| `POST /api/prompts/versions/:id/restore` | `{note?}` | 作为新的回滚版本恢复 |
| `POST /api/prompts/cancel-running` | `{scope, chat_id?}` | 只取消仍在旧 Prompt 上跑的运行 |

保存返回 `{status: "saved"｜"unchanged", version, applied, restart_required, affected_running, context_rebuild: true, active_hash, file_hash}`。`affected_running` 是仍在旧 Prompt 上跑的 Invocation 数，需要你自己显式取消。`context_rebuild` 不是统计值而是承诺：稳定 Prompt 变化后，受影响的会话 Context 会在下一次运行时重建。

值得处理的拒绝：`409 prompt_conflict`（别人先保存了）、`400 prompt_empty`（群指令会被创建成空文件）、`409 prompt_file_exists`（约定路径被一个配置没引用的文件占了）。

## Chat 与参与设置

`GET /api/chats` 返回 `{revision, items, defaults, models, global_participation, global_proactive_reply, effective_global_proactive_reply, timezone, restart_required, supervised}`：已配置的 Chat 及其保存值与活动值、全局默认，以及 Chat 可以选择的文本模型。下面每个写操作都是热更新，返回同一份视图外加 `aborted_invocations` 与 `apply`。

| 路由 | 请求体 |
| --- | --- |
| `POST /api/chats` | `{id, topic_ids, provider, model, thinking_level}` |
| `PUT /api/chats/:id` | 同样字段，外加 `abort_running?` |
| `DELETE /api/chats/:id` | — |
| `PUT /api/chats/:id/participation` | `{active_windows?, ask_only?}` |
| `PUT /api/chats/:id/decision-gate` | 闸门的六个行为字段 |
| `PUT /api/chats/:id/proactive-reply` | `{mode: "inherit"｜"off"}` 或 `{mode: "custom", base_probability, increment, hard_pity}` |
| `PUT /api/chats/:id/mcp` | `{mode: "inherit"｜"none"}` 或 `{mode: "explicit", bindings: [{server, tools?, tool_policies?}]}` |
| `PUT /api/chats/:id/group-memory` | `{enabled, idle_minutes?, thirty_hour_clock?}` |

字段名看不出来的部分：

- `id` 是字符串，必须是非零安全整数；`topic_ids` 是正整数数组或 `null`（全部 Topic）。
- `provider` / `model` 要么都给，要么都是 `null`（继承）；给 Chat 设模型覆盖时必须同时设 `thinking_level`，否则继承的思考强度会把全局默认绑死在这个 Chat 的模型上。
- `DELETE` 是两件事：先从白名单移除，再删它的数据。迁移别名仍然授权这个 Chat 时返回 `409 chat_still_authorized` 并保留数据；该 Chat 的工作还在停止时返回 `409 chat_delete_pending` 并保留数据。重新加载后再删一次即可完成。
- `participation.active_windows` 是整体替换：`null` 去掉覆盖（继承全局时段），`[]` 让该 Chat 只在被直接触发时活动。窗口形如 `{start, end, days?}`，时间是 `HH:MM`（`end` 也接受 `24:00`），`days` 是 ISO 星期 1–7。空窗口被拒，私聊根本不能配置参与设置。
- `ask_only: true` 把该 Chat 限制成只能 `/ask`：新桶长度为 0，且不留注意力窗口。`null` 去掉覆盖。
- `decision-gate` 只接受 `enabled`、`mode`、`threshold`、`history_messages`、`pending_messages` 与 `instructions`；`null` 去掉其中一项，全部去掉即继承全局段。`api_key`、`model`、`base_url`、`timeout_ms` 只能全局设置，私聊不能配置闸门。
- `proactive-reply` 的 `mode: "custom"` 必须给全三个数：`base_probability` 与 `increment` 在 0–1，`hard_pity` 是 1–100 的整数。
- `mcp` 的 `mode: "explicit"` 至少一条、最多 64 条绑定。整个候选文件都要通过校验，所以未知别名或服务器没有暴露的工具，会在这里按配置自己的规则被拒，而不是等到应用失败。
- `group-memory` 接受 `enabled`、可选的 `idle_minutes`（1–1440，`null` 去掉）与可选的 `thirty_hour_clock`（`off`、`non_overlapping`、`overlapping`）。

## 入场闸门（Decisions）

`GET /api/decision-gate` 和「运行参数」页一样，同时报告两侧：

```json
{
  "revision": "…",
  "saved": { "enabled": false, "mode": "shadow", "threshold": 0.57, "history_messages": 10, "pending_messages": 10, "instructions": "…", "model": "typesafe/jev-1.14", "base_url": "https://openrouter.ai/api/alpha", "timeout_ms": 3000 },
  "active": { "…": "…" },
  "key_configured": true
}
```

每个字段都带上实际生效的默认值，调用方不需要知道默认是什么。`key_source` 只给面板 Session 看，凭据本身永不返回。

`PUT /api/decision-gate` 是补丁语义：省略的字段保留，`null` 从文件里删掉该项，`api_key` 接受通用密钥输入或 `null`。范围来自配置 Schema（`threshold` 0–1、`history_messages` 0–50、`pending_messages` 1–50、`timeout_ms` 500–10000）；未知字段会被拒绝而不是忽略——这正是让手误不至于悄悄无效的原因。新密钥与文件编辑在同一次锁里写进 Keychain。

`GET /api/decision-gate/decisions?chat=&limit=&offset=&as_of=` 是 `shadow` 模式用来复盘的判定列表。它只读，不需要写授权。

## 运行参数与调试记录

`GET /api/harness` 返回 `{revision, saved, active}`，覆盖可编辑的 `agent` 字段与全局主动回复默认；`PUT /api/harness` 收 `{values: {"<字段>": 值}}`。字段键是所在段下的点路径，例如 `daily_budget.max_tokens`、`max_concurrency`、`context_stop_ratio`、`history_messages`、`send_max_text_length`、`send_nudge_enabled`、`send_barrier_enabled`、`send_duplicate_guard_enabled`、`send_empty_text_strategy`、`send_empty_text_fallback_texts`、`context.retained_sends_target`、`context.hard_token_ratio`、`context.ref_ttl_hours`、`context.idle_grace_seconds`、`context.max_wall_clock_seconds`、`context.agent_cache_size`、`rate_limits.sends_per_window`、`rate_limits.window_seconds`、`rate_limits.turns_per_injection`，以及四个 `proactive_reply.*`。`GET /api/harness` 的 `saved` 会列出全部可编辑键，读它就行，不要硬编码这份清单。未知键是 `400 invalid_body`；`null` 去掉可选字段，响应会给出运行时实际解析出的值。

`GET /api/developer` 显示调试记录开关与模型元数据目录地址；`PUT /api/developer` 保存 `record_model_payloads`、`record_agent_thinking` 与 `models_dev_url`（URL 字符串或 `null`，`null` 表示回退到 models.dev）。`DELETE /api/developer/model-payloads` 分批清除已存的请求与响应载荷——破坏性，并报告清了多少行。

## 网络搜索

`GET /api/search/config` 返回 `{revision, enabled, active, url_filters, engines, providers}`。每个引擎带 `id`、`provider`、`enabled`、`endpoint`、`results`、`timeout_seconds`、`note`、`key_configured`；Session 还能看到 `key_source`。`providers` 是已加载插件真正注册的东西，面板不会自己编一个。

`PUT /api/search/config` 整体替换这一段：`{enabled, engines: [...], url_filters: [...]}`。

- 最多 32 个引擎，每个是带 `id`（小写字母、数字、连字符，最长 32 字符）、`provider` 的对象，以及可选的 `enabled`、`endpoint`、`results`（1–10，仅当该 Provider 支持结果数）、`timeout_seconds`（5–30）、`note`、`api_key`、`keep_api_key`；
- `keep_api_key: true` 保留已存凭据，同时再发一个新 `api_key` 会被拒；
- `url_filters` 是服务器编译的 RE2 表达式，非法时返回 `400` 与该规则的消息。

`active` 可以在 `enabled` 为真时仍为假：开关打开但没有启用的引擎，就不算真的可用。

## Telegram 与贴纸集

`GET /api/telegram` 返回 `{revision, status, telegram_section_present, token_configured, bucket_timing: {saved, active}}`。`status` 是实时连接状态，Session 还会拿到 `token_source`——Token 本身永不返回。

| 路由 | 请求体 |
| --- | --- |
| `PUT /api/telegram/bucket-timing` | `{bucket_window_seconds?, bucket_max_seconds?, bucket_bump_seconds?}` |
| `PUT /api/telegram` | `{token: <密钥输入>}` 或 `{token: null}` |
| `GET /api/sticker-sets` | — |
| `POST /api/sticker-sets` | `{name, alias, note?}` |
| `PUT /api/sticker-sets/:alias` | `{alias?, note?}` |
| `DELETE /api/sticker-sets/:alias` | — |

消息批次时间热更新，但已经在收集的批次会保留它开启时的时序。三个数都是 0–300 的整数；`bucket_window_seconds` 不能删，另外两个接受 `null`（上限跟随窗口，延长值回退为 `0`）。跨字段规则——上限覆盖窗口、空闲宽限覆盖上限——要在整个文件上校验，所以单看没问题的值仍可能是 `422 config_invalid`。

`PUT /api/telegram` 只收一个字段。明文 Token 在验证前登记，`{ "entry": ... }` 复用 Keychain 条目，`{token: null}` 删除它——破坏性，因为它引用的钥匙串条目会被回收。Token 不允许带空白或控制字符。

贴纸集：`name` 可以是集名或 `t.me/addstickers/<name>` 链接，它的 Telegram 名就是身份，加上之后不能再改，只能改别名（昵称，`[A-Za-z][A-Za-z0-9_-]{0,63}`）与备注。增删一个贴纸集会中止正在跑的 Telegram 运行；被移除集合的索引会保留，方便以后重新添加。

## 出站 MCP 服务器

这里说的是 Bot 主动去连的服务器（`mcp.servers`），不是反向 `/mcp` 端点。`GET /api/mcp-servers` 返回每个服务器的实时状态、它宣告的工具、以及绑定它的 Chat；密钥或配对客户端拿到的是打码后的 URL，也没有密钥来源。

| 路由 | 请求体 |
| --- | --- |
| `POST /api/mcp-servers` | `{alias, url, headers?, tools, payload_max_bytes, result_max_bytes, tool_policies?, default_tool_policy?, exposure?, description?, skills?}` |
| `PUT /api/mcp-servers/:alias` | 同样字段，全部可选 |
| `POST /api/mcp-servers/:alias/description-draft` | —（计费） |
| `DELETE /api/mcp-servers/:alias` | — |

- stdio 服务器不能从面板创建或搬迁：它的 argv 是宿主机上的任意程序，只该由操作者在 `config.jsonc` 里写。创建时会返回 `400` 并说明这一点；编辑已有的 stdio 服务器只接受工具选择、上限、策略与呈现字段。
- `tools` 是 `"*"` 或显式列表；`payload_max_bytes` 为 1–1048576，`result_max_bytes` 为 1–32768。
- `exposure` 是 `direct`（每个工具各自成为一个工具）或 `progressive`（全部收进唯一的 `mcp` 网关工具）。省略表示保留当前值；`direct` 会删掉该字段，因为它是默认值。
- `description` 是模型用来挑服务器的说明；`null` 或空白字符串删除它。`skills: false` 让模型不再读取该服务器发布的 Skill。
- 起草接口是这张表单里计费的一半：让 Tool Model 给**正在运行**的服务器写一段说明，什么也不保存。它返回 `{alias, description, tool_model}`；文件与运行中的服务器不一致时 `409 mcp_server_not_applied`，服务器还没宣告任何暴露工具时 `409 mcp_server_not_ready`，没有 Tool Model 时 `502 tool_model_unavailable`。
- 仍有 Chat 绑定该别名时删除会被 `409 mcp_server_in_use` 拒绝；先用 `PUT /api/chats/:id/mcp` 解绑。

## 机器人管理员、警告与配置文件

- `GET /api/admins` / `POST /api/admins` `{telegram_user_id}` / `DELETE /api/admins/:id` 管理 `telegram.admins`，即允许运行 Bot 管理员命令的用户；ID 是正整数，重复添加是空操作。
- `GET /api/warnings?unread=&limit=&offset=&as_of=` 列出常态与事件警告以及未读数；`POST /api/warnings/:id/read` 把一条事件警告标为已读；`DELETE /api/warnings` 删除全部已存事件警告（破坏性）。
- `POST /api/config/apply` 重新读文件并应用可热更新的字段，返回 `{status: "applied", applied, restart_required, outside_serve, generation, active_hash, file_hash}`；被拒时是 `422` 加加载器的错误码。`GET /api/config/status` 只报告同样的数字，不写任何东西。

## Keychain 不在这里

`/api/keychain*` 管理上面所有表单写入的那些命名密钥。它是**仅面板 Session**：任何 API 密钥、配对客户端、CLI 命令或 MCP 工具都到不了，因为能列出或签发密钥就等于能自我提权。它的路由见[面板 Session 与凭据目录](endpoints-session.md)，操作流程见[管理面板、密钥与访问安全](../../guides/admin.md)。
