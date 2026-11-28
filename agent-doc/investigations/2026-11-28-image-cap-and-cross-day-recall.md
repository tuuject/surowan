# 生图上限误报与跨日续作失败事故报告

- 调查时间：2026-11-28（CST）
- 方式：`surowan-utils` Admin API（`doctor`、`invocation list`、`invocation get`、`memo list`、`config show`），对照 `develop`（`c664d4ae`）源码
- 范围：生产 endpoint `[prod-admin-endpoint]`；「群聊 A」的 15 条 Invocation（11789–11800、11958–11960）
- 约束：全程只读；未重放、未产生模型或生图费用；未导出对话正文，下载的 Invocation 详情在调查结束后已删除。本报告不含群组名称、成员昵称、消息正文与 Telegram 消息 ID，成员记为「用户 A」
- 时间：正文一律为 CST（UTC+8）

## 1. 结论摘要

1. **直接原因是一条写死的生图上限**。单个 Invocation 最多提交 3 次生图，已完成的也计数。Invocation 会被后续消息续期，用户 A 在同一个 Invocation 里连续提了 5 次修改，第 4、5 次被拒。
2. **上限被说成了额度耗尽**。工具报错没有说明它何时恢复，Bot 向用户表示生图额度已用完、恢复时间未知。实际上约 2 分钟后的下一个 Invocation 上限已清零，用户为此等了约 31 小时。
3. **这条上限没有出现在已审核的 PRD 里**。它来自 2026-10-02 的提交 `d05ec359`；对应的 AI 实施文档写明「具体限额不在此编造」，实现时沿用了闹钟的 3。
4. **第二天续作时又连续失败了三次**：动手前没有回忆、第一次回忆被摘要关键词漏掉相邻事件、第二次回忆找回了全部文字设定却拿不到图片引用。
5. **Bot 多次口头承诺「记下了」，但没有任何一次写入 Memo Pad**。
6. 用户 A 最终放弃。Bot 另外白提交了一次没有参考图的生图。

## 2. 现象与影响

- 用户 A 提供一张参考图，请 Bot 基于它生成图片并逐轮修改。前 10 次生成成功，最后两项修改没有出图。
- 约 31 小时后用户 A 询问生图是否可用。Bot 主动续作，但没有带参考图，成品与此前定下的设定不符。
- 随后的 26 分钟里用户 A 多次指出问题，Bot 两次回忆后仍无法取得参考图，要求用户重发，用户放弃。
- 费用影响：一次无效的生图提交。信任影响：用户明确表达了「以为它有记忆、会调取之前的图片，其实没有」。

## 3. 时间线

### 2026-11-27

| 时间 | Invocation | 事实 |
| --- | --- | --- |
| 09:37–09:56 | 11789–11796 | 7 次 `image_generate` 全部成功，每次带 1 个 `img_` 引用（用户 A 的参考图）。11792 只有一次文字发送 |
| 09:57–10:04 | 11797 | 同一个 Invocation 内提交 5 次：前 3 次成功，10:02:02 与 10:03:34 的两次以 `image_generate_quota_exceeded` 被拒。两次请求的参数完整（参考图引用，加 378 字与 429 字的 prompt） |
| 10:03–10:04 | 11797 | Bot 告知用户额度用完、恢复时间未知，并承诺之后补上 |
| 10:05 | 11798 | 新 Invocation 开始，上限已清零；没有重试 |
| 10:05–10:17 | 11798–11800 | 只有文字发送。Bot 多次表示已经记下，没有任何 Memo Pad 写入 |

12 次调用里核对了 9 次的引用，都是同一个，即原始参考图；其余 3 次各带 1 个引用，没有逐一比对。生成方式是原始参考图加上逐轮累积的文字 prompt，不是基于上一版输出继续修改。

### 2026-11-28

| 时间 | Invocation | 事实 |
| --- | --- | --- |
| 16:47:21 | 11958 | 用户 A 询问生图是否可用。Bot 决定主动续作 |
| 16:47:42–16:47:53 | 11958 | 读生图 Skill、`list_image_models`、3 次 `search_image_assets`。没有调用任何回忆工具 |
| 16:48:01 | 11958 | 提交 `image_generate`，`input_image_refs` 为空，prompt 187 字 |
| 16:48:31 | 11958 | 图片送达。用户指出与设定不符 |
| 16:49:57 | 11958 | `search_memory` 0 命中；`search_group_memory` 命中 2 条，只含「承诺补图」那个事件 |
| 16:50:00 | 11958 | `read_group_messages` 读回 18 条，没有设定内容。Bot 继续请用户提供参考图 |
| 17:09:30–17:09:33 | 11959 | 用户指出此前发过图片。3 次 `search_group_memory`（0、17、2 命中），`search_memory` 0 命中 |
| 17:09:35 | 11959 | `read_group_messages` 读回 43 条，文字设定全部找回；参考图与历次成品只显示为媒体类型标记 |
| 17:09:46 | 11959 | Bot 说明设定已找回但取不到原图，请用户重发。用户放弃 |
| 17:13 | 11960 | 对话结束 |

