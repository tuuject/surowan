# 群聊记忆积压事故调查报告

- 调查时间：2026-11-12 16:00–17:00 CST（08:00–09:00Z）
- 方式：SSH 读取生产主机与 SQLite；`surowan-utils` Admin API（`doctor`、`chat list`、`group-memory list`；一次止血写入）
- 范围：生产 endpoint `[prod-admin-endpoint]`；主机 `[prod-host]`，`/opt/plastic-wan`；Docker Compose
- 约束：除关闭「群聊 B」群聊记忆外，未修改代码、配置或其它生产状态；未重放、未导出对话正文；报告只含聚合统计与脱敏字段
- 复核：2026-11-12 对照 `src/context/group-memory/` 源码复核。更正了 4.4 中「退避占用调用名额」的表述，新增 4.5 跳过条件、A0 与 A4，补充了若干数据口径。操作员决定：放宽「事件范围不得重叠」、summary 上限提升到 200 字（A0）；重新启用时跳过关闭期间（A3）

## 1. 结论摘要

1. **这不是进程故障**。容器正常、Telegram 入库正常、sleeping worker 在运行；`group_memory_state` 为 `idle`，没有卡死的 `running` 认领。
2. **群聊 A（chat 2）的群聊记忆仍在生成，但只生成到 2026-10-10**。`group_memories` 的 `max(day)` 是 10-10，最新一行写于 11-12 07:43Z；水位停在 message_id 34313，之后还有 20,889 条待整理。模型通过 `search_group_memory` 只能看到 10-10 及更早的摘要。
3. **直接原因是「全量历史回填 + tool model 低成功率 + 30 分钟退避」三件事叠加**，不是单一代码崩溃：
   - 群聊记忆迁移 048 于 11-02 04:52Z 应用，首次 tool model 调用在 04:54Z；水位默认 0，worker 从各 Chat 最早一条已存消息开始回填。群聊 A 最早消息是 2026-08-26，截至调查时共存 34,092 条；群聊 B 最早消息是 2026-07-29，截至调查时共存 142,303 条（两者都是当前总数，不是启用时的回填量）。
   - `tool_model = deepseek/deepseek-flash`、`thinking_level = off`；11-02 至 11-12 共 1,235 次 `role='tool'` 调用，**912 次失败（73.8%）**，其中 907 次是 `group_memory_invalid_output`（范围重叠、坏 JSON、summary 超长等），不是网络或额度。失败中过半（491 次）是「范围重叠」，操作员已决定放宽这条限制（A0）。
   - 每次失败退避 30 分钟；成功一次至多推进 120 条消息。群聊 A 最近三个完整日水位增量约 1.6k–3.4k/天，20,889 条 backlog 按当前速率还要约 11–14 天。
4. **群聊 B（chat 1）更严重**：watermark 停在 09-16，待整理 135,824 条，按当前吞吐和每日约 1.9k–2.4k 新消息永远追不上。已按操作员指令关闭其群聊记忆作为止血；群聊 A 保持不变。
5. **调度上，群聊 A 的新记忆不出现，主要是「最旧日期优先」加上它自己的失败退避**；跨 Chat 抢占名额的影响有限（4.4）。「Chat 忙碌即跳过」等跳过条件本次未排查，群聊 B 约 8 天的停摆和 11-06–11-08 两群同时停摆都没有解释（4.5）。

## 2. 现象与影响

- 操作员观察：群聊 A 很久没有新的群聊记忆。
- 实际数据：
  - chat 2「群聊 A」`group_memory_state.consolidated_through_message_id = 34313`（2026-10-10 16:04 CST），`messages` 最新 id 55955（11-12 16:17 CST），待整理 20,889 条。
  - `group_memories` 对 chat 2 的 `max(day) = 2026-10-10`；最新 `created_at = 2026-11-12T07:43:06Z`，说明 worker 还在写，但写的是旧日期。
  - chat 1「群聊 B」watermark 133481（09-16），待整理 135,824 条，`max(day) = 2026-09-16`。
