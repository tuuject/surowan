# Decisions API 入场闸门离线评估报告

- 调查时间：2026-11-10 至 2026-11-12（Asia/Shanghai）
- 方式：`surowan-utils` 只读 Admin API 拉取生产数据；本地脚本调用 OpenRouter 的 Decisions API 与 chat completions 做付费评估
- 范围：生产 endpoint 最近 1599 个 Telegram Invocation，`created_at` 为 `2026-11-01T05:20Z` 至 `2026-11-10T13:08Z`；第六轮另取 `deepseek/deepseek-v4-flash-0731` 运行过的全部 1941 个 Invocation（`2026-09-17` 至 `2026-11-11`）
- 约束：未修改代码、配置或生产状态；未执行 Invocation 重放；评估脚本、原始数据与逐条结果含群聊原文，只存在于仓库外，没有提交；本报告只含聚合统计
- 花费：六轮累计约 $0.72（OpenRouter）

## 1. 结论摘要

1. **「继续积攒」这个选项不成立。** 三选一（送入 / 继续积攒 / 抛弃）里，「继续积攒」对续话标签的 AUC 是 0.50–0.59，四个模型选它的比例都不到 4%。单独问「10 秒内还会不会发」最好 0.685，与「数一下批内有几条消息」的纯规则（0.679）持平。这与 2026-09-22 的 hold 闸门评估结论一致（见 `agent-doc/devlogs/20260922-send-barrier.md`）。
2. **「送入 / 抛弃」的上限取决于以谁为范本。** 以 `deepseek/deepseek-v4-flash-0731` 在群里的实际发言为标签时，三个决策模型用同一句提问都达到 0.93–0.95（第 5.6 节）；这是用户认可的「读空气」范本，也是本报告最终采用的口径。对 150 条人工标签则只有约 0.8：最好的组合是 `perplexity/pplx-decider-v1.2` 的三档分类（0.816），`typesafe/jev-1.14` 最好 0.789。换判据、换历史长度、换中文指令、换到发送前看草稿，都没有突破。
3. **对人工标签，瓶颈不在决策模型。** 同样的输入交给 `anthropic/claude-sonnet-5.5` 与 `anthropic/claude-haiku-5.5` 打分，AUC 是 0.760 与 0.770，不比决策模型高。
4. **按范本定阈值的阀门明显好于按人工标签调出来的。** `typesafe/jev-1.14` 取阈值 0.57 时，在留出数据上丢掉范本会回的 3/71、拦掉范本沉默的 82/129；用在其他模型实际发出的 54 条回复上，拦掉 14 条，其中没有人工标注为「该回」的。按人工标签调参时，零误杀只能拦掉约 15% 的回复。
5. **省钱不是理由。** 未受 nudge 污染的日子里，430 次沉默 Invocation 总成本 $0.70，平均每次 $0.0016。
6. **`openai/gpt-6-luna-decisions` 最差也最贵**，且有约 3% 的拒答。**没有证据表明竞品的中文表现优于 jev**：Perplexity 与 jev 在误差范围内打平。
7. **延迟比 9 月好很多。** 各决策模型 p50 约 0.65–0.85 秒，2026-09-22 评估时 jev 是 1.9 秒。

## 2. 背景与问题

设想是在 Bucket 到期、创建或 attach Invocation 之前增加一道由决策模型判断的闸门，位置与 `proactiveAllows` 相同（`src/orchestration/invocation-queue/due.ts` 的 `queueCollectingBucket` 与 `attachDueBucket`）。用户可配置提问、传入的历史条数与批内条数，以及三个结果：送入 Invocation、继续积攒 Bucket、抛弃本次 Bucket。

评估过程中目标收敛为：**让 bot 少插话**，决策模型作为人格 prompt 之后的最后一道阀门。

## 3. Decisions API 事实

以下来自 OpenRouter 文档与公开模型列表，取于 2026-11-10。端点标注为 alpha，形状可能变化。

