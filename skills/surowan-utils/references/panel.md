# 面板操作与确认

本指南的前提是入口的 `surowan-utils doctor --json` 已以退出码 `0` 返回 `status: "ok"`。先读取返回的 `mode` 与 `permissions`：`read` 只能读；`read_write` 能写但不能计费；`read_paid` 能计费但不能写；`all` 全部允许。权限不足时命令返回 `403 forbidden`，停止并请操作员到 Admin Panel → API keys 调整模式；Agent 不代为登录或改凭据。

## 先读命令表，再决定用哪个

```bash
surowan-utils commands --json     # 每个面板命令的 command/method/path/revision/confirm/summary
```

命令表就是 Admin Panel 的 `/api` 路由表：`revision` 说明写入需要哪种乐观锁（`config` 配置 revision、`prompt` Prompt 内容哈希、`entry` 词条自身 revision、`null` 不需要），`confirm` 说明是否属于 `destructive` 或 `paid`。不要凭印象拼命令；表里没有的路径不要假设存在。

## 只读命令

读取当前值永远是安全的第一步，也是写操作前必须做的核对：

```bash
surowan-utils config status --json                 # 生效代数、active/file hash、待重启字段与上次错误
surowan-utils harness show --json                  # agent 调优字段的 saved 与 active 两组值
surowan-utils chat list --json                     # 已配置 Chat 的 saved/active 与继承结果
surowan-utils provider list --json                 # 磁盘上的 Provider、模型与 revision
surowan-utils prompt versions --scope global --json
surowan-utils search show --json
surowan-utils image config show --json
surowan-utils telegram show --json                 # 只报告是否已配置 token，不回显值
surowan-utils warning list --json
surowan-utils memo list --chat <telegram chat id> --json
surowan-utils group-memory list --chat <telegram chat id> --json
surowan-utils dictionary list --scope global --json
surowan-utils room list --json
```

`saved` 是磁盘文件值，`active` 是运行中配置值；两者不同意味着有字段等待重启或尚未应用。报告时分别说明，不要把 `saved` 当成当前行为。

## 写操作：先提案，再执行

写命令的 body 由 `--set`（字符串）、`--set-json`（任意 JSON）、`--body` 或 `--file` 组成。执行前必须让用户看到并确认以下四项，缺一项就先补读：

1. **目标**：哪个 Chat / Provider / 模型 / Prompt scope / 词条 / 房间，用精确 ID 或 alias 表示。
2. **字段与值**：`harness update --set-json values.history_messages=40` 这种确切形状，而不是“调大一点”。可选字段用 `null` 表示删除该字段（回到默认），不是“设成空”。
3. **影响范围**：是否热应用（大多数配置写入立即生效）、是否进入待重启列表、是否影响运行中的 Invocation（Prompt 写入只影响下一次 Invocation，`prompt cancel-running` 才会中断当前的；`chat group-memory` 会中止该 Chat 的运行并重建 Context；`chat delete` 会删除全部存储数据；`model set` 与改模型的 `chat update` 在还有会话用旧模型时返回 409 `model_in_use`，只有用户同意终止这些会话后才加 `--set-json abort_running=true` 重试——终止后它们正在处理的消息不再回复）。
4. **可撤销性**：删除类操作不可撤销；Prompt 写入会追加版本，可用 `prompt versions` + `prompt restore` 回退。

推荐的核对顺序：

```bash
# 1. 读当前值
surowan-utils harness show --json
# 2. 预览请求（不发请求，不需要 --yes）
surowan-utils harness update --set-json values.history_messages=40 --dry-run --json
# 3. 用户明确同意后执行
surowan-utils harness update --set-json values.history_messages=40 --json
# 4. 用同一命令族复查落盘结果与 apply 结果
surowan-utils harness show --json

# Prompt 编辑：--file 读原始 Markdown，- 表示 stdin；可同时写 note
surowan-utils prompt save global --file prompt.md --set note='更简短' --json
printf '%s' "$NEW_PROMPT" | surowan-utils prompt save global --file - --json
```

`--dry-run` 输出 `{ method, path, if_match, if_match_source, body }`：把它作为提案交给用户，比自己复述字段更不容易出错。dry-run 完全不发请求，所以也不读取 revision——`if_match` 只有在你显式给了 `--if-match` 时非 null，`if_match_source` 说明真正执行时会自动读取哪一种（`config`/`prompt`/`entry`）。

## 乐观锁：不要用 --if-match 强行覆盖

写入命令默认在发请求前读取当前 revision（配置写入读 `GET /api/providers` 的 `revision`，Prompt 写入读该 scope 的 `content_hash`）。因此：