## 4. 原因分析

### 4.1 生图上限的计量单位与 Invocation 的实际生命周期不符

- 上限是常量 `MAX_PER_INVOCATION = 3`（[`src/image/bridge/shared.ts`](../../src/image/bridge/shared.ts)），没有配置项。
- 判定在 [`src/image/bridge/submission.ts`](../../src/image/bridge/submission.ts) 的 `thisInvocationAtQuota`：统计该 Invocation 创建过的 `image` 任务总数，不区分状态。任务创建时 [`src/store/long-tasks/index.ts`](../../src/store/long-tasks/index.ts) 的 `maxPerInvocation` 在事务内再查一次，同样不区分状态。
- 常量上方的注释写的是「Outstanding generations」，与实现不一致。
- 线上 `agent.context.idle_grace_seconds` 为 60：运行期间到期的 Bucket 会并入同一个 Invocation。11797 因此持续了约 7 分钟，承载了同一位用户的 5 次独立请求。

### 4.2 报错文案让模型把上限当成额度

模型收到的只有 `image generation quota of 3 per invocation reached`（[`src/plugins/image/image.ts`](../../src/plugins/image/image.ts)）。「Invocation」不是模型能换算成时间的单位，文案也没有说明新消息到来即恢复。模型据此告诉用户额度耗尽，并且在之后的 Invocation 里没有重试。

### 4.3 上限的来源

- 已审核 PRD（`doc/design/`）中没有这条上限。
- 提交 `d05ec359`（2026-10-02）引入。
- `agent-doc/design/archived/20261002 生图核心迁移与系统插件 Phase 1 设计计划.md` 的风险表写的是「增加明确任务额度……具体限额不在此编造」。
- 代码注释说明数值与形态取自闹钟（"matching alarm's quota style"）。闹钟任务会长期处于等待状态，按总数计是合理的；生图任务约 20 秒完成，照搬后含义变了。

是否有过对话中的口头确认，本次无法查证。

### 4.4 承诺没有落盘

11795–11800 的工具调用只有 `send` 与 `image_generate`。Bot 在多条回复里表示已经记下，推理记录显示它把「记下来」当作接话，没有考虑写 Memo Pad。11-28 两次 `search_memory` 均为 0 命中，该 Chat 当时的 memo 列表里也没有相关条目。

短期 memo 会自动注入后续 Invocation。假如当时写了一条带设定的 memo，第二天的续作就不需要回忆。

### 4.5 续作前没有回忆

11958 的推理记录显示模型想过搜索记忆，随后依据保留上下文里残留的「承诺补图」片段，判断「没有其他细节」，直接生成。那份片段只包含承诺，不包含设定。

### 4.6 摘要关键词入口漏掉了相邻事件

群聊记忆把这段对话整理成两个相邻事件：前一个记录「提供参考图并反复调整」，后一个记录「承诺之后补图」。11958 的搜索关键词只匹配到后一个；前一个事件的摘要用词不同，一个关键词都没有命中。模型读完后一个事件的 18 条原文就停了，没有向前多读。

这是按摘要检索的固有损失：命中与否取决于摘要措辞，而不是原文里有没有这件事。

### 4.7 回放原文拿不到图片引用

- `read_group_messages` 的渲染（[`src/context/group-memory/messages.ts`](../../src/context/group-memory/messages.ts) 的 `renderMessage`）对媒体只输出类型标记，不输出 `img_` 引用，也不带时间戳。
- `image_generate` 的 `input_image_refs` 只接受当前 Conversation Context 里可解析的 `img_` 引用。
- 引用的解析要求来源消息仍在保留段内（[`src/context/refs.ts`](../../src/context/refs.ts) 的 `resolve`）。
- 线上 `ref_ttl_hours` 为 72，事故发生在约 31 小时后，所以不是 TTL 到期。

模型在 11959 的推理记录里明确指出了这一点：回放只有占位标记，没有可用的引用。

## 5. Action items

### A1. 生图上限改为只统计未完成的任务

- 判定从「本 Invocation 创建过的生图任务总数」改为「本 Invocation 创建且仍处于 `waiting` 的生图任务数」。一张图出完就让出名额。
- 效果：逐张修改不再触及上限；同时进行的生成仍限制在 3 个以内。
- `submission.ts` 的预检与 `long-tasks` 事务内的复查必须用同一口径。闹钟沿用现有的按总数计，不随本项改变。
- 连带建议（未单独确认）：改写报错文案，告诉模型这是同时进行的上限、等任意一个回执到达后再提交剩余请求、不要对用户表述为额度耗尽。回执会送回同一个 Invocation，模型可以自行排队。
- 验收：在一个 Invocation 内顺序完成 4 次以上生成全部通过；同时提交第 4 个时被拒，且报错文案符合上一条；审计的 `error_code` 行为有对应断言。

