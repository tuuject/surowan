---
title: surowan-utils 参考
description: 查询、导出与重放 Invocation 的选项、请求/响应形状与失败行为。
---

# surowan-utils 参考

查询、导出与重放示例：

```bash
surowan-utils invocation list --cursor 12345 --json
surowan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
surowan-utils invocation list --search '关键词' --from '2026-09-10 07:00' --to '2026-09-10 08:00' --json
surowan-utils invocation media 12345 --json
surowan-utils invocation media 12345 --variant preview --json
surowan-utils invocation replay 12345 --json
surowan-utils invocation replay 12345 --global-prompt prompt.txt --json
printf '%s' '临时替换的 global prompt' | surowan-utils invocation replay 12345 --global-prompt - --json
surowan-utils invocation replay 12345 --group-prompt group.txt --json
# 切片重放：以某次成功 Bot 发言（telegram_sends 内部 ID）为边界重建输入窗口，需显式确认计费
surowan-utils invocation preflight 12345 --before-send 678 --json
surowan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
# 临时模型/thinking 覆盖：--provider 与 --model 必须成对，预检与重放必须使用同一选择
surowan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
surowan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
```

| 选项 | 说明 |
| --- | --- |
| `--endpoint <url>` / `SUROWAN_ENDPOINT` | Admin Panel 基地址；解析顺序为参数 > 环境变量 > `login` 保存的凭据文件，三处都没有或显式空串/纯空白时按缺失报错（`missing_endpoint`，不回退）。明文 `http` 只允许 loopback（`127.0.0.0/8`、`::1`、`localhost`），远端必须 `https`；URL 不能带凭据、query 或 fragment；保存与比较都用 `parseEndpoint` 规范化后的 URL（trim、补尾斜杠、去默认端口） |
| `--api-key <key>` / `SUROWAN_API_KEY` | API key：1–4096 字符，不得含空白或控制字符（参数/环境变量报 `invalid_api_key`，保存文件内的非法值报 `invalid_credentials`）；与 endpoint 同一解析顺序，命令行参数优先于环境变量，显式空串不回退。仅当解析出的 endpoint 与文件 endpoint 规范化后相同才使用文件中的 key，否则缺少显式 key 报 `missing_api_key` |
| `--api-key-stdin` | 仅 `login`：把标准输入读到 EOF（不是读完一行就停），累计不超过 4098 字节，读取结束后只去掉一个尾部 LF/CRLF，剩余换行、空白或控制字符整体非法（`invalid_api_key`，退出码 2）；TTY 上拒绝；整次读取受 `--timeout-ms` 约束，超时 `timeout`（退出码 1）且不保存；不能与 `--api-key` 或 `SUROWAN_API_KEY` 同时给出；不是 `--api-key -`，其它命令不从标准输入读取 key |
| `--source <active\|file>` | 仅 `config show` 与 `prompt get`：`active`（默认）读运行中快照，`file` 读磁盘配置；两者不会互相替代 |
| `--variant <original\|preview>` | 仅 `invocation media`：下载原始文件（默认）或服务端规范化预览；preview 只对 photo/sticker 可用 |
| `--timeout-ms <ms>` | 请求/输入超时；默认除 replay（300 秒）外都是 30 秒。stdin 读取单独使用同一上限，超时返回 `timeout`（退出码 1）且不发请求；HTTP 超时中止请求，均不自动重试 |
| `--json` | stdout 恰好一个 JSON 文档；人类模式输出列表摘要或缩进 JSON |
| `--limit`（1–100）/ `--cursor` / `--state` | `invocation list` 的过滤参数，发出前先做形状校验（cursor 为非负十进制） |
| `--chat <id>` | `invocation list` 的 Chat 过滤，或 `prompt get group` 必填的群 ID；必须是可带负号的有符号 64 位十进制 |
| `--search <keyword>` | 仅 `invocation list`：按字面关键词（1–100 字符，`%`、`_` 按字面处理）匹配公开消息——冻结新消息批次（含追加批次）的群友消息，或同一 Invocation 成功发出的 Bot 消息。与时间过滤同用时，关键词与时间必须命中同一条消息；带搜索或时间过滤时列表项追加 `matched_messages`（最新 5 条，按时间从新到旧，预览最多 2000 字符），不带时维持原形状 |
| `--at <time>` / `--from <time>` / `--to <time>` | 仅 `invocation list`：按公开消息时间过滤。`--at` 命中写出的整个精度窗口（`HH:mm` 为整分钟、`HH:mm:ss` 为整秒、小数 1/2/3 位分别对应 100/10/1 毫秒窗口），`--from`/`--to` 组成半开区间 `[from, to)`；`--at` 不能与 `--from`/`--to` 同用。格式为 `YYYY-MM-DD[空格或T]HH:mm[:ss[.1-3位]][Z\|±HH:mm]`；不带 offset 的时间由服务端按 `--chat` 对应 Chat 的时区解析、没有 `--chat` 时用全局时区；非法日历与夏令时跳变造成的不存在/重复时间会被拒绝 |
| `--before-send <send-id>` | 仅 `invocation preflight` 与 `invocation replay`：以该 `telegram_sends` 内部 ID（必须是本 Invocation 的成功发送）作为切片边界；预检与重放必须使用同一选择 |
| `--confirm-paid` | 仅 `invocation replay`：切片重放（`--before-send`）需显式确认真实模型计费；缺失时以 `confirm_paid_required`、退出码 2 拒绝，不读 prompt 或 stdin，也不发预检或 POST。未切片重放不要求该 flag |
| `--global-prompt <file\|->` | 仅 `invocation replay`：完整替换 global 层；`-` 从非终端标准输入读取，去空白后不能为空、最多 65,536 字符，否则在发请求前以退出码 2 失败 |
| `--group-prompt <file\|->` | 仅 `invocation replay`：完整替换 group 层；允许空内容以显式清空，最多 65,536 字符；与 `--global-prompt -` 不能同时从 stdin 读取 |
| `--provider <alias>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的 Provider alias；必须与 `--model` 成对（`invalid_model_override`，退出码 2），1–256 字符、不含控制字符 |
| `--model <id>` | 仅 `invocation preflight` 与 `invocation replay`：临时模型覆盖的模型 ID；必须与 `--provider` 成对，规则同上 |
| `--thinking-level <level>` | 仅 `invocation preflight` 与 `invocation replay`：临时 thinking 覆盖，取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（`invalid_thinking_level`，退出码 2）。可单独使用（只临时改 thinking，模型沿用当前 Chat 配置）；与模型对同给时按该模型校验级别，给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），模型不支持的级别由服务端拒绝。预检与重放必须使用同一选择 |

失败时 stderr 输出 `{"error":"<code>","message":"<message>"}`，错误信息经 key 脱敏，密钥不会出现在任何输出中；退出码 `0` 表示成功，`1` 表示请求/服务端/replay/媒体下载失败或保存文件无效（`invalid_credentials`），`2` 表示参数、输入或凭据不合法（含 `missing_endpoint`、`missing_api_key`、`invalid_api_key`、`credentials_too_large`、搜索/时间过滤与 `--before-send` 的本地校验错误、模型选择的 `invalid_model_override`/`invalid_thinking_level`，以及 prompt 覆盖相关错误）。标准输入只用于 `login` 的 `--api-key-stdin` 与 replay 的 `--global-prompt -` / `--group-prompt -`（不能同时）。请求不跟随重定向；JSON 响应体不设客户端大小上限，完整读取后解析，仍受请求超时约束。

`invocation media` 把每个媒体顺序下载到新建的私有临时目录（每文件不超过 20 MiB、单次合计不超过 100 MiB、最多 32 项），stdout 输出带 `sha256` 的 manifest；全部成功退出码 `0`，部分失败保留成功文件并写入 `manifest.json` 后以 `media_download_failed` 退出（退出码 `1`），全部失败先尝试清理目录，删除成功后输出 manifest；若文件系统拒绝清理，命令失败、目录可能残留，stdout 不保证含 manifest。服务端持续清理失败会作为条目错误 `media_cleanup_failed` 返回；这不等于客户端目录也已删除。manifest 等文本输出与落盘元数据经 API key 脱敏；媒体二进制保留响应原字节，不做文本脱敏，`bytes` 与 `sha256` 对应实际保存的文件。`invocation replay` 在 POST 前先调用一次免费的 `replay-preflight`（切片重放带同一 `before_send_id`，临时模型/thinking 选择也带同一 `provider`/`model`/`thinking_level`）：不可重放时直接以原因码结束（不发送 replay），请求了 prompt 覆盖而预检不允许时返回 `replay_prompt_parts_unavailable`；`--before-send` 是重放边界而不是 prompt 覆盖，不要求该权限，但切片重放需 `--confirm-paid` 显式确认计费。只读检查（`config show`、`prompt get`、`models list`、`invocation prompts`、`invocation preflight`、媒体列表）不调用模型、不计费；重放不会发送 Telegram 消息，也不修改生产会话与业务数据（鉴权仍会更新密钥使用时间），但它会真实调用模型并计费，限制与注意事项见[使用管理面板](../configure/admin-invocation-replay.md#invocation-重放)。

`models list` 只读列出当前 active 配置中可接受文本输入的已配置模型（`{ source: "active", generation, models: [...] }`，每项含 `provider`/`model`/`name`/`context_window`/`max_tokens`/`input`/`reasoning`/`thinking_levels`）：不发起 Provider 请求、不是上游完整目录、不保证连通，也不支持 `--source file`；列表不构成对任何模型的使用授权。`invocation preflight`/`replay` 可临时覆盖模型与 thinking：`--provider` 与 `--model` 必须成对，`--thinking-level` 可单独使用；CLI 把相同的 `provider`/`model`/`thinking_level` 放进预检查询与重放 body，覆盖只影响这一次运行，不写回配置、不改生产 Context/审计/预算，但选中模型决定 prompt 变量、图片能力、context budget、Schema、Provider 连接与真实费用。给模型对而不给 thinking 时使用该模型支持的最弱级别（非推理模型为 `off`），不支持请求级别会被拒绝；未给任何选择时按当前 Chat 配置。响应的 `model`（`{ provider, id, thinking_level }`）、`fidelity.model_selection`（`current_chat_config`/`temporary_override`）与 `overrides` 的 `provider`/`model`/`thinking_level` 布尔可核对实际使用的选择。

切片重放（`--before-send <send-id>`）只重建该次 Bot 发言之前的一小段公开输入：窗口严格位于上一条 Bot 发言之后、目标发言之前（两端不含），目标必须是本 Invocation 的成功发送，上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation；没有更早历史，也不读取历史的 reasoning、工具结果或 system prompt。输入只包含冻结且已注入的公开消息（目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待；模型并发与网络延迟仍可能造成等待），原 Bot 回答不进入模型，只作为审计对照。返回的 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送请求的开始时间（不是交付完成时间）；回复引用不能跨出该窗口。窗口内没有新的公开消息返回 `replay_slice_empty`，目标不是本 Invocation 的成功发送返回 `replay_slice_target_invalid`。