- 端点：`POST https://openrouter.ai/api/alpha/decisions`，必填 `model`、`state`、`questions`。它不是 chat completions，现有 Provider 注册表的模型调用路径不能直接复用。
- `state`：字符串或任意 JSON，没有 messages 与 role 的概念。带图片会进入长上下文模式，文档称更慢、更不准。
- `questions`：以问题 id 为键的对象。类型有 `noul`（是非，返回 P(yes)）、`choice`（`criteria` 为选项名到描述的映射，返回各选项概率与 `confidence`）、`score`（有序等级）、`box`（仅 jev-1.14）。一次请求可以带多个问题，互相独立作答。
- 返回没有任何理由文本；模型可对单个问题返回 `refusal`。
- 输入计费，输出免费。评估时的每百万输入 token 价格：`perplexity/pplx-decider-flash-v1.2` $0.01，`perplexity/pplx-decider-v1.2` $0.02，`typesafe/jev-1.14` $0.042，`openai/gpt-6-luna-decisions` $0.10。
- 同一端点上另有 Microsoft、Cloudflare、Upstage、Liquid AI、Morph、Parallel 等厂商的决策模型，本次未测。各家页面均未给出分语言的准确率。

## 4. 数据与标签

### 4.1 批次重建

Admin API 不暴露 Bucket 边界。批次由 Invocation 快照中的 `new` 段反推：在成功发送的时刻与超过 45 秒的间隔处切开。这是近似，不等于真实 Bucket。

输入为纯文本：默认 10 条历史加批内最多 10 条消息，图片与贴纸只保留 `[photo]`、`[sticker]` 这类占位和 caption。

### 4.2 三种标签

| 标签 | 定义 | 用途 | 局限 |
| --- | --- | --- | --- |
| 行为标签 | bot 读完该批后是否成功发送 | 第一轮「送入 / 抛弃」 | 衡量的是「预测主模型会不会回」，不是「该不该回」 |
| 续话标签 | 按 15 秒窗口重放 Bucket 时钟，关门后 10 秒内批内发言人是否再次发言 | 「继续积攒」 | 忽略了运行中轮次对 deadline 的推迟 |
| 人工标签 | 用户逐条标注该回 / 可回可不回 / 不该回 | 第二轮起的主标签 | 单人单次标注，「该回」只有 21 条 |

### 4.3 nudge 污染

按天统计沉默 Invocation 占比：11/07–11/09 三天合计 10/457，其余日期在 10%–70% 之间。这三天的沉默几乎消失，行为标签不可信，连同比例异常的 11/05 一并从行为标签样本中剔除。人工标签样本不受此影响，从全部日期抽取。

### 4.4 人工标签分布

150 条，按 bot 当时是否回复各抽 75 条，标注页面不显示 bot 是否回复。

| 人工判断 | 条数 | 其中 bot 实际回了 |
| --- | --- | --- |
| 该回 | 21 | 16 |
| 可回可不回 | 69 | 37 |
| 不该回 | 60 | 22 |

bot 实际回复的 75 批里，29% 被标为不该回。「bot 实际是否回复」对人工标签的 AUC 为 0.698。

## 5. 结果

AUC 的 0.5 等于随机。行为标签与续话标签每格约 300 条，误差约 ±0.03；人工标签的「该回 vs 不该回」只有 81 条，误差约 ±0.06；发送前草稿一组只有 75 条，误差约 ±0.09。

### 5.1 第一轮：三选一，对行为标签与续话标签

提问未告知 bot 的名字。

