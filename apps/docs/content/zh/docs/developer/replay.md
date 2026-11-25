---
title: Invocation 预检与重放
description: 用当前 Prompt、模型与工具重演一次历史运行的公开输入，先免费预检，再看切片、覆盖、保真限制与费用，并与真实续跑区分。
---

# Invocation 预检与重放

重放（replay）取一次已结束的 Invocation 的**历史公开输入**，用**当前**的 Prompt、模型与工具定义再跑一遍，看看它这一次会怎样回复。它不发送 Telegram 消息、不改生产 Context、也不写业务数据，但会**真实调用模型并计费**，也不计入生产用量预算（响应里 `fidelity.production_budgets` 为 `not_charged`）。

入口只有携带 API 凭据的 CLI、HTTP 与 MCP，面板登录 Session 不能直接重放，也没有重放页面：

```bash
surowan-utils invocation preflight 12345 --json     # 免费
surowan-utils invocation replay 12345 --json        # 计费
```

对应接口是 `GET /api/invocations/:id/replay-preflight` 与 `POST /api/invocations/:id/replay`（见 [审计、续跑与导出接口](http/audit.md)），MCP 侧是 `surowan_invocation_replay_preflight` 与 `surowan_invocation_replay`。

## 与「续跑」不是一回事

| | 重放 | 续跑（Resume） |
| --- | --- | --- |
| 做什么 | 重建历史场景，在**新的**合成运行里跑当前配置 | 为失败的运行**真的**再来一次 |
| 会发 Telegram 吗 | 不会，`send` 只把内容收集进 `outputs` | 会，它就是生产运行 |
| 改生产 Context 吗 | 不会 | 会，写进 canonical history |
| 计费 | 是，按当前模型 | 是，按当时模型 |
| 入口 | CLI / HTTP / MCP | 面板、`POST /api/invocations/:id/resume`、MCP 的 `surowan_invocation_resume` |

续跑只能用于同一个 Conversation 里最新的 `failed` / `aborted` / `outcome_unknown` 运行，而且可能重复已经发出的内容，因为它是真发。重放永远不会发消息，所以你可以随便跑，代价只有钱。

## 预检

预检是免费只读的，应该先做。它检查「能不能重放」「能不能覆盖 Prompt」「场景长什么样」，返回：

| 字段 | 含义 |
| --- | --- |
| `available` | 能不能重放；不能时 `reason` 是稳定错误码，`message` 是给人看的原因 |
| `prompt_overrides_available` | 这次场景能不能替换 global/group Prompt 层 |
| `scene` | `cutoff_at`、`source_bucket_id`、`message_count`、`history_count`、`omitted_messages`，切片时还有 `slice` |
| `model` | 给了模型选择时，本次会实际使用的 `{ provider, id, thinking_level }` |
| `fidelity` | 见下文的保真表；预检只报运行前就能确定的部分 |

会拒绝的情况（错误码即 `reason`）：

- `replay_source_unfinished`：源运行还没结束。
- `replay_host_unsupported`：重放只支持配置驱动的宿主，目前即 Telegram，Playground 房间的运行不能重放。
- `replay_chat_unconfigured` / `replay_topic_unconfigured`：源 Chat 或 Topic 已不在当前配置里。
- `replay_model_unavailable`：当前 Chat 的 Agent 模型没配置或未注册。
- `replay_model_pair_required`、`replay_thinking_level_invalid`、`replay_thinking_level_unsupported`、`unknown_provider`、`unknown_model`、`not_text_capable`：模型覆盖不合法。
- `invalid_before_send_id`：切片边界不是正的 64 位十进制 ID。

不需要打开 Developer 报文录制。场景从消息表、修订表与 Invocation 快照重建，关闭录制或清空报文都不影响重放，也不要求源运行当时调用过模型。

## 场景由什么组成

默认场景等于「该 Invocation 的开场批次被冻结时，模型应该看到的输入」：

- 开场批次（冻结的 `new` 快照）。后续 attach 进来的批次、后来的编辑、Bot 后来的回复都不进入。
- 当时可证明已经存在的历史：冻结的历史优先，其余按源运行创建时间之前的修订与到达时间取，当前历史条数上限、`/cut_topic` 与 Chat/Topic 允许范围**仍然生效**。
- 缺失的修订只计数（`omitted_messages`），不会用后来的编辑顶替。

运行时状态块只带 `current_time`（默认是开场冻结时间），不读 Memo Pad、贴纸目录或任务回执。当前模型支持图片输入时，本次场景授权的、仍然保留的 Photo、Sticker 与图片 Document 会拿到**场景内**的引用，读图只把图片规范化后交给模型，不走生产 Vision，也不写分析缓存。

## Prompt 覆盖

只允许替换 global 与 group 两层，固定协议与整体 system prompt 不能覆盖：

```bash
surowan-utils invocation replay 12345 --global-prompt prompt.txt --json
surowan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' '临时替换的 global prompt' | surowan-utils invocation replay 12345 --global-prompt - --json
```

- 每层最多 65,536 字符，global 去空白后不能为空，group 允许空内容以显式清空。
- 两个 `-` 不能同时从标准输入读。
- 内容按当前模板白名单校验，预检报告 `prompt_overrides_available: false` 时，CLI 直接以 `replay_prompt_parts_unavailable` 结束，不发 POST。
- 覆盖只影响这一次运行，不写回配置。`invocation prompts <id>` 返回的是**当前**生效的两层 Prompt（`source: active`），不是历史记录。

## 模型与思考强度覆盖

```bash
surowan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
surowan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
```