- 影响：
  - 近期事件无法被 `search_group_memory` 检索；`read_group_messages` 仍可读原文，但模型不知道近期 message-id 区间，实际不可发现。
  - 每个 Chat 的整理被自己的旧 backlog 与 30 分钟退避占住，新日期只能排在旧日期之后。跨 Chat 的影响只有串行等待慢调用（4.4）；群聊 B 已关闭。
  - 原始消息、Revision、已有记忆均未丢失；没有数据删除。

## 3. 调查范围与数据

### 3.1 环境

| 项目 | 值 |
| --- | --- |
| 主机 | `[prod-host]`，`/opt/plastic-wan` |
| 部署 | Docker Compose；`ghcr.io/tuuject/surowan:main`，revision `2d448faf`，镜像构建 `2026-11-11T17:53Z` |
| 容器 | 启动 `2026-11-12T04:44Z`，Up 4h，`RestartCount=0`，无 OOM |
| 资源 | 磁盘 38G/已用 19G；内存 1.9G/已用 843M；无明显压力 |
| DB | `/data/plasticwan.sqlite`，约 761 MB；只读 `mode=ro` 查询 |

### 3.2 Chat 与水位（2026-11-12 08:30Z）

| Chat | 群名 | 水位 message id | 水位日期 | 待整理 | 最新消息 | 已有记忆 max(day) | 最后成功 |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| 2 | 群聊 A | 34313 | 2026-10-10 | **20,889** | 55955（11-12） | 2026-10-10 | 11-12 07:43Z |
| 1 | 群聊 B | 133481 | 2026-09-16 | **135,824** | 298813（11-12） | 2026-09-16 | 11-12 05:20Z |
| 8 | 群聊 C | 799 | 2026-11-12 | 4 | 804 | 2026-11-12 | 11-12 06:22Z |
| 10 | 群聊 D | 1714 | 2026-11-12 | 0 | 1714 | 2026-11-12 | 11-12 07:18Z |

`chat_pause` 为空；`group_memory_state` 全部为 `idle`，没有 `running` 卡死。群聊 A / 群聊 B 的 `error_code` 都是 `group_memory_unavailable`，`next_attempt_at` 是失败退避时间。

### 3.3 Tool model 调用

`model_calls` 中 `role='tool'` 的记录（11-02 04:54Z 至 11-12 08:22Z）：

| 项目 | 数值 |
| --- | ---: |
| 总调用 | 1,235 |
| 成功 | 323（26.2%） |
| 失败 | 912（73.8%） |
| `group_memory_invalid_output` | 907 |
| `group_memory_error` | 5 |
| 总成本 | $0.3372 |

失败原因（按 `error_detail` 归类，共 912）：

| 原因 | 次数 | 占比 |
| --- | ---: | ---: |
| 事件范围重叠 | 491 | 53.8% |
| 坏 JSON | 213 | 23.4% |
| summary 超过 150 字 | 149 | 16.3% |
| 其它 schema / 越界 / 倒退 | 54 | 5.9% |
| Provider 500/503 | 5 | 0.5% |

- 口径：`role='tool'` 也包含辞典合并（`src/plugins/dictionary/merge.ts`）的调用。失败行能按 `group_memory_*` 的 error_code 区分，成功行没有区分字段，所以 323 次成功和 26.2% 是混合口径。辞典合并是手动操作，量应该很小，但没有核实。tool 调用也没有 chat_id / day，成功率无法按 Chat 或按批次拆分。
- 「事件范围重叠」对应 `parseConsolidatedEvents` 的 `first <= previousLast` 检查（`consolidate.ts:119`）。校验前不排序，所以这 491 次同时包含「真重叠」和「事件没按 first id 排序」，两者的 `error_detail` 相同，区分不开。
- 11-02 首批 3 次调用走 OpenRouter `deepseek/deepseek-v4-flash-0731`，3/3 成功；随后配置切到 `deepseek/deepseek-flash`，失败率显著上升。样本很小，只能作为线索，不能单独证明模型优劣。
- 11-05 至 11-08 成功率只有 9%–15%。但这几天仍有成功调用，群聊 A 和群聊 B 却在 11-06–11-08 都没有新增记忆。这些成功落在哪里（群聊 C/D、没有可记事件的批次，还是辞典合并），从 `model_calls` 判断不了；低成功率不能单独解释这段停滞，见 4.5。