| 模型 | 送入/抛弃：三选一 | 送入/抛弃：是非题 | 继续积攒：三选一 | 继续积攒：是非题 | p50 延迟 | 每千次 |
| --- | --- | --- | --- | --- | --- | --- |
| `typesafe/jev-1.14` | 0.707 | 0.712 | 0.540 | 0.573 | 685 ms | $0.050 |
| `perplexity/pplx-decider-v1.2` | 0.685 | 0.690 | 0.589 | 0.680 | 813 ms | $0.016 |
| `perplexity/pplx-decider-flash-v1.2` | 0.685 | 0.669 | 0.533 | 0.685 | 729 ms | $0.008 |
| `openai/gpt-6-luna-decisions` | 0.604 | 0.552 | 0.499 | 0.607 | 826 ms | $0.105 |
| 规则：上一条历史是 bot 发的 | 0.602 | | | | | |
| 规则：批内消息条数 | | | 0.679 | | | |

OpenAI 在 600 次调用里有 20 次拒答与 4 次 502/503。

### 5.2 第二轮：告知 bot 名字，多版提问，对人工标签

`state` 增加 bot 的名字与用户名，回复 bot 的消息标出回复对象。每个模型取「该回 vs 不该回」最好的一版。

| 模型 | 最好的提问 | AUC | p50 延迟 |
| --- | --- | --- | --- |
| `perplexity/pplx-decider-v1.2` | 三档克制分类，取 1−P(保持沉默) | 0.816 | 829 ms |
| `typesafe/jev-1.14` | 「友好的群友会回吗」，4 条历史 | 0.789 | 662 ms |
| `perplexity/pplx-decider-flash-v1.2` | 「友好的群友会回吗」，4 条历史 | 0.783 | 737 ms |
| `openai/gpt-6-luna-decisions` | 「友好的群友会回吗」 | 0.632 | 830 ms |
| `anthropic/claude-haiku-5.5`（chat，0–100 打分） | | 0.770 | 1797 ms |
| `anthropic/claude-sonnet-5.5`（chat，0–100 打分） | | 0.760 | 1495 ms |
| `deepseek/deepseek-v4-flash`（chat，0–100 打分） | | 0.614 | 1304 ms |

观察：

- 告知 bot 名字后 Perplexity v1.2 的同一提问从 0.76 到 0.80，在误差范围内。
- 历史取 4、10、20 条结果相近。
- 「克制」措辞不优于「友好」措辞；中文指令没有提升。
- Perplexity 在 4 路并发下出现 1%–9% 的 HTTP 429；jev 没有报错。

### 5.3 被否定的判据

| 判据来源 | 最好 AUC | 说明 |
| --- | --- | --- |
| 「只在能提供实际价值时开口」 | 0.692 | 调查者根据错判样本猜测的口径，比第二轮差 |
| 用户事后口述的三条「不该回」规则 | 0.539（多数低于 0.5） | 模型越认定属于这三类，人工标签越倾向该回或可回可不回；口述规则与标注时的实际判断不一致 |
| 线上全局 prompt「值得接住 / 应当沉默」原文 | 0.773（jev）、0.747（Perplexity v1.2） | 与第二轮持平 |
| 「bot 是否已就同一件事回过」 | 0.525 | 接近随机；这是 prompt 中最依赖上下文的一条 |

### 5.4 发送前看草稿

把 bot 实际发出的回复文本加入 `state`，只在 bot 回复过的 75 批上评估。

| 提问 | `typesafe/jev-1.14` | `perplexity/pplx-decider-v1.2` |
| --- | --- | --- |
| 按 prompt 规则这条是否不该发 | 0.700 | 0.722 |
| 这条回复是否添了新内容 | 0.615 | 0.588 |
| 对照：同样 75 批、不看草稿的第二轮提问 | 0.679 | 0.739 |

看草稿没有带来提升。

### 5.5 保守阀门的实际效果

阈值取在「不误杀任何人工标注的该回」处。

| 位置 | 模型与提问 | 拦掉「不该回」 | 连带拦掉「可回可不回」 |
| --- | --- | --- | --- |
| Invocation 之前 | Perplexity v1.2 三档分类 | 24 / 60 | 11 / 68 |
| Invocation 之前 | jev，prompt 的「值得接住」 | 14 / 60 | 4 / 69 |
| 发送之前 | jev，「是否不该发」 | 7 / 22 | 7 / 37 |