- `--provider` 与 `--model` 必须成对，`--thinking-level` 取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，可以单独使用（只临时改强度，模型沿用当前 Chat 配置）。
- 给了模型对却没给强度时，用该模型支持的最弱一档（非推理模型为 `off`），请求它不支持的档位会被服务端拒绝。
- 预检与重放必须使用同一个选择，否则你看到的场景和实际跑的模型不一致。
- 覆盖不修改配置、Context、审计或预算，但会改变 Prompt 变量、图片能力、上下文预算、工具 Schema、Provider 连接与真实费用。返回的 `model` 与 `fidelity.model_selection`（`current_chat_config` / `temporary_override`）可以核对实际用的是哪一个。

`surowan-utils models list` 只列当前配置中接受文本输入的模型，不探测连通性，列表本身也不代表授权。

## 切片重放

给出 `--before-send <telegram_sends 内部 ID>` 后，重放不再重建整个开场批次，而是只取某次成功 Bot 发言之前的一小段公开输入：

- 窗口严格位于**上一条 Bot 发言之后、目标发言之前**（两端不含）。目标必须是本 Invocation 的成功发送。上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation，没有上一条时从保留输入的开头开始。
- 只包含冻结且已注入的公开消息。目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待（模型并发与网络延迟仍可能造成等待）。注入时间必须严格早于发送请求开始时间，同毫秒无法证明先后时保守省略。
- 不读更早历史，也不读历史的 reasoning、工具结果或 system prompt。原 Bot 回答不进入模型，只留在审计里作对照，回复引用不能跨出窗口。
- 返回 `scene.slice = { before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 是那次发送**请求的开始时间**，不是交付完成时间。
- 窗口内没有新的公开消息 → `replay_slice_empty`，目标不是本 Invocation 的成功发送 → `replay_slice_target_invalid`。
- 切片重放同样真实计费，命令行必须显式加 `--confirm-paid`，缺失时在读取 stdin、发预检或发 POST 之前就以 `confirm_paid_required`（退出码 2）拒绝。免费的预检不接受这个确认参数，但预检与重放必须用同一个 `--before-send`。

不知道用哪个 ID 时先搜索：

```bash
surowan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json
```

命中项里的 Bot 条目带 `telegram_send_id`，可以拿来当候选。同一条 Invocation 向其他 Conversation 的发送也在搜索结果里，但那种发送不能作为它的切片目标。

## 保真限制

响应里的 `fidelity` 与 `overrides` 就是这份清单：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `input` | `historical_public_chat` | 输入只有历史公开消息 |
| `model_selection` | `current_chat_config` / `temporary_override` | 用当前 Chat 配置还是本次覆盖 |
| `prompt_selection` | `current_chat_config` | Prompt 与模板来自当前配置（可整层覆盖） |
| `tool_selection` | `current_registry` | 工具定义取当前注册表 |
| `hot_injections` | `not_replayed` / `flattened_before_send` | 默认不加入后来的热注入；切片模式只拍平可证明在发送前已注入的批次 |
| `external_tools` | `blocked` | 网页抓取、贴纸搜索、MCP 等外部能力被拒绝 |
| `system_resources` | `current_read_only` | `read` 读的是**当前**系统文档 |
| `side_effects` | `synthetic` | `send`、typing、生图与 `zzz` 只合成 |
| `memory_and_alarms` | `empty_in_memory_overlay` | Memo Pad 与 Alarm 从空内存开始 |
| `production_budgets` | `not_charged` | 不计入生产日预算 |
| `dispatch_mode` | `execution_path_not_success` | `dispatches[].mode` 只说明走哪条路线，成功与否看 `tool_calls` |

再补充几点：

- `send` 会校验当前参数、文字长度限制与场景内的回复目标，但**没有**真实发送限流、Sticker 世界状态与生图资产检查，合成发送成功不等于生产发送成功。
- 场景时间默认是开场冻结时间，切片模式取目标发送请求的开始时间。不恢复当时的 Memo Pad、任务回执、全局睡眠状态或发送提醒。
- 同一次只能跑一个重放，并发请求得到 `replay_busy`（HTTP 429）。单次运行上限是 128 次工具调用、240 秒墙钟时间、20 轮（且不超过当前 `turns_per_injection`），`trace` 最多 1 MiB，超限会以明确的 `error` 结束。
- 重放里的模型请求不自动重试。模型选择不发言（输出里没有 `send`）也是正常结果：`responded: false`、`send_count: 0`。
- `error` 非空表示重放没有正常完成，但完整结构仍会返回，CLI 会先打印结果再以 `replay_failed`（退出码 1）结束。CLI 侧的请求超时默认 300 秒。

## 结果里有什么

`version`、`replay_id`、`source_invocation_id`、`scene`、`conversation_id`、`chat_id`、`thread_id`、`model`、`overrides`、`started_at`、`finished_at`、`latency_ms`、`completion_reason`、`responded`、`send_count`、`outputs`、`tool_calls`、`usage`（含 `model_calls` 轮数）、`trace`、`error`、`fidelity`。

结果里的文本会按 API key 脱敏，形状仍是结构化 JSON，便于交给 Coding Agent 对比「同一场景、不同 Prompt/模型」的差异。

## 使用建议

- 先 `preflight`，再 `replay`，不可重放时不要重试，原因码是稳定的。
- 一次只改一个变量：要么换 Prompt 层，要么换模型，否则说不清差异来自哪里。
- 重放是评估工具，不是修数据工具，想改生产状态，用面板、[配置与闸门接口](http/configuration.md) 或续跑。
- 把重放授权当单独授权，允许查询不等于允许重放，尤其当 Agent 自己决定跑几次时。