- 返回 `config_conflict` / `prompt_conflict`：文件在读取与写入之间被别人改过。重新读取、重新向用户确认新值，再执行；**不要**用 `--if-match` 把旧值钉住覆盖别人的修改。
- `revision_required`：服务端没收到 `If-Match`。配置类写入不应出现（CLI 会自动补）；字典词条写入必须由调用方给出，因为它只存在于用户上次读取的结果里——重新读取词条拿新 `revision`。
- 字典词条写入（`dictionary update`/`delete`）的 `--if-match` 是**词条自己的 revision**，不是配置 revision；`dictionary settings update` 才是配置 revision。
- `prompt save` 用位置参数指定 scope（`global` 或 `group` + `--chat`）；`prompt restore` 会先读取该版本的 scope 与 `chat_id`（群 Prompt 版本自带 Chat，不需要也不接受 `--chat`），再取对应 Prompt 的 `content_hash`。

## 破坏性操作

这些命令在缺少 `--yes` 时会以 `confirmation_required`（退出码 2）在发请求前拒绝。**补 `--yes` 不是确认**；只有用户已经同意这个具体对象与后果后才加。

| 命令 | 后果 |
| --- | --- |
| `chat delete <id>` | 从白名单移除并**删除该 Chat 的全部存储数据**：Memo Pad、Blob、Conversation Context、Message、Invocation 与发送审计。不可撤销 |
| `chat group-memory <id>` | **不是** `--yes` 项，但切换 `enabled` 会 fence 该 Chat 的全部 Conversation、中止运行中的 Invocation 并重建 Context；确认前要说明这一点 |
| `model delete` / `provider delete` | 被 agent/vision/任一 Chat 引用时服务端返回 409，不会被删除；确认对象确实无人引用 |
| `prompt cancel-running` | 只取消仍按旧 Prompt 运行的 Invocation；已发出的消息不撤回 |
| `session cancel` | 中止全部 running/queued Invocation 并过期其 Bucket |
| `restart` | 进程以退出码 75 退出，依赖外部 supervisor 拉起；未声明 `PLASTICWAN_SUPERVISED=1` 时返回 409 |
| `telegram token clear` | 删除 Bot Token 并回收不再被引用的 jar 条目；Telegram 随即停用。设置新 token 用 `telegram token`，不需要 `--yes` |
| `developer clear-payloads` | 分批清空历史模型报文，审计行保留但报文不可恢复 |
| `warning clear` / `group-memory delete` / `memo delete` | 删除事件告警 / 群聊记忆事件 / Memo 条目及其孤立 Blob |

删除 Chat 前必须核对：用户是否知道 Memo 与 Blob 会一并删除；该 Chat 是否仍有迁移别名（有则返回 409 `chat_still_authorized`，数据保留）；是否仍有运行中的 Invocation（可能返回 409 `chat_delete_pending`，可用当前 revision 重试）。

## 计费操作

这些操作真实调用模型或图片服务，按 Provider 计费，且不会自动重试：

| 命令 | 说明 |
| --- | --- |
| `invocation replay`（含 `--before-send` 切片） | 见 [Invocation 重放](replay.md)；切片重放另需 `--confirm-paid` |
| `provider health-check` | 每次一项、一条真实 prompt，最多 3 项并发；失败仍可能计费 |
| `dictionary merge preview` | 用 tool model 生成融合建议（不写库） |
| `image generation create` / `image generation retry` | 真实生图；同 `idempotency_key` 同内容重放不重复计费 |
| `room release` / `room release retry` | 封住房间输入并运行真实 Agent |

授权必须覆盖目标、次数与可选覆盖（模型/thinking/图片参数）。授权一次不代表可以批量或自动重试。

## 凭据与授权

- 凭据文件固定为 `~/.config/surowan-utils/credentials.json`（未加密），只保存 `{endpoint, apiKey}`。
- 权限由 API key 的模式决定；`doctor --json` 的 `mode`/`permissions` 是当前模式。权限不足时按 `forbidden` 的提示请操作员修改 key，不要寻找绕过路径。
- 配置写命令自动读取配置 revision；Prompt 写命令使用 Prompt 的 `content_hash`；条目写命令使用条目自身 `revision`。冲突时重新读取并重新确认，不要用 `--if-match` 覆盖别人的修改。
- 不要读取、打印或转贴凭据文件内容，也不要向聊天索要明文 key。

## 明确不在 CLI 里的能力

- **账号与凭据管理**：管理员用户名/密码、Passkey、API key 的创建、权限修改、轮换与撤销只允许在浏览器面板完成；API key 自身永远不能管理这些。
- **Passkey 注册与登录**需要浏览器 WebAuthn authenticator，CLI 无法完成。
- **面板前端专属的本地偏好**（主题、语言）只存在浏览器 `localStorage`，没有服务端接口。
- 除上述之外，面板的每个可授权 `/api` 路由都有对应命令；`surowan-utils commands` 的输出就是完整清单，两者不一致即为缺陷。

## 报告

写操作完成后报告：执行的命令、被改的字段与前后值、`apply` 结果（`applied`、`restart_required`、`outside_serve`）、复查命令的输出摘要，以及仍待人工处理的事项（例如需要重启才生效的字段）。失败时报告 stderr 的 `error`/`message`、退出码，并说明文件是否已写入（`config.jsonc was updated but not applied:` 前缀表示已写盘但未应用）。
