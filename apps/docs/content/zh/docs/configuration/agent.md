---
title: Agent 配置
description: 主模型的三个身份字段、Token 预算、发送规则、Conversation Context 保留策略、并发与限流，以及两个已废弃字段的替代写法。
---

# Agent 配置

`agent` 是可选段，整段省略、写 `null` 或写 `{}` 都合法。它决定主模型是谁、一天能烧多少 Token、能发什么、以及长对话怎么裁剪。字段逐项见 [`agent` 段字段参考](fields-agent.md)。

## 身份三元组

`provider`、`model`、`thinking_level` 三个字段一起决定「会不会发起 Invocation」：

- 三者缺一即「Agent 未配置」，进程照常启动，到期的批次直接以 `skipped_budget`/`agent_unconfigured` 关闭，不创建 Invocation，加载时有一条警告。
- 三者齐全时，模型必须存在于 `providers` 里、支持 `text` 输入，`thinking_level` 必须是该模型接受的级别。
- Chat 可以用自己的 `provider`/`model`/`thinking_level` 逐项补齐或覆盖，全局不全、某个 Chat 配齐时，只有那个 Chat 会运行。

`thinking_level` 取 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，非推理模型只接受 `off`。用面板或 `/model` 换全局模型时，运行时会把级别重置为新模型接受的最弱档位。

## 预算

`daily_budget.max_tokens`（运行时默认 `1000000000`）是**全局**每日 Token 上限，所有 Chat 共享，没有每群配额。

它计的是一次模型调用涉及的全部 Token：非缓存输入、缓存读取、缓存写入与生成，四项直接相加、互不重叠。模型是否收费、缓存是否便宜都不影响计量，免费模型同样受限。聊天触发的 `read_image` 也计入同一个预算，因为那是主 Agent 发起的调用。

这是防失控 Invocation 与 Tool loop 的熔断，不是成本预算。触顶后新运行直接结束，调低后下一次模型调用即被拦截，不需要重启。

## 发送

| 字段 | 作用 |
| --- | --- |
| `send_max_text_length` | 文本消息的最大字符数（1–4096）。超出的发送记为 `send_text_too_long`，不调用 Telegram、不占发送额度。省略即不限制。 |
| `send_disallow_blank_lines` | 开启后文本里出现空行即拒绝（`send_blank_lines`），段落只能用单个换行。缺省关闭。 |
| `send_nudge_enabled` | 模型把面向群聊的话写成普通文本、又从未调用 `send` 时，注入一条提醒。缺省关闭。 |
| `send_barrier_enabled` | 一轮里第一次真正要发送前，如果同一 Conversation 又有批次在收集，先把它接进当前运行并拒绝这次发送（`send_barrier`），让模型读完再决定说什么。缺省关闭。 |
| `allow_reply_message_multiple_times` | 缺省 `false`：同一 Conversation 内对同一条消息只能回复一次（文字、贴纸、图片共享）。设为 `true` 关闭这条按消息的去重。 |
| `send_duplicate_guard_enabled` | 缺省 `true`：同一次运行内拒绝与已成功发送完全一致的文本或贴纸，也拒绝把上一条内容换个引用目标重发；被拒超过 3 次即结束本次运行。只有显式写 `false` 才关闭。 |
| `send_empty_text_strategy` | 调用 `send` 却没给文字时怎么办：`reject`（默认，退回 `send_input_invalid`）、`silent_success`（返回成功但不发送；连续三次静默成功结束本次运行）或 `random_text`（从兜底文本里随机取一条发出）。 |
| `send_empty_text_fallback_texts` | `random_text` 用的列表，运行时默认 `["……"]`；至少一项，每项是含非空白字符的单行，最长 4096 字符。 |

这些规则最终都收敛到唯一的发送边界 `send`，普通 Assistant 文本永远不会直接发布，`send_reply` 的每一条也交给同一条管线。

## Conversation Context