### 3.4 水位轨迹（`group_memories.max(last_message_id)` 按创建日聚合）

| 创建日 | chat 2 水位 | chat 1 水位 |
| --- | ---: | ---: |
| 11-02 | 21,372 | 130,179 |
| 11-03 | 23,155 | 130,878 |
| 11-04 | 25,342 | — |
| 11-05 | 25,689 | — |
| 11-06–11-08 | —（无新增） | —（无新增） |
| 11-09 | 27,257 | — |
| 11-10 | 30,648 | — |
| 11-11 | 32,770 | 133,063 |
| 11-12 | 34,313 | 133,481 |

- 口径：`group_memories.max(last_message_id)` 只是水位的下界。真实水位是批次最后一条消息（`through`）；没有可记事件的成功批次会推进水位，但不写记忆行。所以「无新增」只说明没有新记忆，不严格等于水位没动。分日口径未记录（若用 `date(created_at)` 即 UTC 日）；11-12 只到 07:43Z，是不完整日。
- chat 2 最近三个完整日（11-09–11-11）增量 `+1,568 / +3,391 / +2,122`，均值约 2,360/天；扣除每日约 500–800 条新消息，20,889 条约需 11–14 天。
- chat 1 在 11-04–11-10 的 7 个完整日期没有新增记忆（11-03 成功后直到 11-11 才恢复，间隔约 8 天）；本次未能确认是配置暂停、`/pause`、忙碌跳过还是连续输出失败导致（配置 revision 历史未保留，见 4.5）。11-11 一天覆盖了 130,878 → 133,063 的 2,185 个 id，与 4.3 推算的单 Chat 约 2k/天相符；11-02→11-12 全程只推进约 3.3k 个 id，差距主要来自这段停摆，而不是吞吐模型本身。
- chat 1 的消息量口径待核对：135,824 条待整理分布在 09-16 → 11-12 约 57 天，平均约 2.4k/天，高于正文的「每日约 1.9k」（后者来源未记录，可能是近期日均）；142,303 − 135,824 = 6,479，意味着 09-16 之前的 49 天只存了约 6.5k 条（约 130/天）。这两点都不改变「现有吞吐追不上」的结论。

## 4. Root cause

### 4.1 首次启用从水位 0 开始，回填全部已存历史

迁移 `048_group_memory.sql` 于 `2026-11-02T04:52:03Z` 应用；`group_memories` 最早 `created_at` 为 11-02，首次 tool model 调用为 11-02T04:54:07Z。`group_memory_state` 行由 `claim()` 首次认领时惰性插入，水位写死 0（`store.ts:140`）；`#batchFor` 取 `loadPendingMessages` 的第一条（`ORDER BY telegram_message_id`），因此 worker 会从各 Chat 最早一条已存消息开始整理。群聊 A 最早消息是 2026-08-26，群聊 B 最早消息是 2026-07-29（首条记忆日期 08-03）；这直接产生了 2–3 个月的历史回填队列。

这不是「突然坏了」，而是功能上线时的初始水位语义：**启用即回填**。PRD（`doc/design/done/20261030-group-memory.md`）把「何时生成摘要」列为暂不决定，回填是实现时的选择，不是已确认的产品意图。对已有大量历史的群，第一次启用天然会产生数万条 backlog。

### 4.2 Tool model 对严格 JSON 的输出成功率只有 26%

群聊记忆要求模型输出一个 JSON 对象，事件范围必须引用批次内真实 message id、不得重叠、不得倒退，summary 1–150 字；任一事件不合法会导致**整批**被拒。`deepseek/deepseek-flash`、`thinking_level=off` 在这项任务上失败率 73.8%，主要失败是范围重叠（54%）和坏 JSON（23%）。这不是网络故障：Provider 500/503 只有 5 次。

`parseConsolidatedEvents` 的严格校验是刻意的（宁可整批重试，也不写入错误引用），但当前没有针对「模型格式错误」的修复/降级路径：不截断超长 summary、不接受重叠范围、不拆分批次，直接整批失败。

