---
title: HTTP 公共约定
description: 基路径、三种鉴权方式、四种权限模式、Origin 检查、ID 编码、快照分页、并发版本、错误与计费调用。
---

# HTTP 公共约定

面板上的每个动作都是管理面板地址下 `/api` 的一条路由。本页写的对所有路由都成立，本目录另外四页分别说明各组接口收什么、返回什么，生成的[接口目录](endpoints-audit.md)则把它们逐条列全。

`/mcp` 的反向 MCP Server 是另一个入口，它只接受 Bearer API 密钥，说的是 JSON-RPC，见 [MCP Server](../mcp-server.md)。

## 基地址

面板监听 `admin.host` 与 `admin.port`，在同一来源上提供 `/api` 路由。`admin.public_url` 是反代后面浏览器实际访问的地址，同时也固定了每个写请求必须携带的 `Origin`。配置见 [Admin Panel 服务配置](../../configuration/admin.md)。

- 路由形如 `/api/<route>`，接口目录写的是含 `/api` 的完整路径。
- 路径里没有版本段。要对应版本，用 `GET /api/version`，见[选择接口](../index.md)。
- 方法只有 `GET`、`POST`、`PUT`、`DELETE`，其他方法在鉴权之前就返回 `405 method_not_allowed`。
- 请求体是 JSON 对象。不检查 `Content-Type`，但正文必须能解析成 JSON 对象。
- 每个 JSON 响应都带 `cache-control: no-store`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer` 与 `x-frame-options: DENY`。没有任何 CORS 头，所以浏览器不会让你跨来源读 `/api` 的响应，面板和它的接口本来就该同源。
- 请求体默认上限 8 KiB（各路由按需放宽，最大的是 30 MB 的图片上传），超限是 `413 body_too_large`。

## 三种鉴权方式

服务器按请求携带的东西依次判断：

1. `POST /api/pairing/claim`：唯一签发客户端凭据的写接口，所以也是唯一不需要凭据的那条。领取配对码本身，就是客户端拿到凭据的方式。
2. `Authorization: Surowan-Signature …`：已配对客户端的签名请求。
3. `Authorization: Bearer …`：API 密钥。
4. `plasticwan_admin` Cookie：面板 Session。

带 `Authorization` 头的请求永远不会退回使用 Cookie，密钥无效就是这个请求无效，哪怕浏览器同时有合法 Session。这是故意的，密钥不能借走 Session 更大的权限。

### 面板 Session

`POST /api/auth/login`（用户名与密码）或 `POST /api/auth/pairing`（服务器上 `pairing create --web` 打印的一次性码）会下发 Session Cookie：

```
set-cookie: plasticwan_admin=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<admin.session_ttl_hours × 3600>[; Secure]
```

请求走 HTTPS、或浏览器发来的 `Origin` 是 `https://` 时追加 `Secure`，所以 TLS 终止的反代下 Cookie 依然安全，而明文 HTTP 的 loopback 面板照样能用。Cookie 是 `HttpOnly` 的，JavaScript 读不到，`/api/live/*` 上的 Server-Sent Events 路由也正是因为 `EventSource` 无法携带 `Authorization` 头才存在。

