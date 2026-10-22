---
title: Invocation 重放
description: 通过 CLI/API 重放 Invocation，并了解临时覆盖与切片重放。
---

# Invocation 重放


重放从已经结束的 Invocation 重建一段历史公开聊天场景，用当前 Prompt、模型与工具定义观察它会怎样回复。入口是携带 API 密钥的 CLI/API，面板登录会话不能直接重放；免费的预检、场景 prompt 查看与媒体导出也没有页面入口。它不会发送 Telegram 消息、不修改生产会话与业务数据（鉴权仍更新密钥使用时间），但会**真实调用模型并计费**，不计入生产用量预算。交给 Agent 时，明确授权目标 ID、次数与可选覆盖（prompt 与临时模型/thinking），不把查询授权当重放授权。

不需要开启 Developer 报文录制；关闭录制或清除调试报文不影响场景重建，也不要求源 Invocation 曾调用模型。需要仍在保留期内的开场公开消息；尚未结束、开场缺失或损坏、Chat/Topic 已不允许或当前模型不可用时会明确拒绝，先用免费预检确认。

```bash
# 免费预检：能否重放、能否覆盖 prompt；不调用模型
surowan-utils invocation preflight 12345 --json
# 查看该场景使用的当前两层 prompt（source: active，不是历史记录）
surowan-utils invocation prompts 12345 --json
# 列出当前 active 配置中可接受文本输入的已配置模型（免费、不探测 Provider；列表不是授权）
surowan-utils models list --json

surowan-utils invocation replay 12345 --json
# 临时替换 global / group 层（每层最多 64Ki 字符；不写回配置）
surowan-utils invocation replay 12345 --global-prompt prompt.txt --json
surowan-utils invocation replay 12345 --group-prompt group.txt --json
printf '%s' '临时替换的 global prompt' | surowan-utils invocation replay 12345 --global-prompt - --json

# 临时模型/thinking 覆盖：--provider 与 --model 必须成对，预检与重放必须使用同一选择
surowan-utils invocation preflight 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json
surowan-utils invocation replay 12345 --provider openrouter --model deepseek/deepseek-v4-flash-0731 --thinking-level high --json

# 切片重放：只重放某次成功 Bot 发言之前的一小段公开输入，需确认计费
surowan-utils invocation preflight 12345 --before-send 678 --json
surowan-utils invocation replay 12345 --before-send 678 --confirm-paid --json
```

### 临时模型/thinking 覆盖

默认按当前 Chat 配置解析模型与 thinking；`invocation preflight`/`replay` 可临时覆盖：

- `--provider <alias>` 与 `--model <id>` 必须成对（1–256 字符、不含控制字符），`--thinking-level` 取 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 且可单独使用（只临时改 thinking，模型沿用当前 Chat 配置）；本地校验失败以 `invalid_model_override`/`invalid_thinking_level`、退出码 2 拒绝，不发任何请求。
- 给模型对而不给 thinking 时，使用该模型支持的最弱级别（非推理模型为 `off`）；请求模型不支持的级别会被拒绝；未给任何选择时按当前 Chat 配置。
- 预检与重放必须使用同一选择：CLI 把相同的 `provider`/`model`/`thinking_level` 放进预检查询与 POST body，可与 `--before-send` 切片和 prompt 覆盖组合。
- 覆盖不修改生产配置、Context、审计或预算；选中模型影响 prompt 变量、图片能力、context budget、Schema、Provider 连接与成本。响应的 `model`（`{ provider, id, thinking_level }`）与 `fidelity.model_selection`（`current_chat_config`/`temporary_override`）可核对实际使用的选择。`models list` 只列出 active 配置中接受文本输入的已配置模型，不保证连通，列表不构成使用授权。

### 切片重放

给出 `--before-send <telegram_sends 内部 ID>` 时，重放不再从整个开场批次重建场景，而是只取该次成功 Bot 发言之前的一小段公开输入：