以 Perplexity v1.2 三档分类计，bot 实际回复的 73 批中有 11 批（15%）会被拦掉，其中 7 批是人工标注的不该回。jev 在同一提问、同一要求下只能拦掉 2 批，校准更差。

### 5.6 第六轮：以 deepseek-v4-flash-0731 的发言为范本

用户指出线上使用 `deepseek/deepseek-v4-flash-0731` 时的发言分寸最接近期望，并要求只看它发到群里的 `send`，不看内部过程。标签因此定义为：该批之后群里是否出现了它的成功发送。被 nudge 催出的发言照常计入。

- 该模型共 1941 个 Invocation，切出 2585 批。非直接触发的 2370 批里它回了 41%；@ 或回复 bot 的 215 批里回了 79%。
- 剔除 11/06 与 11/11 共 196 个 Invocation：11/06 关闭 nudge 后出现过「写了草稿但没有调用 `send`」的情况，群里看到的沉默不是模型的选择。
- 评估集是非直接触发批次中随机抽取的 400 条，回复率 38%，误差约 ±0.02。提问沿用前几轮的版本，没有在这批数据上调过。

| 模型 | 「友好的群友会回吗」 | 三档分类 | prompt 的「值得接住」 | p50 延迟 | 400 次花费 |
| --- | --- | --- | --- | --- | --- |
| `perplexity/pplx-decider-flash-v1.2` | 0.954 | 0.907 | 0.586 | 780 ms | $0.006 |
| `perplexity/pplx-decider-v1.2` | 0.935 | 0.906 | 0.877 | 912 ms | $0.013 |
| `typesafe/jev-1.14` | 0.933 | 0.906 | 0.788 | 691 ms | $0.039 |

三个模型均无报错。纯规则最好的是「离 bot 上一次发言有多近」，0.713。

泄漏检查（jev，「友好的群友会回吗」）：只看纯真人发言的批次 0.941；按群拆分 0.89–0.99；Invocation 的开场批次 0.933，运行中途的批次 0.932。抽样阅读显示沉默批次多为单张图片、无法解析的消息与附和，回复批次多带有具体的新内容；分数中位数为 0.53 对 0.82。没有发现泄漏。

阈值在随机一半数据上确定，在另一半上验证：

| 模型 | 阈值 | 留出集：丢掉范本会回的 | 留出集：拦掉范本沉默的 | 人工标签：拦掉不该回 / 可回可不回 / 该回 | 其他模型实际发出的 54 条回复：拦掉不该回 / 可回可不回 / 该回 |
| --- | --- | --- | --- | --- | --- |
| `typesafe/jev-1.14` | 0.57 | 3 / 71 | 82 / 129 | 38/60、31/69、3/21 | 7/16、7/26、0/12 |
| `typesafe/jev-1.14` | 0.65 | 9 / 71 | 103 / 129 | 45/60、41/69、7/21 | 9/16、13/26、3/12 |
| `perplexity/pplx-decider-flash-v1.2` | 0.58 | 5 / 71 | 92 / 129 | 40/57、37/67、7/20 | 7/16、9/26、2/12 |
| `perplexity/pplx-decider-v1.2` | 0.30 | 5 / 71 | 68 / 129 | 41/60、30/68、4/20 | 7/16、8/25、2/12 |

阈值不能跨模型套用：同一句提问，jev 与 Perplexity v1.2 的合适阈值相差近一倍。

人工标签按运行模型拆开，可以看到范本模型整体更沉默：人工标注「不该回」的批次里它回了 6/33，其他模型回了 16/27；「该回」的批次里它回了 4/8，其他模型 12/13。两组「是否回复」对人工标签的 AUC 相近（0.659 与 0.665），所以它是更克制，而不是分得更准。

第一轮以其他模型的发言为标签只有 0.71，与本轮差距很大。推测是范本模型的发言决定更有规律、更能从文本预测；这一点没有单独验证。

