# 群聊记忆积压事故调查报告

- 调查时间：2026-11-12 16:00–17:00 CST（08:00–09:00Z）
- 方式：SSH 读取生产主机与 SQLite；`surowan-utils` Admin API（`doctor`、`chat list`、`group-memory list`；一次止血写入）
- 范围：生产 endpoint `[prod-admin-endpoint]`；主机 `[prod-host]`，`/opt/plastic-wan`；Docker Compose
- 约束：除关闭「群聊 B」群聊记忆外，未修改代码、配置或其它生产状态；未重放、未导出对话正文；报告只含聚合统计与脱敏字段

## 1. 结论摘要

1. **这不是进程故障**。容器正常、Telegram 入库正常、sleeping worker 在运行；`group_memory_state` 为 `idle`，没有卡死的 `running` 认领。
2. **群聊 A（chat 2）的群聊记忆仍在生成，但只生成到 2026-10-10**。`group_memories` 的 `max(day)` 是 10-10，最新一行写于 11-12 07:43Z；水位停在 message_id 34313，之后还有 20,889 条待整理。模型通过 `search_group_memory` 只能看到 10-10 及更早的摘要。
3. **直接原因是「全量历史回填 + tool model 低成功率 + 30 分钟退避」三件事叠加**，不是单一代码崩溃：
   - 群聊记忆迁移 048 于 11-02 04:52Z 应用，首次 tool model 调用在 04:54Z；水位默认 0，worker 从各 Chat 最早一条已存消息开始回填。群聊 A 最早消息是 2026-08-26，共 34,092 条；群聊 B 最早消息是 2026-07-29，共 142,303 条。
   - `tool_model = deepseek/deepseek-flash`、`thinking_level = off`；11-02 至 11-12 共 1,235 次调用，**912 次失败（73.8%）**，其中 907 次是 `group_memory_invalid_output`（范围重叠、坏 JSON、summary 超长等），不是网络或额度。
   - 每次失败退避 30 分钟；成功一次只推进 120 条消息。群聊 A 近三天水位增量约 1.5k–3.4k/天，20,889 条 backlog 按当前速率还要约 1–2 周。
4. **群聊 B（chat 1）更严重**：watermark 停在 09-16，待整理 135,824 条，按当前吞吐和每日约 1.9k 新消息永远追不上。已按操作员指令关闭其群聊记忆作为止血；群聊 A 保持不变。

## 2. 现象与影响

- 操作员观察：群聊 A 很久没有新的群聊记忆。
- 实际数据：
  - chat 2「群聊 A」`group_memory_state.consolidated_through_message_id = 34313`（2026-10-10 16:04 CST），`messages` 最新 id 55955（11-12 16:17 CST），待整理 20,889 条。
  - `group_memories` 对 chat 2 的 `max(day) = 2026-10-10`；最新 `created_at = 2026-11-12T07:43:06Z`，说明 worker 还在写，但写的是旧日期。
  - chat 1「群聊 B」watermark 133481（09-16），待整理 135,824 条，`max(day) = 2026-09-16`。
- 影响：
  - 近期事件无法被 `search_group_memory` 检索；`read_group_messages` 仍可读原文，但模型不知道近期 message-id 区间，实际不可发现。
  - worker 的模型调用与 30 分钟退避被旧 backlog 占用；群聊 B 这类大群会长期占用整理名额（本次已关闭）。
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

- 11-02 首批 3 次调用走 OpenRouter `deepseek/deepseek-v4-flash-0731`，3/3 成功；随后配置切到 `deepseek/deepseek-flash`，失败率显著上升。样本很小，只能作为线索，不能单独证明模型优劣。
- 11-05 至 11-08 成功率只有 9%–15%，与群聊 A 水位 11-06–11-08 没有推进吻合。

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

- chat 2 近三天增量 `+3,391 / +2,122 / +1,543`；按三天均值 2,352/天，20,889 条约 9 天；扣除每日约 500–800 条新消息，约 1–2 周。
- chat 1 在 11-04–11-10 的 7 个完整日期没有新增记忆/水位不动（11-03 成功后直到 11-11 才恢复，间隔约 8 天）；本次未能确认是配置暂停、`/pause` 还是连续输出失败导致（配置 revision 历史未保留）。11-11 写入的记忆覆盖了 130,878 → 133,063 的 2,185 条，但这是间隔后的恢复，不能当作稳定日吞吐；每日新消息约 1,900 条，135k backlog 仍无法在现有吞吐下追平。

## 4. Root cause

### 4.1 首次启用从水位 0 开始，回填全部已存历史