`system_prompt_file` 指向人格 Prompt，路径相对配置文件目录，省略即空 Prompt（核心协议在代码里，不依赖它）。文件剔除 HTML 注释后必须仍有正文，否则拒绝加载。Prompt 里可以用 `{{ agent.nickname }}`、`{{ agent.provider }}`、`{{ agent.model }}`、`{{ vision.provider }}`、`{{ vision.model }}`、`{{ timezone }}` 六个模板变量，未知表达式会拒绝配置。

`history_messages`（默认 `20`）是每次新开 Invocation 冻结的历史条数上限，接进运行中 Invocation 的批次不带历史。

`context_stop_ratio`（默认 `0.8`）是收尾阈值，估算输入 Token 达到 `context_window × 这个比例`后，下一次模型调用只暴露 `send` 与当时可用的 `zzz`，模型用这一轮把话说完，随后运行以 `context_limit` 结束。它也是 GC 的上界，必须 ≥ `context.hard_token_ratio`。

`context` 是保留策略：

| 字段 | 运行时默认 | 作用 |
| --- | --- | --- |
| `retained_sends_target` | `20` | 裁剪后至少保留多少次 `send` 对应的历史。 |
| `retained_sends_max` | `30` | 保留区间的 `send` 数超过它即触发裁剪；必须大于 `retained_sends_target`。 |
| `hard_token_ratio` | `0.6` | 估算输入加输出上限达到 `context_window × 这个比例`时的裁剪判据。 |
| `ref_ttl_hours` | `72` | `img_`、`stk_`、`reply:` 引用在 Context 里的有效期。 |
| `idle_grace_seconds` | `0` | 一轮结束后继续等待新批次的秒数。`0` 表示一次批次一次运行；大于 0 时必须不小于 `telegram.bucket_max_seconds`。 |
| `max_wall_clock_seconds` | `1800` | 单次运行的墙钟上限，必须大于 `idle_grace_seconds`。 |
| `agent_cache_size` | `32` | 进程内缓存的 Pi Agent 实例上限；被驱逐的实例能从数据库重建等价历史。 |

裁剪只丢历史、不做摘要，一次跨过多个 checkpoint 并向前推进保留窗口的起点。被淘汰的消息不会再回到模型面前，但对话本身不会因为裁剪而中断。

`idle_grace_seconds` 是唯一受支持的长生命周期开关。大于 0 时，运行期间到期的批次会被接进同一个 Invocation，取 `0` 则退回「一次批次一次运行」，Conversation Context 依然连续。

## 并发与限流

- `max_concurrency`（默认 `4`）：全局同时运行的 Invocation 上限。
- `rate_limits.turns_per_injection`（默认 `24`）：每注入一批消息后最多再跑多少轮，超出的运行以 `turn_budget` 结束，注入即重置。
- `rate_limits.sends_per_window`（默认 `100`）与 `window_seconds`（默认 `300`）：同一 Chat 在滑动窗口内的 `send` 次数上限。

这些限制都是防失控，不是给每个群分配的额度，除全局 Token 预算外没有其它每日配额。

## 已废弃字段

- `agent.memory_ttl_warning_days`：运行时完全不读，没有替代字段，直接删除。
- `agent.send_empty_text_fallback_enabled`：旧开关，`true` 不再推导任何行为。要保留旧的空文本兜底，请改设 `agent.send_empty_text_strategy` 为 `"random_text"`。

两者仍被 Schema 接受，加载时会有一条废弃字段警告，面板「警告」页也会持续列出，增删改它们按热应用处理，不需要重启。完整清单见[配置字段参考](fields.md)。

## 生效方式

`agent` 的每个字段都是热字段，下一次 Invocation 使用新值，运行中的 Invocation 用它启动时的快照。`system_prompt_file` 的路径或内容变化会改变稳定系统提示的哈希，相关 Conversation 的 Context 在下次运行时重建。详见[配置生命周期](lifecycle.md)。