其中「不得重叠」这条限制本身值得重新评估。群聊里多个话题经常交错进行，同一段 message id 内可能同时发生两件事；强制不重叠，等于要求模型把交错的讨论硬切成首尾相接的区段。而重叠区间的每个 id 仍在批次内，不会产生错误引用；严格校验真正要防的是越界与倒退。操作员已决定放宽这条限制（A0）。

### 4.3 失败退避 30 分钟 + 每批至多 120 条，吞吐被锁死

- `GROUP_MEMORY_BATCH_MAX_MESSAGES = 120`，一次成功至多推进 120 条：批次不跨 Chat 本地日期，还受 4 万字符与 tool model 上下文窗口限制，每天的最后一批通常不满。
- `GROUP_MEMORY_RETRY_DELAY_MS = 30 * 60 * 1000`，任何失败（包括模型输出格式错误）都退避 30 分钟；`GROUP_MEMORY_TICK_MS = 60s`，`MAX_CONSOLIDATIONS_PER_TICK = 3`。
- 26% 成功率下，期望约 2.8 次失败才成功一次，约 85 分钟推进一批；单 Chat 至多约 2,000 条/天。群聊 A 每天新增约 500–800 条，净追平速度约 1,200–1,500 条/天；群聊 B 每天新增约 1,900–2,400 条，净追平约 100 条/天甚至为负。
- 失败后 30 分钟退避对 Provider 故障合理，但对模型格式错误过于保守：重试时输入完全相同（水位不变，旧日期也不会再有新消息），只是在等下一次采样。重试成功率本次没有数据（`model_calls` 没有批次标识），无法确认同一批次是否会反复失败。

### 4.4 最旧优先：新消息排在 backlog 后面

`#batchFor` 永远取水位之后最旧的 pending 日期，新消息必须等旧 backlog 全部处理完才可能被整理。这就是「群聊 A 的新记忆一直不出现」的直接调度原因：它不是没有新消息，而是新消息排在 10-10 之后。

跨 Chat 的串行影响有限：

- `SleepingService.tick` 按配置顺序遍历候选 Chat，逐个 `await` 整理；`MAX_CONSOLIDATIONS_PER_TICK=3` 是每个 tick 实际发起调用的上限（失败也计数），不是并发度。
- 处于退避中的 Chat 在 `claim()` 就失败、直接跳过，不计入名额（`sleeping.ts:131-145`）。退避不会占用其他 Chat 的名额；跨 Chat 的影响只剩串行等待慢调用（单次最长 120 秒超时），以及同一 tick 已有 3 次调用时，排在后面的 Chat 要等下一个 tick。
- 关闭群聊 B 后，群聊 A 的积压与失败行为不变（第 5 节），与此一致。

### 4.5 其它跳过条件（未排查）

`#batchFor` 与 `tick` 在以下情况会跳过某个 Chat 或整轮，跳过都不写日志：

- 同 Chat 有 queued/running Invocation 或 collecting Bucket（`#chatBusy`，`sleeping.ts:246`）。这条闸门对 10-10 这类旧日期同样生效，但它防的「回复还在生成时摘要与之赛跑」只和当天有关。群聊 A/B 都是活跃群，Bot 频繁参与时会被反复跳过。
- `/pause`、全局 `zzz` 睡眠（`activeSleepUntil`）、Telegram 未就绪。

本次没有排查这些条件。有两处现象可能与之有关：群聊 B 在 11-04–11-10 停摆约 8 天；11-06–11-08 群聊 A、B 同时没有新增记忆，而同期 tool model 仍有成功调用。全局 `zzz` 或 Telegram 未就绪如果覆盖整段时间，就不会有任何调用，与同期仍有调用不符；忙碌跳过只影响单个 Chat，可能性更大，但都需要证据。

### 4.6 可观测性缺口

- `group_memory_failed` 日志与 `group_memory_state.error_code` 只记录通用的 `group_memory_unavailable`；具体是「范围重叠」「坏 JSON」还是「summary 超长」只在 `model_calls.error_detail` 里。第一眼容易误判成模型不可用/Provider 故障。建议在失败日志/面板中带上 validation reason（脱敏后）。
- 跳过原因（忙碌、暂停、退避、`zzz`）不写日志，无法回答「某段时间为什么没整理」。
- `model_calls` 的 tool 调用没有 chat_id / day，并且与辞典合并共用 `role='tool'`，成功率无法按 Chat 或按批次统计。