- 窗口严格位于上一条 Bot 发言之后、目标发言之前（两端不含），目标必须是本 Invocation 的成功发送；上一条 Bot 发言可以来自同一 Conversation 的另一次 Invocation。没有上一条 Bot 发言时，从保留输入的开头开始。
- 只包含冻结且已注入的公开消息：目标发言之前已注入的批次会被拍平后一次性灌入，不按 Bucket 或历史节奏等待（模型并发与网络延迟仍可能造成等待）；附加批次的注入时间必须严格早于发送请求开始，同毫秒无法证明先后时保守省略。没有更早历史，也不读取历史的 reasoning、工具结果或 system prompt。
- 原 Bot 回答不进入模型，只保留在审计里作为对照；回复引用不能跨出该窗口。返回的 `scene.slice` 为 `{ before_send_id, before_message_id, after_bot_message_id }`，`history_count` 为 0，`cutoff_at` 取该次发送请求的开始时间（不是交付完成时间）。
- 窗口内没有新的公开消息返回 `replay_slice_empty`，目标不是本 Invocation 的成功发送返回 `replay_slice_target_invalid`。切片重放同样真实调用模型并计费，需要显式 `--confirm-paid`；缺失时 CLI 以 `confirm_paid_required`、退出码 2 拒绝，不读取 prompt 或 stdin，也不发预检或 POST。免费预检不接受该确认参数；预检与重放必须使用同一个 `--before-send`。
- 目标发言 ID 可以先搜索：`surowan-utils invocation list --search '关键词' --at '2026-09-10 07:59' --json`，命中项里的 bot 条目带 `telegram_send_id`，可作为 `--before-send` 候选，再用同一 ID 预检。搜索也保留该 Invocation 向其他 Conversation 的真实发送；这类发送不能作为该 Invocation 的切片目标。

限制与取舍：

- 默认输入是开场批次的冻结公开消息与当时可证明存在的历史，不加入后续批次与热注入；切片重放只取 `--before-send` 窗口内的冻结输入，并拍平可证明在发送前已注入的批次。两种模式都不加入后来编辑，当前上下文预算、Topic 范围与话题切点仍可能收窄场景；默认模式还受当前历史长度限制。不是恢复历史私有推理、工具结果或完整 Conversation Context。
- prompt、模板变量、模型、思考强度与工具定义默认取**当前**该 Chat 的配置；`invocation prompts` 返回 `source: active`，不能当历史记录。重放可临时覆盖模型/thinking（`--provider`/`--model` 成对、`--thinking-level` 可单独），只影响本次运行、不写回配置，但会改变 prompt 变量、图片能力、上下文预算、Schema、Provider 连接与真实费用；实际选择见响应的 `model` 与 `fidelity.model_selection`（`current_chat_config`/`temporary_override`）。只允许覆盖 global/group，固定协议和整体 system prompt **不能**覆盖；global 不能清空，group 可以清空，模板按当前白名单校验。
- `send` 只收集到 `outputs`，校验当前参数、文字限制与场景内的回复目标，不执行真实发送限流或 Sticker/生成资产的世界状态检查。记忆和 Alarm 从空内存开始，typing、生图、`zzz` 只合成；`read` 读取当前系统文档。
- 当前模型支持图片时，可按需读取本次场景授权且仍保留的 Photo、Sticker 与图片 Document，引用不跨场景；读图只下载/规范化图片给当前模型，不调用生产 Vision 或写分析缓存。缺失、不支持或下载失败会明确省略/报错，`omitted_images` 不代表之后下载成功的保证。网页抓取、Sticker 搜索、MCP 和未支持能力被拒绝。
- 场景时间默认为开场冻结时间，切片模式取目标发送请求的开始时间（不是交付完成时间）；不恢复当时记忆/回执，不模拟全局睡眠、发送提醒或新消息发送屏障。当前低预算可暴露 `zzz`，但执行不写睡眠状态。
- 返回的 `fidelity` 与 `overrides` 字段列出这些边界；`dispatches` 里的 `mode`（`synthetic`/`live_read`/`blocked`）只是调用走的分派路线，不代表调用成功，成功与否看 `tool_calls`。`error` 非空表示重放没有正常完成，完整结构仍会返回。
- 同时只允许一个重放；轮次、时长、工具尝试次数与 `trace` 记录有上限，超限会明确报错结束。`trace` 的 1 MiB 预算只约束记录内容；CLI 不设 JSON 响应体大小上限，完整读取后解析，仍受请求超时约束。重放中的模型请求不自动重试。模型选择不发言（输出里没有 `send`）也是正常结果。
- CLI 在重放前先跑预检，不可重放或不允许覆盖时不会发送 POST。媒体导出（`invocation media`）只读下载 Invocation 快照授权的媒体，不是视觉保真修复，也不改变重放输入。