`/api/api-keys*`、`/api/keychain*` 与 `/api/live/*` 需要 Session。`/api/auth/*` 里除了在 Session 闸门之前就被应答的那几条（登录、未登录时返回 `authenticated: false` 的会话探测 `GET /api/auth/session` 与登出），其余也都需要 Session。API key 与已配对客户端在所有这些路由上都会被拒绝。见[仅面板 Session 的边界](#仅面板-session-的边界)。

### Bearer API 密钥

```
Authorization: Bearer pwk_<32 字节随机数的 base64url>
```

数据库只存 SHA-256 摘要，所以明文只在创建或轮换的响应里出现一次。`GET /api/key` 返回调用者自己的身份：

```json
{
  "id": "3",
  "name": "coding-agent",
  "mode": "read_write",
  "permissions": { "read_all": true, "write_all": true, "execute_paid_operations": false },
  "kind": "api_key"
}
```

未知、已撤销或权限组合非法的密钥统一返回 `401 unauthenticated`。通过鉴权但缺少该路由所需授权的返回 `403 forbidden`，消息会说明缺哪项授权。未知路径对密钥返回 `403` 而不是 `404`，避免枚举面板。`last_used_at` 在每次鉴权成功时更新，包括随后被权限闸门拒绝的请求，`401` 不更新。

### 配对客户端签名

用 `surowan-utils auth pair` 配对过的客户端，用 Ed25519 为每个请求签名：

```
Authorization: Surowan-Signature v=1,client=<客户端 ID>,ts=<Unix 秒>,nonce=<16–64 位 base64url>,sig=<86 位 base64url>
```

签名覆盖一段固定的规范化字符串，一行一个值，用换行分隔：

```
SUROWAN-SIGNATURE-V1
<实例 ID：ins_ 加 22 位 base64url 字符>
<客户端 ID：十进制字符串>
<HTTP 方法，大写>
<目标：/api/… 加原样发送的查询字符串>
<时间戳：Unix 秒，十进制>
<nonce>
<正文摘要：base64url(sha256(原始请求体字节))>
```

实例 ID 就是 `pairing create` 打印、客户端配对时记下的 `ins_…`。空正文的摘要就是零字节的摘要，不豁免。排查签名被拒时，验证顺序本身就是线索：

1. 请求头形状与字段格式。格式不对是固定的 `401 unauthenticated`，不回显请求头的任何部分。
2. 客户端存在且未被撤销。未知与已撤销同一个 `401 unauthenticated`。
3. 时间戳在服务器时钟 **±300 秒**以内。超出是 `401 signature_clock_skew`，消息带上实测偏差，这通常是容器时钟漂移，不是密钥坏了。
4. 读完正文（最多 32 MiB），按规范化字符串验签。
5. 正文到达之后**再次**检查时钟与客户端状态，所以慢慢传了几分钟的请求不能用过期时间戳通过，传一半被撤销的客户端也不会被派发。
6. 记录 nonce。重复使用是 `401 signature_replayed`。nonce 保留到 `时间戳 + 301` 秒（覆盖窗口最后不足一秒的边界），重启后仍然拒绝。

第 6 步之前不改任何状态，所以重放尝试不会消耗掉一次失败签名本来就用不到的 nonce。

## 权限模式

每条路由声明四种访问要求之一，密钥或配对客户端必须持有该要求点名的每一项授权：

| 模式 | `read_all` | `write_all` | `execute_paid_operations` | 能做什么 |
| --- | --- | --- | --- | --- |
| `read` | 是 | 否 | 否 | 全部审计读取、脱敏的配置与 Prompt 视图、模型列表、Invocation 查询、媒体下载、重放预检 |
| `read_write` | 是 | 是 | 否 | 读取加配置、Chat、Prompt、Memo、辞典、群聊记忆、警告与虚拟群聊输入等写入，不含计费调用 |
| `read_paid` | 是 | 否 | 是 | 读取加计费调用：Invocation 重放与续跑、Provider 健康检查、生图、辞典合并预览、虚拟群聊 Release 与重试 |
| `all` | 是 | 是 | 是 | 以上全部，包括既改状态又花钱的路由 |

访问要求为 `write+paid` 的路由需要同时具备 `write_all` 与 `execute_paid_operations`，只有 `read_write` 或只有 `read_paid` 都会被 `403` 拒绝。生成的接口目录逐条列出访问要求，被拒绝时不必猜自己缺哪一档。

这四种模式是面板允许的全部合法组合。有人直接改库改成非法组合（例如有 `write_all` 却没有 `read_all`），该密钥根本无法通过鉴权，面板会把它显示为权限非法，保存一次合法模式即可修复。

两种凭据走同一个闸门，所以同一模式的配对客户端和 API 密钥能做的事完全一样，包括下面的排除项。

## 仅面板 Session 的边界

以下路由对任何 API 密钥或配对客户端都不可达，无论什么模式：

- `/api/auth/*`：登录、Passkey 注册与登录、账号凭据、登出。
- `/api/api-keys*`：列出、创建、改模式、轮换、撤销。
- `/api/keychain*`：列出、新建、轮换、删除与清理命名密钥。
- `/api/live/*`：Server-Sent Events 流。

两个原因都是结构性的，不是策略偏好。能签发或列出凭据的程序化凭据等于能自我提权，而 `EventSource` 无法附加 `Authorization` 头，实时流本来就只能用 Cookie 认证。这些路线的请求体见[面板 Session 与凭据目录](endpoints-session.md)。

反向 MCP Server 与客户端 CLI 都由同一张表派生，所以它们也不提供这些路由对应的工具或命令。

## 写请求的 Origin 检查

每个带 `Origin` 头的 `POST`、`PUT`、`DELETE` 在鉴权之前先过这一关：

- `Origin` 解析不了，返回 `400 bad_origin`。
- 没有配置 `admin.public_url` 时，Origin 的 host 必须等于请求的 `Host`，跨来源的管理请求返回 `403 bad_origin`。
- 配置了 `admin.public_url` 时，`Origin` 必须与那个来源完全一致，消息会要求操作者打开配置里的地址。

没有 `Origin` 头的请求（curl、服务端脚本）不受影响，这层检查保护浏览器，不是 API 的鉴权手段。Passkey 与密码路由额外要求精确的公开来源，因为绑定到别的来源的 WebAuthn 流程绝不能被发起。

## 标识符与编码

- **数字 ID 是十进制字符串**，不是 JSON 数字。Telegram ID 与 SQLite 的 `bigint` 都会超过安全整数范围，所以一次运行是 `"id": "8163920421"`。运行、消息、Context、提醒、循环闹钟、房间 Release 等自增行都属于这一类。
- **其余 ID 是不透明字符串**，必须原样复用接口返回的值。Memo 是 `mem_<32 位十六进制>`，群聊记忆事件是 `gmem_<32 位十六进制>`，Memo Blob 是 `blb_<32 位十六进制>`，辞典条目是 `dic_<32 位十六进制>`，生图素材与生图记录是 UUID，虚拟群聊素材是 32 位十六进制。
- 路径里的数字 ID 按有符号 64 位十进制校验，格式不对或超范围是 `400 invalid_<name>`，不是 `500`。不透明 ID 按自己的格式校验（`400 invalid_id`）。
- 路径段只做一次百分号解码。模型 ID 里可能有 `/`，所以 `PUT /api/providers/:alias/models/:id` 只在 ID 编码后才匹配（`anthropic%2Fclaude…`），解不开的路径段返回 `400 invalid_path`。
- `chat` 过滤器是 Telegram Chat ID（超级群是负数）。按模型、状态或宿主过滤的参数各有自己的语法，并拒绝控制字符。

## 快照分页

所有列表共用一种页形状：

```json
{
  "items": [],
  "total": 0,
  "limit": 25,
  "offset": 0,
  "as_of": "0",
  "new_count": 0
}
```

- `limit` 默认 **25**，取值 1–100，`offset` 必须是小于 1 000 000 000 的规范非负十进制。其他值是 `400 invalid_limit` / `400 invalid_offset`。
- 第一个请求不带 `as_of`。响应给出令牌，之后翻页时**原样**带回来，就一直在读同一批被冻结的行。
- 翻页期间新写入的行计入 `new_count`，不会插进你正在翻的页里，所以翻页不会因为插入而重复或漏行。快照内行的编辑和删除是实时的，你看到的始终是该行的当前内容。
- 令牌不合法是 `400 invalid_as_of`。不要自己造令牌，有的表用最大行 ID，有的用 ISO 时间戳。
- 过滤条件每页都会重新应用，所以翻到一半改过滤条件，等于在同一个令牌下换了一个结果集。改过滤条件时重新取快照（去掉 `as_of`）。
- 有些列表不是快照分页，比如虚拟群聊的时间线用 `before` + `limit`，循环闹钟目标与图片服务的列表只用自己的 `limit`/`offset`，各自的页面会写明。

## 并发版本

对配置和带版本的行，写操作采用乐观锁，请求声明它读到的版本，若已有更新的版本就拒绝。

- `If-Match: <revision>`。首尾双引号与弱前缀（`W/"…"`）会被去掉，所以 ETag 形状的头也能用。
- **config** 版本是 `GET /api/providers` 返回的 `revision`，由 `config.jsonc` 算出。所有编辑该文件的路由都要带，缺少头是 `400 revision_required`，过期是 `409 config_conflict`，消息会要求先重新读取再编辑。
- **prompt** 版本是 Prompt 内容哈希，从你要编辑的那个作用域的 Prompt 视图里读。哈希过期是 `409 prompt_conflict`。
- **entry** 版本属于某一行（辞典条目、循环闹钟）。服务器无法替你读取，所以必须由调用方带回自己读到的值，过期分别是 `409 dictionary_conflict` / `409 revision_conflict`。

成功的写入返回新状态，通常带新的 `revision`，下一次写可以直接接着用，不必再多读一次。

## 错误

所有失败都是同一个 JSON 信封：

```json
{ "error": "config_conflict", "message": "The configuration file changed; reload before editing" }
```

`error` 是稳定的机器码，`message` 给人看，可能变化。个别失败会补上调用方需要的字段：`model_in_use` 带 `running_invocations`，确认中止后带 `aborted_invocations`，被拒的 cron 规则带 `issues`。

| 状态 | 含义 |
| --- | --- |
| `400` | 请求不合法：正文、路径 ID、查询参数、`Origin`，或缺少/不支持的确认 |
| `401` | 没有有效凭据：`unauthenticated`、`signature_clock_skew`、`signature_replayed` |
| `403` | 已鉴权但被拒：`forbidden`（缺授权，或这是仅 Session 的路由） |
| `404` | 指定的行或路由不存在（这是 Session 请求的结果；密钥会收到 `403`） |
| `405` | 方法不允许，或用写方法打到了只读分组 |
| `409` | 冲突：版本过期、行仍在使用、幂等或状态撞车 |
| `413` | `body_too_large` |
| `422` | 请求能解析但无法应用：`config_invalid`、`secret_unresolved` |
| `429` | `health_check_busy`：已有三次模型健康检查在跑 |
| `500` | `internal_error`，或 `config_write_failed`、`keychain_write_failed` |
| `502` | 上游失败：`tool_model_unavailable`、`image_discovery_failed`、`merge_failed` |
| `503` | 宿主没接线：`replay_unavailable`、`image_unavailable`、`mcp_unavailable`、`recurring_alarms_unavailable`、`server_stopping` |

值得单独记住的错误码，因为它们各自对应一个决定：

| 错误码 | 状态 | 含义 |
| --- | --- | --- |
| `revision_required` | 400 | 需要 `If-Match` |
| `config_conflict`、`prompt_conflict`、`dictionary_conflict`、`revision_conflict` | 409 | 别人先写了；重新读取再重做 |
| `model_in_use` | 409 | 还有运行在用被替换的模型；带 `abort_running: true` 重发以中止它们 |
| `mcp_server_in_use` | 409 | 仍有 Chat 绑定这个出站服务器；先解绑 |
| `chat_delete_pending`、`chat_still_authorized` | 409 | Chat 已从配置移除，但运行或迁移别名还挂着；稍后重试删除 |
| `pairing_code_invalid`、`pairing_code_expired`、`pairing_code_used` | 400/400/409 | 一次性码失效；重新创建 |
| `pairing_proof_invalid`、`pairing_public_key_mismatch` | 401 | 领取是用另一把密钥签的；配对码**不会**被作废 |
| `keychain_exists`、`keychain_in_use`、`keychain_missing` | 409/409/404 | 命名密钥已存在、仍被引用，或已不存在 |
| `config_invalid`、`secret_unresolved` | 422 | 文件能解析但密钥没解析出来；写入被拒 |
| `restart_unsupported` | 409 | 没有 supervisor 声明 `PLASTICWAN_SUPERVISED=1`；只能手工重启 |

## 保存了但没应用

配置写入有两半：文件先改，运行中的进程再采纳它能采纳的部分。响应把两者分开：

```json
{
  "revision": "…",
  "apply": { "applied": ["telegram.bucket_window_seconds"], "restart_required": [], "outside_serve": [] }
}
```

- `applied` 是这次写入热更新的字段路径。
- `restart_required` 是要重启才生效的字段，常因为早先的编辑而本来就不为空。
- `outside_serve` 只在独立面板里非空，那里没有进程可应用。
- 文件写了但应用失败时，状态是 `409`、`422`（或 `publish_incomplete` 的 `500`），消息以 `config.jsonc was updated but not applied:` 开头。改动已经在磁盘上，请重新加载并重新应用，而不是把旧请求体重发一次。

`POST /api/config/apply` 重新读文件并应用可热更新的部分。`GET /api/config/status` 给出活动代次、两个哈希、`restart_required` 与上一次应用错误。`POST /api/restart` 只在部署声明了 supervisor 时存在。

## 计费调用与重试

计费路由（Invocation 重放与续跑、模型健康检查、辞典合并预览、MCP 描述起草、生图/重试/素材提取、虚拟群聊 Release 与 Retry）在接口目录里标为 `paid` 或 `write+paid`。HTTP 路由没有确认字段，操作者的同意是调用方自己的事，CLI 的 `--yes` 与 MCP 工具的 `confirm` 都只是在客户端表达这份同意。

重试语义按路由而定，因为「重试」在不同接口里不是一件事：

- **Invocation 重放 / 续跑**会新建一次运行，重新计费。请求被接受后客户端超时，结果就是未知，请先列 Invocation 看有没有新行，再决定要不要再发。上一次运行不是最新、会话正忙、宿主不可用或 Bot 正在睡眠时，续跑会以 `409 resume_*` 被拒。
- **虚拟群聊**的输入与 Release 带 `request_key`，同键重发返回原结果（`replayed: true`，`200` 而不是 `201`）。重试要带 `attempt_key`，如果已结算的那次尝试产生了副作用，重试会被拒。
- **生图**的创建与重试接受 `idempotency_key`。不传时服务器按用户名加当前秒生成一个键，所以同一秒内两次相同请求会撞车，需要安全重试请自己带键。
- **辞典合并**是两步：`merge/preview` 计费并返回草稿，`merge` 才写入。只有第二步改数据，所以预览可以放心重复。
- **模型健康检查**每次调用都计一次费。已有检查在跑时返回 `429 health_check_busy`，Provider 连接或模型定义还没应用时返回 `409`。

## 两个 curl 例子

用 API 密钥读一次：

```bash
curl -sS http://127.0.0.1:8787/api/invocations?limit=2 \
  -H "Authorization: Bearer $SUROWAN_API_KEY"
```

```json
{
  "items": [
    {
      "id": "912",
      "state": "completed",
      "created_at": "2026-11-20T08:41:02.113Z",
      "completion_reason": "idle",
      "sends_used": 1,
      "tool_call_count": 2,
      "total_tokens": 8421,
      "chat": { "host_kind": "telegram", "telegram_chat_id": "-1001234567890", "chat_type": "supergroup" }
    }
  ],
  "total": 1,
  "limit": 2,
  "offset": 0,
  "as_of": "912",
  "new_count": 0
}
```

一次被拒绝的写入，带着调用方读到的版本：

```bash
curl -sS -X PUT http://127.0.0.1:8787/api/telegram/bucket-timing \
  -H "Authorization: Bearer $SUROWAN_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: 0d6f2d…' \
  -d '{"bucket_window_seconds": 20}'
```

```json
{ "error": "config_conflict", "message": "The configuration file changed; reload before editing" }
```

重新读 `GET /api/providers`、取它的 `revision`，再发一次，不要拿着过期的值重试。