### 4.7 已排除/未发现

- 容器崩溃、OOM、磁盘满：未发现；容器 Up、无 OOM、磁盘充足。
- Telegram 入库中断：未发现；两个群的最新消息都在 11-12。
- `/pause` 或 `chat_pause` 阻塞：调查时 `chat_pause` 为空，但这不代表历史时段；群聊 B 11-04–11-10 的停摆原因未确认（4.5）。
- 死锁/卡死 claim：`group_memory_state.state` 全为 `idle`，没有 `running` 残留。
- 数据丢失：原文、Revision、已有记忆都在；只是新摘要没有生成。
- 未排查（不是已排除）：忙碌跳过、全局 `zzz`、Telegram 未就绪，见 4.5。

## 5. 止血措施

操作员决定先关闭「群聊 B」的群聊记忆，保留「群聊 A」继续处理；工具模型保持不变。

执行（2026-11-12 08:42Z）：

```bash
surowan-utils doctor --json
# status=ok, endpoint=[prod-admin-endpoint], mode=all

surowan-utils chat group-memory --set-json enabled=false --json -- [chat-b-id]
```

结果：

- `saved` / `active` 均为 `{"enabled": false, "idle_minutes": 60}`；`generation=12`，`restart_required=[]`，`last_error=null`。
- `group_memory_toggled` 事件：`chats=1`、`conversations=1`、`stopped_invocations=0`、`rebuilt_contexts=1`、`settled=true`（`2026-11-12T08:42:48Z`）。
- 旧记忆未删除：`group-memory list --chat=[chat-b-id]` 仍返回 09-16 的事件（本页 25 条；DB 中该 Chat 共 304 条）。
- 切换后日志只有 chat 2 在 `08:44:27Z` 的失败，没有 chat 1 的新整理尝试；chat 2 的 backlog 与 tool model 行为不变。
- 该操作可逆：把 `enabled` 设回 `true` 即可恢复；水位保持 133,481，关闭期间的新消息仍在 pending 中，恢复后会从 133,481 之后继续整理（不会丢失，但会形成新的 backlog）。在 A3 定下重新启用的语义之前，不要重新开启群聊 B。

## 6. Action items

### A0. 提高整理成功率

现状：73.8% 的调用因模型输出不合格整批失败（4.2），每次失败都退避 30 分钟（4.3）。A1–A3 只改调度与边界，不改这一点：A2 的 live lane 同样会遇到 74% 的失败率和每次 30 分钟的退避。

已决定（操作员，2026-11-12）：

- 放宽「事件范围不得重叠」的限制：
  - 保留的校验：Schema、首尾 id 必须在批次内、`first ≤ last`。
  - 取消的校验：事件之间不得重叠、输出必须按 first id 排序；落库前按 `first_message_id` 排序。
  - 要改的地方：`SYSTEM_PROMPT`（`consolidate.ts:32` 的 MUST NOT overlap / MUST be ordered）、`parseConsolidatedEvents`（`consolidate.ts:119-121` 及上方注释）、`test/group-memory/consolidate.test.ts` 的 overlapping 用例、`agent-doc/telegram-agent-flow.md` 整理一节的「范围不得重叠或倒退」。`group_memories` 表没有不重叠约束；水位仍按 `through` 推进，与事件区间无关。
  - 仍满足 AGENTS.md「整理输出必须通过事件 Schema 与批次内 message-id 校验后才能落库」。
- summary 上限：Schema 与落库上限提升到 200 字，`SYSTEM_PROMPT` 仍要求 150 字，留出余量。`group_memories` 的 `CHECK (length(summary) BETWEEN 1 AND 150)` 需要迁移重建表。

建议：

- 格式错误与 Provider 故障分开退避：`group_memory_invalid_output` 先带校验错误立即重试一次（计入 `MAX_CONSOLIDATIONS_PER_TICK`），连续失败再退避；Provider 错误与超时保持 30 分钟。
- 模型：评估换 tool model 或开 thinking（只改配置、可逆）；11-02 的 3/3 成功只是线索，先小范围对比。
- 为了能验收，tool 调用审计需要能按 Chat 区分（4.6）。