## 6. 为什么对人工标签到顶

- 人工标注中存在文本无法解释的判断：直接回复 bot 的 10 批里，5 批标为该回、3 批标为不该回；标为该回的批次里有完全未涉及 bot 的。
- 图片不可见：「可回可不回」里 62% 含图片或贴纸，模型只看到占位。
- 「该回」只有 21 条，所有提问版本都在同一批样本上挑选，最好成绩偏乐观。
- 主模型的发言决定依赖人格 prompt 与完整 Context，决策模型只看到截取的文本。

## 7. 对实现的含义

以下是调查者的判断，未经用户确认，不构成待办。

- 不做三选一。「继续积攒」没有可用信号，只保留「送入」与「抛弃」。
- @、回复 bot、触发关键词与私聊直接放行，不经过模型，与 `ProactiveReplyGate` 的 `direct` 分支一致。
- 超时、限流、拒答与其他错误一律放行，保持「不丢回复」。
- `processDueBuckets` 是同步 SQLite 事务，决策是约 1 秒的异步 HTTP：需要拆成事务内登记、事务外请求、回来后再确认 Bucket 仍为 `collecting`。决策期间到达的新消息会进入同一个 Bucket，「抛弃」的结论需要重判。
- `model_calls.role` 有 CHECK 约束，新增角色需要迁移；被抛弃的 Bucket 没有 Invocation，决策的概率、耗时与花费需要能按 Bucket 审计。
- 建议先上影子模式：只记录概率与本应做出的决定，不真正拦截。跑一段时间后用未被调参污染的数据确定阈值，再决定是否开闸。
- 提问用单个是非题即可，默认取「友好的群友会回吗」；阈值按模型单独设定，jev-1.14 的起点是 0.57。
- 实施计划见 `agent-doc/design/20261112 Decisions 入场闸门实施计划.md`。

## 8. 未覆盖

- 批次边界是反推的，不是真实 Bucket；没有覆盖 attach 路径上的差异。
- 没有测试图片输入，也没有测试 Microsoft、Cloudflare、Upstage、Liquid AI 等其余决策模型。
- 人工标签为单人单次标注，没有重复标注，一致性未知。
- 第 5.1–5.5 节没有独立留出集，最好成绩与保守阀门数字都未在新样本上复验；第 5.6 节的阈值做了对半验证，但提问本身选自前几轮。
- 第 5.6 节的标签包含 nudge 催出的发言，也继承了批次边界反推的近似。
- `usage.cost` 的单位在 OpenRouter 文档中有「credits」与「USD」两种说法，本报告按美元记。
- 没有评估限流、并发与长时间运行下的稳定性。

## 9. 附：评估中使用的主要提问

`state` 的形状：

```json
{
  "bot": { "name": "塑料碗", "username": "TcdwLobsterBot" },
  "history": [{ "from": "…", "text": "…", "reply_to": "…" }],
  "pending": [{ "from": "…", "text": "…" }]
}
```

bot 自己的消息以 `塑料碗 [bot]` 作为 `from`。各提问共用同一段开场：

> A group chat has an AI member named 塑料碗 (@TcdwLobsterBot), described in `bot` and shown as `塑料碗 [bot]`. `pending` holds the new messages since the bot last looked; `history` holds earlier messages.

第二轮成绩最好的两版：

- 是非题：`Would the bot, behaving like a friendly regular member, send a reply after reading pending?`
- 三档分类：`The bot should be a restrained member that does not interject often. Classify pending.`
  - `must_reply`：Someone is talking to the bot or clearly waiting for it; staying silent would be rude.
  - `optional`：The bot could add something, but nobody would miss it if it stayed silent.
  - `stay_silent`：People are talking among themselves or the message needs no answer; a bot reply would be an interruption.

取自全局 prompt 的中文判据（jev 最好的一版）：在开场后列出「值得接住」的三种情况，问 `pending` 是否属于值得接住的情况。