### A2. 回忆时把近 72 小时的图片显示为可引用的图片对象

- 回忆工具返回的消息里，发送于过去 72 小时内的图片不再只显示类型标记，而是带上当前 Conversation Context 可用的 `img_` 引用，可以交给 `read_image`、`image_generate` 与 `send`。
- 适用于 `read_group_messages` 与 A3 新增的工具。
- 实施要点：
  - 引用经 `ContextRefStore.mediaRef` 签发，`sourceSeq` 挂在本次工具结果上；`search_stickers` 签发 `stk_` 是同类先例。
  - 只为本 Chat 的媒体签发，不跨 Chat。
  - `AGENTS.md` 的安全不变量「图片只能引用当前 Conversation Context 授权且未过期的 capability」需要补充：Chat 级回忆工具可以为本 Chat 窗口内的媒体授权。
- 实施时决定：72 小时是固定值还是跟随 `agent.context.ref_ttl_hours`（当前恰好也是 72）；是否包含 Bot 自己发出的图片；单次调用签发数量的上限。
- 验收：复现本次场景，回放 31 小时前含图片的消息后，返回的引用能被 `image_generate` 接受；超过窗口的图片仍只显示标记；另一个 Chat 的媒体无法取得引用；`context_refs` 落盘状态有断言。

### A3. 增加精确回忆历史消息的功能

- 新增一个按成员查询同一 Chat 内历史发言的工具，直接查原始消息，不经过群聊记忆摘要。
- 成员标识沿用 `read_member_profile` 的格式。
- 结果带消息 ID 与发送时间，便于接着用 `read_group_messages` 读取前后的消息。
- 实施时决定：
  - 是否支持关键词与日期范围；关键词匹配方式。
  - 新工具与 `read_group_messages` 是否继续依赖 `group_memory.enabled`。原始消息不依赖整理即可查询。
  - `/cut_topic` 划掉的历史与 `ignored_user_ids` 中的成员是否可被查到。现有 `loadMessagesInRange` 不过滤 cutoff。
  - 发送者记录在 `message_revisions` 上且没有可用索引，需要迁移。
  - 作为原语直接暴露还是经 `execute` 调用；原语需要加入 `EXECUTE_PRIMITIVES`。
- 验收：按成员查询只返回本 Chat 该成员的可见消息；另一个 Chat 的同一成员查不到；结果的消息 ID 可以直接作为 `read_group_messages` 的范围。

### A4. 在系统提示词中引导模型查询周围消息与记忆

- 目标：模型在上下文不足时主动查询前后的消息与记忆，而不是凭残留片段动手。
- 本次暴露的三个具体缺口，可作为撰写时的依据：
  - 续做此前未完成的任务前，没有先读原始讨论（4.5）。
  - 读到一个事件后，没有查看相邻的事件（4.6）。
  - 口头承诺之后再做，却没有写入 Memo Pad（4.4）。
- 具体写法与位置在实施时决定。候选位置是 `src/platform/prompts/3-capabilities.md`；稳定段语义变化需要推进 `AGENT_PROMPT_VERSION`。

### 建议顺序

A1 独立且改动最小，可以先做。A2 与 A3 共用回忆结果的渲染，建议一起设计。A4 依赖 A2、A3 的工具形态，放在最后。

## 6. 未纳入 action items 的观察

1. **放宽 A1 之后没有生图花费的硬上限**。配置里只有 token 的 `daily_budget`；顺序提交的失控循环将只受每轮工具调用预算约束。是否增加按 Chat 按天的生图上限，是独立的产品决定。
2. **`invocation list` 的过滤查询在生产上超时**。带 `--search` 或 `--from/--to` 的请求在 30、60、90 秒时各超时一次；不带过滤的全量列表约 10 秒，带 `--chat` 约 1 秒。搜索挂起期间一次普通的 `invocation get` 也超时，随后恢复。推测慢查询阻塞了服务进程，未进一步验证。

## 7. 未验证与限制

- 11-28 16:47 时参考图所在的消息是否仍在 canonical Context 的保留段内。Invocation 详情只含当批快照，本次没有读取 `context_messages` 与 `context_refs`。
- 旧媒体的文件内容在 31 小时后是否仍可取得。A2 实施前需要核对媒体下载与本地缓存的保留方式。
- memo 只查看了默认状态的列表，没有查看已过期条目。
- 11-27 下午另有一条 Invocation（11834）可能在没有尝试生图的情况下再次表示功能未恢复；只看到它的工具列表里没有生图调用，没有读正文确认。
- 生图上限是否经过对话中的口头确认，无法查证。
- 调查结论来自 15 条 Invocation 的审计记录与推理记录；推理记录是模型的私有文本，只用于说明它当时的判断依据。