验收：

- 重叠区间的记忆能落库，能被 `search_group_memory` 返回，`read_group_messages` 能按各自区间读到原文；
- 151–200 字的 summary 能落库，超过 200 字仍整批拒绝；
- 越界、倒退、坏 JSON 仍整批拒绝，水位不动；
- 以本报告的失败分布为基线，「范围重叠」类失败归零，整体成功率明显上升。

### A1. 多个群组并行整理

现状：`SleepingService.tick` 串行 `for` + `await`；`MAX_CONSOLIDATIONS_PER_TICK=3` 是总量上限；同一 Chat 由 `group_memory_state.state='running'` 保证单飞。

目标：

- 用有界并发（如 4–8 个 in-flight）同时处理多个 Chat 的独立批次；每个 Chat 仍保持单飞（`claim` 已提供原子性）。
- 全局 in-flight/每 tick 调用预算保留，避免打爆 Provider 限流；失败/超时的 Chat 不影响其他 Chat 的 tick。
- 公平调度：按 backlog 大小/最近成功时间/退避状态分配名额，避免一个大群或一个坏批次长期垄断。
- 验收：两个有 backlog 的 Chat 在同一 tick 都能推进；一个 Chat 卡住/失败时另一个仍完成；没有重复 claim、重复 commit 或跨 Chat 串数据；SQLite 写入仍走短事务。
- 注意：并行化只解决跨 Chat 排队，不改变单 Chat 的 30 分钟退避与每批至多 120 条。退避中的 Chat 本来就不占名额（4.4），所以 A1 对群聊 A 这类单 Chat 积压收益有限，主要减少慢调用的串行等待。`SleepingService` 目前只有一个 `#controller`，并行后 `stop()` 需要能中止全部 in-flight 调用。

### A2. 旧数据与新数据分头处理

现状：单一 `consolidated_through_message_id` + 永远取最旧 pending day，新消息只能排在 backlog 后面。

目标：

- 引入「live lane」与「backfill lane」：
  - live lane 处理当前/最近日期（仍遵守 `idle_minutes`），保证新消息在当天/次日进入记忆；
  - backfill lane 处理已结束的旧日期，独立推进。
- 状态层需要至少两个游标（或一个 backfill 游标 + live 游标），并明确二者与 `group_memories` 区间的关系：不得重复、不得漏段；`search_group_memory` 与 `read_group_messages` 同时看到两条 lane 的结果。
- 两条 lane 的认领与退避要分开：现在 `claim` 和 `next_attempt_at` 按 Chat 只有一份，backfill 批次失败会让 live lane 一起等 30 分钟。
- 忙碌闸门（4.5）只应作用于 live lane；backfill 处理已结束的日期，不存在与正在生成的回复赛跑的问题。
- 迁移 `group_memory_state` 与相关查询；考虑旧数据升级时的默认值（例如 backfill 游标 = 当前水位，live 游标 = 当前水位）。
- 验收：在 20k backlog 存在时，当天的消息仍能在 idle 窗口后生成摘要；backfill 继续；两条 lane 的记忆区间不重叠、不丢失；重启后游标可恢复。
- 这是本次「群聊 A 新记忆不出现」最直接的产品修复。

### A3. 设置日期边界，避免启用时全量回灌

现状：水位默认 0；启用群聊记忆会把全部已存历史当作待处理。

目标：

- 为每个 Chat 增加显式的处理日期边界（start cutoff）：启用/恢复群聊记忆时，只处理边界**之后**的聊天记录；边界之前的历史默认不进入模型队列。反过来只处理边界之前，等于仍把历史全部入队，达不到止血目的。
- 默认边界建议为「启用时刻」（或启用当天的本地日界）；允许管理员显式指定更早日期来回填，但必须是一次明确操作，不是默认行为。
- 边界可以存配置（`group_memory.since` 之类）或初始化水位；无论存哪里，都要在 Admin/CLI 可见、可审计。
- 已决定（操作员，2026-11-12）：已有水位的 Chat 重新启用时，边界取 max(原水位, 重新启用时刻)，跳过关闭期间。关闭期间的原文仍在，`read_group_messages` 可读，但没有摘要可检索。群聊 B 重新启用后不会恢复 135k+ 积压。
- 实现注意：`group_memory_state` 行目前由 `claim()` 首次认领时惰性插入、水位写死 0（`store.ts:140`）；边界必须在启用时写入，或让 `claim()` 插入时使用边界。
- 验收：在一个有 3 个月历史、10 万+ 消息的 Chat 上启用，不会把历史全部入队；新消息从下一个 tick 开始处理；显式回填仍可用；关闭再启用按上面选定的语义处理。

