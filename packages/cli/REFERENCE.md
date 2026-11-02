# API 契约与输出

返回 [README](./README.md)。

## API 契约

| 命令 | 请求 | 成功响应形状 |
| --- | --- | --- |
| `login`（API key） | 不访问服务器，只写凭据文件 | `{ status: "saved", endpoint, credential: "api_key", credentials_file }`（不含 key） |
| `login --username <name>`（面板 Session） | `POST /api/auth/login`，换取 Session Token | `{ status: "saved", endpoint, credential: "session", username, credentials_file }`（不含 token 与密码） |
| `doctor` | `GET /api/invocations?limit=1`（只验证连通与鉴权） | `{ status: "ok", endpoint, credential: "session" \| "api_key", credential_sources: { endpoint, credential } }`，来源取值为 `argument` / `environment` / `file` |
| `commands` | 不访问服务器，列出面板命令表 | `[{ command, method, path, revision, confirm, summary }]` |
| `config show` | `GET /api/config/view?source` | `{ source, generation, active_hash, file_hash, restart_required, config }`；`config` 是服务端脱敏投影（不含 key、SecretRef 内容与 prompt 正文） |
| `models list` | `GET /api/models`（无查询参数） | `{ source: "active", generation, models: [{ provider, model, name, context_window, max_tokens, input, reasoning, thinking_levels }] }`；只含 active 配置中接受 `text` 输入的已配置模型，不发起 Provider 请求，不代表上游完整目录或连通保证 |
| `prompt get global` | `GET /api/prompts/global?source` | `{ source, scope: "global", chat_id: null, prompt, core_read_only: true, generation, active_hash, file_hash, restart_required }` |
| `prompt get group --chat <id>` | `GET /api/prompts/group?source&chat` | 同上，`scope: "group"`，另有 `configured_chat_id`（Chat 迁移后可分辨配置 ID） |
| `invocation list` | `GET /api/invocations?limit&cursor&state&chat&model&search&at&from&to` | `{ items: [...], next_cursor: string \| null }`；带搜索或时间过滤时每个 item 追加 `matched_messages`（最新 5 条命中，按时间从新到旧；`{ source: "incoming"\|"bot", telegram_message_id, telegram_send_id, at, text }`，`text` 是截断预览，bot 条目的 `telegram_send_id` 是 `--before-send` 候选，仍须用同一 ID 预检；跨 Conversation 的发送不能作为切片目标） |
| `invocation get <id>` | `GET /api/invocations/<id>` | invocation 详情对象（含 `id: string`），原样输出 |
| `invocation prompts <id>` | `GET /api/invocations/<id>/prompts` | `{ source: "active", source_invocation_id, global_prompt, group_prompt, template_values, core_read_only: true }`；当前场景所用模板与变量，不是历史 prompt |
| `invocation preflight <id>` | `GET /api/invocations/<id>/replay-preflight[?before_send_id][&provider&model&thinking_level]` | `{ available, reason, message, prompt_overrides_available, omitted_images, scene?, model?, fidelity }`；基于保留的公开场景，不依赖报文录制；切片选择时 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`；带临时模型/thinking 选择时 `model` 为将使用的 `{ provider, id, thinking_level }`，`fidelity.model_selection` 为 `current_chat_config` 或 `temporary_override`；不调用模型、不写生产业务状态 |
| `invocation media <id>` | `GET /api/invocations/<id>/media`，再对每项逐个 `GET /api/invocations/<id>/media/<media_id>/content?variant=` | 二进制逐项落盘；stdout 为 manifest 文档（见「输出与退出码」） |
| `invocation replay <id>` | 先 `GET /api/invocations/<id>/replay-preflight[?before_send_id][&provider&model&thinking_level]`；随后 `POST /api/invocations/<id>/replay`，body `{}`、`{ "global_prompt": "...", "group_prompt": "..." }`、`{ "before_send_id": "<十进制字符串>" }` 或带 `provider`/`model`/`thinking_level` 的任意组合（模型对与 thinking 同预检） | 对象；`error` 非 null 表示 replay 未完成，`model` 为实际使用的 `{ provider, id, thinking_level }`，`overrides` 报告哪两层被替换以及临时覆盖的 `provider`/`model`/`thinking_level` 布尔，`fidelity.model_selection` 区分 `current_chat_config`/`temporary_override`；切片重放另在 `scene.slice` 报告边界 |

响应边界只做最小校验：必须是 JSON 对象，且 list 的 `items` 为数组、`next_cursor` 为字符串或 null，get 必须含字符串 `id`，`config show` / `prompt get` / `invocation prompts` / `invocation preflight` 各自校验顶层字段，`models list` 校验 `source`/`generation` 与每个模型的字段形状（provider/model/name、`input` 含 text、thinking 级别在枚举内等），媒体列表校验每项的 ID、变体与大小形状；校验失败以 `invalid_response`（退出码 1）结束且不重试。JSON 响应体不设客户端大小上限，完整读取后解析，仍受请求超时约束；媒体内容单独按每文件 20 MiB、单次运行 100 MiB 设限。`doctor` 不输出 Invocation 正文，不调用模型、不发送 Telegram 消息、不重试；鉴权仍会更新密钥的 `last_used_at`。

## 面板命令契约

每个面板命令对应一条 Admin Panel `/api` 路由，`commands` 输出就是这张表。通用规则：

| 规则 | 行为 |
| --- | --- |
| 请求形状 | `method` + `/api/<path>`（位置参数按段 `encodeURIComponent`）+ 声明的 query 参数；未声明的 flag 报 `unexpected_option` |
| Body | `--set key=value`（字符串，`a.b` 嵌套）、`--set-json key=<json>`（任意 JSON）、`--body <json>`、`--file <path>`；后两者与前者互斥（`conflicting_body`），无 body 的命令带这些 flag 报 `unexpected_option`，有 body 的命令不给 body 报 `missing_body` |
| `If-Match` | `--if-match` 显式指定；否则配置写入读 `GET /api/providers` 的 `revision`，Prompt 写入读该 scope 的 `content_hash`（`prompt save` 用位置参数 scope，`prompt restore` 先读版本的 scope）；字典词条写入必须显式给出（`if_match_required`）；不接受 revision 的命令带 `--if-match` 报 `unexpected_option` |
| 确认 | `confirm: destructive` 与 `confirm: paid` 的命令缺少 `--yes` 时以 `confirmation_required`（退出码 2）在发请求前拒绝；`--dry-run` 不需要 `--yes`，只打印请求 |
| `--dry-run` | 完全不发请求，因此也不读取 revision：输出 `{ method, path, if_match, if_match_source, body }`，其中 `if_match` 只在显式给了 `--if-match` 时非 null，`if_match_source` 为将要自动读取的来源（`config`/`prompt`/`entry`）或 `argument` |
| Session 轮换 | `account update`、`password delete`、`setup` 成功后会撤销全部 Session 并签发新 Cookie，CLI 把新 token 写回凭据文件；`logout` 成功后删除凭据文件。`save` 类命令未返回新 token 时报 `invalid_response`，避免留下已失效的凭据。Session 来自 `--session` 或 `SUROWAN_SESSION` 时不读写凭据文件：`logout` 不删除文件，轮换后的新 token 不写入，stderr 输出 `{"warning":"session_not_stored"}`（退出码仍为 0），调用方需重新 `login` |
| 非 JSON 响应 | `response: binary`（图片、媒体）与 `response: text`（字典导出）按 32 MiB 上限读取；`--output` 写文件，缺省时二进制报 `output_required`，文本原样写 stdout |
| 服务端错误 | HTTP 非 2xx 的 `{error,message}` 直接成为 CLI 的 `error`/`message`（`config_conflict`、`prompt_conflict`、`dictionary_conflict`、`revision_required`、`forbidden` 等保持原码），退出码 1 |

## 输出与退出码

- 成功：stdout 一个 JSON 文档（`--json`）或简洁的人类可读输出；`login` 与 `doctor` 的成功文档不含 key。
- 失败：stderr 一个 JSON 文档 `{"error": "<code>", "message": "<message>"}`；错误信息经 key 脱敏，key 不会出现在任何输出中。
- replay 的响应即使 `error` 非 null 也会完整保留结构并写在 stdout，同时以非零退出码结束；stderr 仍是 JSON，`error` 为 `replay_failed`，`message` 以 `replay did not complete: ...` 开头。
- `invocation replay` 在 POST 前先调用一次免费的 `GET /api/invocations/<id>/replay-preflight`（切片重放带同一 `before_send_id`，临时模型/thinking 选择也带同一 `provider`/`model`/`thinking_level`）：不可重放时直接用引擎的稳定错误码失败（不发送 replay）；请求了 prompt 覆盖而预检的 `prompt_overrides_available` 为 false 时以 `replay_prompt_parts_unavailable` 失败，同样不 POST。覆盖内容在预检前读取并本地校验（global 为空或超过 65,536 字符等以退出码 2 失败）；`before_send_id` 是重放边界而不是 prompt 覆盖，不要求该权限；模型选择也不是 prompt 覆盖，但选中模型/级别在预检不可用时按预检原因码失败。切片重放还需显式 `--confirm-paid` 确认本次真实计费。
- `invocation media` 顺序下载到一个新建的私有临时目录（创建失败即失败；目录绝对路径写在 manifest 的 `directory` 字段），每个文件与 `manifest.json` 在 POSIX 上以 `0600` 创建（Windows 沿用用户目录 ACL，不做 POSIX mode 保证）。stdout 输出 manifest `{ invocation_id, variant, directory, items[] }`，每项为 `{ id, message_id, revision_id, kind, status, path, mime_type, bytes, sha256, error }`（`message_id` 为内部消息 ID）；`--json` 是单行 JSON，默认是缩进 JSON。全部成功退出码 0；部分失败保留已下载文件、写 `manifest.json` 并输出 manifest，以 `media_download_failed`（退出码 1）结束；全部失败先尝试删除整个目录，删除成功后把 manifest 输出到 stdout 并以 `media_download_failed` 失败；若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。下载前先拒绝超过 32 项或声明总量超过 100 MiB 的列表（`media_too_many_items` / `media_total_too_large`，不发生任何下载）；单项超过 20 MiB、变体不存在、超时、重定向与写入失败只记录为该条的 `error` 并继续下一项；manifest 写入失败先尝试删除目录，清理成功后以 `media_manifest_write_failed` 失败；清理受阻时同样不保证目录已删除。manifest 等文本输出与落盘元数据经 API key 脱敏；媒体二进制保留响应原字节，不做文本脱敏，`bytes` 与 `sha256` 对应实际保存的文件。
- 面板命令的 `--json` 输出是服务端响应对象原样；`--dry-run` 输出 `{ method, path, if_match, if_match_source, body }`；`--output` 输出 `{ status: "saved", path, bytes }`。
- 退出码：`0` 成功；`1` 请求/服务端/replay/媒体下载失败，保存文件无效（`invalid_credentials`：JSON 损坏、符号链接、权限不安全等）与写入失败（`credentials_write_failed`）也走 `1`；`2` 参数、输入或凭据不合法（`missing_endpoint`、`missing_credential`、`invalid_api_key`、`credentials_too_large`、模型选择的 `invalid_model_override`/`invalid_thinking_level`、prompt 覆盖的 `*_prompt_empty`/`*_prompt_too_large` 等）。`login` 写入失败不覆盖旧凭据。
- `doctor` 成功只说明当前凭据能连通并通过鉴权，不代表后续查询的数据仍在保留期内；它不输出 Invocation 正文，也不重试。
- 标准输入只用于 `login` 的 `--api-key-stdin` 与 replay 的 `--global-prompt -` / `--group-prompt -`（两者不能同时）。
- 请求不跟随重定向（`redirect: "error"`），只允许 `http(s)`，未知参数会直接报错而不是忽略。
