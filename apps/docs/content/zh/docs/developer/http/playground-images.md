---
title: 虚拟群聊与图片接口
description: 带身份的虚拟房间、Hold 与 Release、上传与房间内运行，以及图片工作台、素材与生图记录。
---

# 虚拟群聊与图片接口

这两块功能共用一页，因为它们的调用方是同一类脚本：想在不碰 Telegram 的情况下试行为。虚拟房间让真实 Agent 对着准备好的输入运行；生图工作台负责起草、生成与存放图片。

逐条清单在生成的[虚拟群聊与图片接口目录](endpoints-playground-images.md)里。

## 房间

房间是一个自带身份的假聊天。它永远「连接正常」，所以房间里的运行不需要 Telegram Token，而且永远不经过入场闸门。

| 路由 | 请求 |
| --- | --- |
| `GET /api/playground/rooms` | — |
| `POST /api/playground/rooms` | `{title, members?, request_key}` |
| `GET /api/playground/rooms/:id` | — |
| `GET /api/playground/rooms/:id/messages?before=&limit=` | — |
| `POST /api/playground/rooms/:id/messages` | `{request_key, sender_id, text?, reply_to_seq?, asset_ids?}` |
| `POST /api/playground/rooms/:id/participants` | `{name, role?, request_key}` |
| `PUT /api/playground/rooms/:id/hold` | —（空请求体即开启 Hold） |
| `POST /api/playground/rooms/:id/releases` | `{request_key, revision, through_seq}` |
| `GET /api/playground/rooms/:id/releases/:releaseId` | — |
| `POST /api/playground/rooms/:id/releases/:releaseId/retry` | `{attempt_key}` |
| `GET /api/playground/rooms/:id/assets` | — |
| `POST /api/playground/rooms/:id/assets` | `{content_base64, mime, name?}` |
| `GET /api/playground/rooms/:id/assets/:assetId/content` | —（字节） |
| `PUT /api/playground/rooms/:id/capabilities` | `{image_enabled, revision}` |
| `GET /api/playground/rooms/:id/invocations?limit=&offset=` | — |
| `GET /api/playground/rooms/:id/invocations/:invocationId` | — |

每个改状态的请求都带幂等键（`request_key`、`attempt_key`）：同一个键发两次返回原结果，`replayed: true`，状态是 `200` 而不是 `201`。计费 Release 超时后靠这个补发，不至于付两次钱。

房间状态：

- `title` 与身份 `name` 是 1–120 个可打印字符；`role` 是 `member` 或 `admin`；创建时最多 64 个成员。
- `hold` 是模式开关，不是请求字段：不带请求体的 `PUT` 打开它，`{"hold": false}` 会被 `400 release_required` 拒绝，因为关闭 Hold **就是**一次 Release。Hold 打开期间输入会排队而不是运行（`admitted: false`）。
- 一条消息带 `text`（最多 16384 字符）与可选的 `asset_ids`（最多四个上传到该房间的 32 位十六进制 ID）；`reply_to_seq` 指向更早的输入。
- `capabilities` 切房间的图片开关，请求体里带房间自己的 `revision`——房间计数器，不是配置版本。过期是 `409 room_revision_mismatch`。
- `assets` 是暂存的上传：`{content_base64, mime, name?}`，请求体最多 15000000 字节的 base64 文本（约 10 MiB 图片）。响应补上真实的 `width`、`height` 与 `sha256`；`GET …/content` 返回字节。

Release 是计费操作：它把 `through_seq` 之前的待处理输入封成一个消息批次并运行 Agent。

```bash
curl -sS -X POST http://127.0.0.1:8787/api/playground/rooms/7/releases \
  -H "Authorization: Bearer $SUROWAN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"request_key":"rel-1","revision":"12","through_seq":"4"}'
```

```json
{
  "release_id": "31",
  "through_seq": "4",
  "bucket_id": "1402",
  "invocation_id": "913",
  "replayed": false
}
```

它需要 `write+paid`。`GET …/releases/:id` 返回这次 Release、它的尝试（每次尝试是一次 Invocation）与它的发送记录，客户端据此区分「还在跑」和「Agent 选择沉默所以没发」。重试只接受已结算且没有副作用的尝试，否则 `409 retry_refused`；已经发过东西、或结果未知的那次尝试，面板同样不会让你重试。

房间内运行是隔离的：`GET /api/playground/rooms/:id/invocations` 只列这个房间的运行，一次一页 `limit`/`offset`（没有快照令牌），`…/invocations/:invocationId` 对属于别的房间的运行返回 `404`。

领域错误各有自己的码——`room_not_found`、`unknown_sender`、`unknown_asset`、`unknown_input`、`unknown_release`、`unknown_release`/`unknown_input` 对应坏的 `before`/`reply_to_seq`、`input_conflict`、`release_conflict`、`room_not_held`、`room_revision_mismatch`、`retry_refused`，状态映射见 [HTTP 公共约定](index.md)（未知为 404，状态冲突为 409）。

## 图片设置与模型

`GET /api/image/status` 返回 `{enabled, models}`：宿主到底接没接生图，以及它暴露了哪些已配置的生图模型。`GET /api/image/config` 是保存下来的那一段：

```json
{
  "revision": "…",
  "enabled": true,
  "credentials": ["openrouter"],
  "models": [{ "id": "…", "name": "…", "provider": "openrouter", "upstreamModel": "…", "credentialRef": "openrouter", "capabilities": { "…": "…" } }],
  "credential_key_sources": { "openrouter": { "kind": "keychain", "name": "openrouter" } }
}
```