### A4. 整理进度面板

现状：判断「记忆整理到哪了、为什么不动」要 SSH 查 SQLite 与 `model_calls`（本次调查的做法）。

目标：在 Admin Panel 按 Chat 展示整理进度，至少包括水位与对应日期、待整理条数、最新记忆日期、最近成功/失败时间、退避到期时间、最近的失败原因与成功率。具体设计待定。

### 建议顺序

1. **A0**（直接提升现有积压的吞吐；放宽重叠已定，改动集中在 `consolidate.ts`）；
2. **A3**（防止新增同类 backlog，先定重新启用的语义与配置/状态字段）；
3. **A2**（拆分 live/backfill，直接修复「新记忆不出现」）；
4. **A1**（并行吞吐，和 A2 一起设计调度器更自然；单独做也能缓解跨 Chat 排队）；
5. **A4**（依赖 A0 的按 Chat 审计与 A2 的状态字段）。

## 7. 未验证与限制

- `model_calls` 只保留最近 30 天；11-02 之前的调用不可得。首次启用时间由迁移应用时间、首次调用时间和 `group_memories.min(created_at)` 共同推断，不是配置 revision 的直接证据。
- 原始模型输出未保存（`record_model_payloads=false`），失败原因来自 `model_calls.error_detail` 的解析错误文本，不是逐条重放。
- `model_calls` 的 `role='tool'` 包含辞典合并调用，tool 调用也没有 chat_id / day；成功率是所有 Chat 与辞典合并的混合口径，无法按 Chat 拆分。
- 忙碌跳过、全局 `zzz`、Telegram 未就绪等跳过条件没有排查（4.5）；群聊 B 11-04–11-10 约 8 天的停摆、11-06–11-08 群聊 A/B 同时停摆的原因仍未确认。没有配置 revision 历史可查。
- 3.4 的水位轨迹是由 `group_memories` 推出的下界，不是真实的水位历史。
- 群聊 B 的消息量口径（142,303 总数、每日约 1.9k）未核对，见 3.4。
- 没有调用 `search_group_memory` / `read_group_messages` 做端到端回忆验证；影响判断基于 `group_memories.max(day)` 与水位。
- 没有重放、没有额外模型调用；止血只改了 chat 1 的 group memory 开关。
- `group-memory list` 返回的是分页结果，不是该 Chat 的全量记忆数；全量数字来自 SQLite 聚合。

## 8. 复现命令

```bash
surowan-utils doctor --json
surowan-utils chat list --json
surowan-utils group-memory list --chat=[chat-b-id] --json
surowan-utils chat group-memory --set-json enabled=false --json -- [chat-b-id]
```

```sql
-- 水位与待整理
SELECT m.chat_id, s.consolidated_through_message_id, count(*) pending
FROM messages m JOIN group_memory_state s ON s.chat_id = m.chat_id
WHERE m.visible = 1 AND m.telegram_message_id > s.consolidated_through_message_id
GROUP BY m.chat_id, s.consolidated_through_message_id;

-- 记忆覆盖范围
SELECT chat_id, count(*), min(day), max(day), max(created_at)
FROM group_memories GROUP BY chat_id;

-- Tool model 失败分布（role='tool' 含辞典合并；群聊记忆的失败行 error_code 以 group_memory_ 开头，成功行无法区分）
SELECT state, error_code, count(*) FROM model_calls WHERE role = 'tool' GROUP BY state, error_code;
```

```bash
# 生产日志（只读）
ssh [prod-host] 'cd /opt/plastic-wan && docker compose logs --no-log-prefix --since 24h | grep group_memory'
```