迁移 `048_group_memory.sql` 于 `2026-11-02T04:52:03Z` 应用；`group_memories` 最早 `created_at` 为 11-02，首次 tool model 调用为 11-02T04:54:07Z。`group_memory_state.consolidated_through_message_id` 的默认值是 0，`#batchFor` 取 `loadPendingMessages` 的第一条（`ORDER BY telegram_message_id`），因此 worker 会从各 Chat 最早一条已存消息开始整理。群聊 A 最早消息是 2026-08-26，群聊 B 最早消息是 2026-07-29（首条记忆日期 08-03）；这直接产生了 2–3 个月的历史回填队列。

这不是「突然坏了」，而是功能上线时的初始水位语义：**启用即回填**。对已有大量历史的群，第一次启用天然会产生数万条 backlog。

### 4.2 Tool model 对严格 JSON 的输出成功率只有 26%

群聊记忆要求模型输出一个 JSON 对象，事件范围必须引用批次内真实 message id、不得重叠、不得倒退，summary 1–150 字；任一事件不合法会导致**整批**被拒。`deepseek/deepseek-flash`、`thinking_level=off` 在这项任务上失败率 73.8%，主要失败是范围重叠（54%）和坏 JSON（23%）。这不是网络故障：Provider 500/503 只有 5 次。

`parseConsolidatedEvents` 的严格校验是刻意的（宁可整批重试，也不写入错误引用），但当前没有针对「模型格式错误」的修复/降级路径：不截断超长 summary、不合并重叠范围、不拆分批次，直接整批失败。

### 4.3 失败退避 30 分钟 + 每批 120 条，吞吐被锁死

- `GROUP_MEMORY_BATCH_MAX_MESSAGES = 120`，一次成功只推进 120 条。
- `GROUP_MEMORY_RETRY_DELAY_MS = 30 * 60 * 1000`，任何失败（包括模型输出格式错误）都退避 30 分钟；`GROUP_MEMORY_TICK_MS = 60s`，`MAX_CONSOLIDATIONS_PER_TICK = 3`。
- 26% 成功率下，期望约 2.85 次失败才成功一次，约 85 分钟推进 120 条；单 Chat 约 2,000 条/天。群聊 A 每天新增约 500–800 条，净追平速度约 1,200–1,500 条/天；群聊 B 每天新增约 1,900 条，净追平约 100 条/天甚至为负。
- 失败后 30 分钟退避对 Provider 故障合理，但对「同一批次模型格式错误」过于保守：同一批次重试往往仍会失败，退避只会把 backlog 拖长。

### 4.4 串行处理、最旧优先：新消息被 backlog 饿死

`SleepingService.tick` 按配置顺序遍历候选 Chat，**逐个 `await`** 整理；`MAX_CONSOLIDATIONS_PER_TICK=3` 是总调用次数上限（失败也计数），不是并发度。`#batchFor` 永远取最旧 pending day，导致：

- 新消息必须等旧 backlog 全部处理完才可能被整理；
- 一个 Chat 的慢调用/失败退避会占用 tick 的调用名额，其他 Chat 只能排队；
- 大群（群聊 B）和小群共享同一个串行循环，没有按 Chat 的公平调度。

这就是「群聊 A 的新记忆一直不出现」的直接调度原因：它不是没有新消息，而是新消息排在 10-10 之后。

### 4.5 可观测性缺口

`group_memory_failed` 日志与 `group_memory_state.error_code` 只记录通用的 `group_memory_unavailable`；具体是「范围重叠」「坏 JSON」还是「summary 超长」只在 `model_calls.error_detail` 里。第一眼容易误判成模型不可用/Provider 故障。建议在失败日志/面板中带上 validation reason（脱敏后）。

### 4.6 已排除/未发现

- 容器崩溃、OOM、磁盘满：未发现；容器 Up、无 OOM、磁盘充足。
- Telegram 入库中断：未发现；两个群的最新消息都在 11-12。
- `/pause` 或 `chat_pause` 阻塞：`chat_pause` 为空；群聊 B 11-04–11-10 的 7 个完整日期（约 8 天间隔）停摆原因未确认（可能是配置关闭/连续失败），不影响本次主结论。
- 死锁/卡死 claim：`group_memory_state.state` 全为 `idle`，没有 `running` 残留。
- 数据丢失：原文、Revision、已有记忆都在；只是新摘要没有生成。

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
- 该操作可逆：把 `enabled` 设回 `true` 即可恢复；水位保持 133,481，关闭期间的新消息仍在 pending 中，恢复后会从 133,481 之后继续整理（不会丢失，但会形成新的 backlog）。

## 6. Action items

### A1. 多个群组并行整理