`credential_key_sources` 只给面板 Session；凭据值永不返回。

`PUT /api/image/config` 带配置版本，两种形状之一：

- `{enabled: false}` 删掉整个 `image` 段，Keychain 条目留在原处，等待显式清理。
- `{enabled: true, credentials: {"<名称>": <密钥输入>, …}, models: [...]}` 写入这一段。每个模型的 `credentialRef` 必须指向同一请求体里的凭据、或已保存的凭据；模型 ID 不能重复；凭据传 `null` 表示保留已存的引用。明文密钥会变成 Keychain 条目，`{ "entry": "name" }` 复用已有条目。

响应是 `{enabled, apply}`——`enabled` 同时反映文件与实时 bridge，所以宿主没有图片 bridge 时，保存成功之后它仍可能是 `false`。

`GET /api/image/models` 列出上游目录（`{models}`），`GET /api/image/models/endpoints?model=<id>` 列出某个模型的 Provider 端点（`{endpoints}`）。两者都代理 OpenRouter 图片目录：模型 ID 不合法是 `400 invalid_model`，上游失败是 `502 image_discovery_failed`。

## 提示词素材与生图素材

两者都是带名称、说明与分类的目录行，都不需要 `If-Match`。

| 路由 | 请求 |
| --- | --- |
| `GET /api/image/prompts?q=&limit=&offset=` | — |
| `GET /api/image/prompts/:id` | — |
| `POST /api/image/prompts` | `{name, body, description?, category?}` |
| `PUT /api/image/prompts/:id` | `{name, body, description, category}` 中任意几项 |
| `DELETE /api/image/prompts/:id` | —（归档） |
| `GET /api/image/images?q=&limit=&offset=` | — |
| `GET /api/image/images/:id` | — |
| `GET /api/image/images/:id/content` | —（字节） |
| `POST /api/image/images` | `{name, base64, mime, description?, category?}` |
| `PUT /api/image/images/:id` | `{name, description, category, keywords, agentVisible}` 中任意几项 |
| `POST /api/image/images/:id/extract` | `{}` 或 `{model: {provider, model, thinking_level}}` |
| `DELETE /api/image/images/:id` | —（归档） |

- 提示词 `body` 为 1–32000 字符，且不能含 `{{…}}` 引用分隔符——素材之间不能递归引用。
- `q` 按文本过滤，`limit` 默认 30（1–100），`offset` 默认 0；列表是 `{items, total, limit, offset}`。
- 图片上传是 `{name, base64, mime}`，`mime` 取 `image/png`、`image/jpeg` 或 `image/webp`；解码后最多 20 MiB。
- `PUT /api/image/images/:id` 接受 `keywords`（单行文本）与 `agentVisible`。打开 `agentVisible` 就是允许聊天 Agent 跨会话找到它并当参考图用；这是管理员的决定，所以默认关闭。
- `extract` 是计费的一半：让一个能读图的模型看这张素材，提出名称与关键词。它不写任何东西——面板只是拿回复填编辑框，真正保存走 `PUT`。它需要 `write+paid`。默认模型是 Tool Model；`{model: {provider, model, thinking_level}}` 只覆盖这一次，并按实时注册表校验（`400 unknown_model`、`400 not_image_capable`、`422 unsupported_thinking_level`）。Tool Model 读不了图时返回 `409 tool_model_no_image_input` 并附上可读图的模型列表——正是覆盖选择器需要的那份清单。
- 归档就是删除：`DELETE` 返回 `{status: "archived"}`，行与字节留到服务压缩存储时才清掉。

## 生图记录

`POST /api/image/generations` 提交一次真实计费的生成。请求体是意图，由服务映射到图片核心的 Schema：

```json
{
  "prompt": "雨里的猫，{{image:6f0f…}}",
  "prompt_refs": ["…"],
  "input_image_refs": ["…"],
  "model_id": "openrouter/some-image-model",
  "aspect_ratio": "3:2",
  "resolution": "2k",
  "output_count": 2,
  "extended_data": {},
  "idempotency_key": "gen-2026-11-20-1"
}
```

- `prompt` 为 1–32000 字符；内联 `{{image:<素材 ID>}}` 引用就是让图片按顺序成为参考素材（「图 1」「图 2」…）。`prompt_refs` 与 `input_image_refs` 是同一想法的显式形式，会和内联引用合并成一个有序、去重的列表（最多 16 项）。
- `model_id`、`aspect_ratio`、`resolution` 与 `output_count`（1–10）由图片核心校验；合法 ID 与它支持的画幅去接口目录里的 `image model list` 查。
- `idempotency_key` 是 1–128 个 `[A-Za-z0-9._:-]` 字符。不传时服务器按用户名加当前秒派生一个键，所以只有自己带键时重试才是安全的。重放返回 `{generation, replayed: true}`，状态 `200` 而不是 `201`。
- `POST /api/image/generations/resolve` 走同样的校验，返回这次请求**将会**产生的快照，但不提交。它只需要读授权，是检查提示词最便宜的方式。
- `GET /api/image/generations/:id` 返回这次生成、它的快照、尝试与输出；`POST /api/image/generations/:id/retry` 重试一次已结算的生成（计费，同样要 `idempotency_key`）。未知 ID 是 `404 not_found`，素材已归档是 `409 already_archived`。

三条写路由都需要 `write+paid`：它们既改本地状态又花外部资源。`image/generations/resolve` 只需要读授权，素材与提示词路由需要写授权。

图片领域的错误消息可能由服务本地化；稳定的是 `error` 码，所以请按码分支，不要匹配文案。