现状：`SleepingService.tick` 串行 `for` + `await`；`MAX_CONSOLIDATIONS_PER_TICK=3` 是总量上限；同一 Chat 由 `group_memory_state.state='running'` 保证单飞。

目标：

- 用有界并发（如 4–8 个 in-flight）同时处理多个 Chat 的独立批次；每个 Chat 仍保持单飞（`claim` 已提供原子性）。
- 全局 in-flight/每 tick 调用预算保留，避免打爆 Provider 限流；失败/超时的 Chat 不影响其他 Chat 的 tick。
- 公平调度：按 backlog 大小/最近成功时间/退避状态分配名额，避免一个大群或一个坏批次长期垄断。
- 验收：两个有 backlog 的 Chat 在同一 tick 都能推进；一个 Chat 卡住/失败时另一个仍完成；没有重复 claim、重复 commit 或跨 Chat 串数据；SQLite 写入仍走短事务。
- 注意：并行化只解决跨 Chat 排队，不改变单 Chat 的 30 分钟退避与 120 条/批；A1 需要和 A2/A3 一起评估收益。

### A2. 旧数据与新数据分头处理

现状：单一 `consolidated_through_message_id` + 永远取最旧 pending day，新消息只能排在 backlog 后面。

目标：

- 引入「live lane」与「backfill lane」：
  - live lane 处理当前/最近日期（仍遵守 `idle_minutes`），保证新消息在当天/次日进入记忆；
  - backfill lane 处理已结束的旧日期，独立推进。
- 状态层需要至少两个游标（或一个 backfill 游标 + live 游标），并明确二者与 `group_memories` 区间的关系：不得重复、不得漏段；`search_group_memory` 与 `read_group_messages` 同时看到两条 lane 的结果。
- 迁移 `group_memory_state` 与相关查询；考虑旧数据升级时的默认值（例如 backfill 游标 = 当前水位，live 游标 = 当前水位）。
- 验收：在 20k backlog 存在时，当天的消息仍能在 idle 窗口后生成摘要；backfill 继续；两条 lane 的记忆区间不重叠、不丢失；重启后游标可恢复。
- 这是本次「群聊 A 新记忆不出现」最直接的产品修复。

### A3. 设置日期边界，避免启用时全量回灌

现状：水位默认 0；启用群聊记忆会把全部已存历史当作待处理。

目标：

- 为每个 Chat 增加显式的处理日期边界（start cutoff）：启用/恢复群聊记忆时，只允许处理边界之后的聊天记录；边界之前的历史默认不进入模型队列。
- 默认边界建议为「启用时刻」（或启用当天的本地日界）；允许管理员显式指定更早日期来回填，但必须是一次明确操作，不是默认行为。
- 边界可以存配置（`group_memory.since` 之类）或初始化水位；无论存哪里，都要在 Admin/CLI 可见、可审计，并在重新启用时保留已有水位，不能无意重置。
- 边界方向：如果目标是避免启用时回灌历史，应只处理边界之后的记录（start cutoff）；若只处理边界之前，仍会把边界前的历史全部入队，达不到止血目的。实现前先确认语义，不要在代码里把方向写反。
- 验收：在一个有 3 个月历史、10 万+ 消息的 Chat 上启用，不会把历史全部入队；新消息从下一个 tick 开始处理；显式回填仍可用；关闭再启用不会重新回灌。

### 建议顺序

1. **A3**（防止新增同类 backlog，改动面最小，先定语义与配置/状态字段）；
2. **A2**（拆分 live/backfill，直接修复「新记忆不出现」）；
3. **A1**（并行吞吐，和 A2 一起设计调度器更自然；单独做也能缓解跨 Chat 排队）。

## 7. 未验证与限制

- `model_calls` 只保留最近 30 天；11-02 之前的调用不可得。首次启用时间由迁移应用时间、首次调用时间和 `group_memories.min(created_at)` 共同推断，不是配置 revision 的直接证据。
- 原始模型输出未保存（`record_model_payloads=false`），失败原因来自 `model_calls.error_detail` 的解析错误文本，不是逐条重放。
- 群聊 B 11-04–11-10 的 7 个完整日期（约 8 天间隔）停摆原因未确认；可能是配置关闭、`/pause`、连续失败或其他调度因素。没有配置 revision 历史可查。
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

-- Tool model 失败分布
SELECT state, error_code, count(*) FROM model_calls WHERE role = 'tool' GROUP BY state, error_code;
```

```bash
# 生产日志（只读）
ssh [prod-host] 'cd /opt/plastic-wan && docker compose logs --no-log-prefix --since 24h | grep group_memory'
```
