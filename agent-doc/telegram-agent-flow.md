# Telegram 与 Agent 流程

## 接收边界

服务使用 grammY long polling，只订阅：

- `message`
- `edited_message`
- `my_chat_member`

群聊不要求 mention Bot。是否处理消息只由配置和代码决定，不由 Prompt 决定。

`TelegramIngestion` 对每个 Update 先写 `telegram_updates` 审计，再判定：

1. Chat 类型是否支持。
2. Chat ID 是否在 `telegram.chats`。
3. Forum Topic 是否在可选 `topic_ids`。
4. 消息的 `message.from.id` 是否命中当前 Chat 的 `ignored_user_ids`。
5. 消息是否来自 Bot/Service，以及 `process_bot_messages` 是否允许；允许的其他 Bot 消息只能随真人消息进入 Bucket，见配置文档。
6. 单独的人类 Sticker 是否允许按 `sticker_trigger_enabled` 创建 Bucket；该开关默认关闭。
7. Message/Edited Message 结构是否可归一化。
8. 配置了 `participation` 的 Chat 在活跃时段外是否被这类消息命中触发，见「定时活跃与注意力窗口」。

拒绝的 Update 不进入 Bucket，但保留稳定 `rejection_reason`，例如 `chat_not_allowed`、`topic_not_allowed`。唯一例外是管理员在未允许 Chat 发送的 `/allowlist`：它按已允许入库审计并直接作为命令处理（见 [Bot Commands](#bot-commands)）。允许 Chat 内被 `ignored_user_ids` 命中的用户消息仍保留 Update 审计，但在 Message 和 Bucket 边界之前直接丢弃；命令也被丢弃，只有实时新消息中的 `/ignoreme`、`/unignoreme` 放行，以便成员恢复接收。其文本、媒体及后续编辑不会进入实时或启动追赶 Context，其他成员回复该用户时也不保存对应 Reply 快照。该过滤只匹配 Telegram user，不匹配 `sender_chat`，且不追溯删除配置生效前已入库的历史。排查 allowlist 时同时比较配置哈希；删除 Chat 会热移除并停止其运行（不删数据），其它非热字段的修改仍需重启（新增与删除 Chat、已有 Chat 的 `instructions_file`、模型覆盖、`ignored_user_ids` 属于热更新白名单，见 [configuration.md](configuration.md#运行时配置热更新)）。

## Chat、Conversation 与 Topic

- Telegram Chat 归一化到 `chats`。
- Supergroup 迁移通过 `chat_migrations` 把旧 ID 指向 canonical Chat。迁移通知（`migrate_to_chat_id` / `migrate_from_chat_id`）在 allowlist 与 Topic 校验之前记录，因为新 Supergroup 的 ID 正是靠这条通知获得授权；只有旧 ID 本身被允许时才记录。
- Conversation 由 Chat 与真正的 Forum Topic 组成。仅当 Supergroup 的 `chat.is_forum = true` 且消息的 `is_topic_message = true` 时，才使用 `message_thread_id` 隔离 Conversation。
- 私聊、普通群消息及非 Forum Supergroup 的普通回复线程统一使用 thread ID `0`；Telegram 在普通回复中提供的 `message_thread_id` 不作为 Topic。
- 不同 Forum Topic 的 Bucket、Context、Reply 和预算相互隔离；启动追赶是显式的 Chat 级例外。

## Message Revision

`messages` 保存 Telegram Message 的稳定身份；每次首次接收或编辑产生一条 `message_revisions`：

- Text/Caption
- Sender user 或 sender_chat
- Reply 快照
- Forward origin
- Media group ID
- Service 片段
- 受限原始 JSON 片段
- 关联 Media

相同内容的重复 Update 不创建无意义 Revision。截止时间到达时，Scheduler 冻结当时最新 Revision；截止后的编辑只进入未来 Invocation 的 history。

Text/Caption 原样保存 Telegram 给出的纯文本，格式 entity 只留在 `raw_fragment_json`。Rich Message（`message.rich_message`，块结构、没有 `text`）是例外：`kind = 'rich_message'`，`text` 存 `richMessageMarkdown` 拍平后的 Markdown，块里的 Photo（只取最大尺寸）与受支持的图片 Document 按文档顺序写成关联 Media，其余媒体块（视频、音频、文件、地图等）只在 Markdown 里留 `[video]`、`[document: 名称]` 这类占位文字。回复 Rich Message 时 `reply_snapshot.content` 同样取这份 Markdown。

其余消息按承载内容的 Telegram 字段名记 `kind`：`video`、`animation`、`video_note`、`voice`、`audio`、非图片 `document`、`poll`、`dice`、`location`、`contact` 等（顺序见 `CONTENT_KEYS`）；没有正文时 `formatSnapshot` 渲染成 `[video]` 这样的空体标签，面板按同一字符串展示，只有真正未知的字段才退回 `unsupported`。Service 消息的 `kind` 保持 `service`（参与闸门、启动追赶与主动回复都按它排除），其中 `new_chat_members`、`left_chat_member` 与 `video_chat_participants_invited` 由 runtime 写一句 `added Bob to the group`、`joined the group`、`left the group`、`removed Bob from the group`、`invited Bob to a video chat` 存进 `text`，其余 service 事件仍渲染 `[service]`。只有「唯一新成员就是发送者」才写 `joined the group`，其余形状把所有新成员都列进 `added …`；本 Chat `ignored_user_ids` 里的成员不写进描述，事件只涉及被忽略成员时正文留空（渲染 `[service]`）。这句话由 runtime 写在发送者正文的位置，成员也能打出同样的字，所以 `formatSnapshot` 与群聊记忆的 `renderGroupTranscript` 都在头部方括号里加 `service` token 标明来源。Service 消息不触发 Bucket，只在下一个 Batch 的 Context 里可见。

## 启动追赶

普通重启在启动 Scheduler 和常规 long polling 前，以非阻塞 `getUpdates` 排空 Telegram pending updates：

1. Update 仍经过 allowlist、去重、Revision 与媒体持久化，但不创建常规实时 Bucket。识别到的控制命令只写 Update 审计，不进入消息与模型上下文；仅 `/pause`、`/resume` 按 Update 顺序交给同一 `BotCommandService` 执行，复用管理员与发送者身份校验，不补发旧命令回复。其余命令不重放管理副作用（包括 `/allowlist`），编辑与忽略用户等边界保持实时规则。排空后的最终暂停状态决定是否排队追赶。
2. `app_state.telegram_startup_catch_up` 保存本轮起点；进程在排空或建任务时崩溃，下一次启动从同一起点重新排空，已入库消息仍会进入追赶任务。去重发生在命令执行之前：已经提交的 Update 只保留审计，若崩溃落在入库提交与 `/pause`、`/resume` 执行之间，该命令在重启后不会补执行（实时链路同样如此）；不承诺 exactly-once 或崩溃不丢命令。
3. 每个有可触发消息的 Conversation（Chat + Forum Topic）只创建一个 `startup_catch_up` Bucket，取该 Conversation 最新的 `agent.history_messages` 条消息，参与闸门也按该 Conversation 判断；同一 Chat 的多个 Topic 各自排队，由 Scheduler 按 Chat 串行启动；单独的人类 Sticker 仍受 `sticker_trigger_enabled` 限制。
4. Bucket 仅包含该 Conversation 按 Telegram 时间排序的最新 `agent.history_messages` 条本轮消息，不混合不同 Forum Topic。
5. Snapshot 携带 `message_thread_id`。回复可见消息时，`send` 路由到该消息所属 Topic；不带 Reply 时仍发送到本 Conversation 的 Topic。
6. 排空完成并原子清除启动状态后，才切换到常规按 Conversation 收集。启动状态未清时实例不进入 long polling：冷排空中途失败（如网络错误）按一次失败的连接尝试重试；被新 token 或停用请求取消时，下一次成功连接的实例（哪怕不是冷启动）也走这条冷路径从同一起点续跑，而不是限量的运行时补拉。运行时补拉（换 token、从停用/配置异常恢复）每个 Chat 只保留最新 100 条，分页时就地淘汰；`getUpdates` 带 `offset` 即确认上一页，所以已拉到的保留更新在中途失败或取消时也照样入库，取消只是不再创建追赶任务。
7. 追赶 Invocation 建任务后，recovery 年龄从排空完成时刻起算（消息选取仍按本轮持久化起点），慢排空或崩溃续跑不会让它刚排队就被启动恢复判为过期；只有真正排队超过恢复上限（5 分钟）后才重启时，才按 `recovery_age` 过期。

## 会话节拍与 Bucket

Chat（群）空闲时，第一条可触发消息创建该 Conversation 的 `collecting` Bucket，并先等待一个完整节拍（之后的消息可按[自适应延长](#自适应延长)再推迟）：

```text
anchor   = max(first_received_at, 该 Conversation 上一轮结束时刻)
deadline = anchor + telegram.bucket_window_seconds
```

「上一轮结束」指 Agent 空下来的那一刻：该轮的 turn 没有 Tool Call、队列里也没有待注入批次。Agent 本来就空闲时，anchor 就是第一条消息自己。

`telegram.bucket_window_seconds` 是全局配置，接受 0–300 的整数秒；`0` 表示新消息可以立即触发，不表示持续轮询。**Agent 会话按 Chat 串行**，消息收集仍按 Conversation 隔离：

1. 不同 Forum Topic 的消息各自进入自己的 `collecting` Bucket；Context 与 Reply 只包含本 Topic 内容，互不混入。
2. 同一 Chat 同时最多一个 queued/running Invocation；运行期间任何 Topic 的新消息只进入自己的 Bucket，不修改当前 Invocation。
3. 每个 Bucket 的 deadline 是 **`max(第一条消息时刻, 该 Conversation 上一轮结束时刻) + bucket_window_seconds`**，按 Conversation 计算。Agent 空闲时它退化成 `first_received_at + bucket_window_seconds`；若第一条消息到达时上一轮还在跑，这批的窗口从该轮结束才开始，因此至少收集满一个窗口。deadline 与 Invocation 的 `started_at`/`finished_at`、queued/running 状态无关，也不会提前。
4. 没有新的可触发消息时不创建 Bucket，也不启动空会话。`sticker_trigger_enabled` 默认为 `false`：单独的人类 Sticker 不开 Bucket，但可以加入已有 collecting Bucket；设为 `true` 后可以单独触发。
5. 到达 deadline 后，Scheduler 冻结 `history` 与 `new` 快照并创建 Invocation；若该 **Conversation** 已有 running Invocation，则改为 attach，见「长活 Invocation 与热注入」。创建/attach 之前还有一道按群概率的主动回复闸门（见「主动回复概率调度」）：批次含 @、Reply Bot 或触发关键词时直接放行，否则抽样；未命中会关闭该 Bucket 而不创建 Invocation。
6. 每一轮结束时，该 Conversation 仍 `collecting` 的 Bucket 会把 deadline 推到至少 `本轮结束 + bucket_window_seconds`（只往后推，已有更晚的 deadline 不动）；Invocation 结束时，已到期的 collecting Bucket 立刻被处理，尚未到期的保持自己的窗口。deadline 从不被提前裁剪，已建立的批次也不会被打断。

因此，只要 Agent 每轮都很快结束，会话开始时间仍大致相隔 `bucket_window_seconds`；某一轮超过一个窗口时，该轮期间到达的消息统一从该轮结束起算，这批会比固定网格晚一些，与该群有多少活跃 Topic 无关。Bot 自己通过 `send` 产生的消息写入可见历史，但不会触发下一 Bucket。

deadline 不看「前一次运行是否仍在 queued/running」，但**运行中的批次不会在轮中途被交出去**：该轮还没结束时，该 Conversation 已到期的 collecting Bucket 只会留在 `collecting`（Scheduler 会把它的 deadline 至少推到 `now + bucket_window_seconds`，轮结束时再由运行时精确锚到轮结束），不会注入。若把「运行中」当成「立刻到期」，运行超过一个窗口后每条消息都会各自变成零长度 Bucket 并各自注入一批（实测：1.4 秒内 6 条消息 → 6 次注入），节拍就没有了。同理不把 deadline 吸附到 `前一次运行 started_at + bucket_window_seconds` 的网格点：那会让运行开始后一个窗口内到达的消息只收集几毫秒（实测 805 ms）就到期，表现为偶尔秒回。

代价是明确接受的：一轮很长（例如 40 秒）时，该轮期间到达的**所有**消息会被并成一批，在该轮结束后满一个窗口才注入——活跃对话因此可能多等一个窗口，换来的是「一轮期间的消息不会把上下文切成若干碎片批次」。唯一的例外是开启 `agent.send_barrier_enabled` 时的 [send 屏障](#send-屏障)：它只在该轮第一次真正发送之前、由 `send` 自己把这批提前取走。

配置了 `participation` 时，「可触发消息」还要先通过下一节的闸门。

### 自适应延长

`telegram.bucket_window_seconds` 是最短收集时间。`telegram.bucket_bump_seconds > 0` 时，collecting Bucket 每加入一条**能开 Bucket 的**消息（`eligibleHuman`：真人、非单独 Sticker，除非开了 `sticker_trigger_enabled`），deadline 改写为：

```text
deadline = max(deadline, min(first_received_at + bucket_max_seconds, 到达时刻 + bucket_bump_seconds))
```

- **只往后推**：现有 deadline（窗口，或上面轮结束推迟后的值）比候选更晚时不动。所以 `bucket_max_seconds` 只截断「消息带来的延长」，不会把轮结束锚点拉回来；一轮比 max 还长时，这批在该轮结束后满一个 window 结算，期间的消息不再延长它。
- **上限从 `first_received_at` 起算**：持续不断的消息流也在 `first + max` 结算，之后的消息开下一个 Bucket，不存在无限延长。
- **其他 Bot、服务消息与单独 Sticker 只加入、不延长**，与它们不能开 Bucket 同理：两个 Bot 不能互相把批次撑开。
- **竞争**：延长写在入库事务里（`bumpDeadline`，`src/ingress/telegram-ingestion/buckets.ts`），结算（collecting → queued）也是事务，二者经同一 SQLite 写者串行。消息要么在结算前加入并延长当前 Bucket，要么在结算后开下一个，不丢失也不重复；deadline 已过而 Scheduler 尚未处理时到达的消息照常加入并按公式延长。
- **定时器**：不新增定时器。serve 每次入库后 `wake()`，Scheduler 循环按最早的 `buckets.deadline_at` 重排唯一的 `setTimeout`；即使没有 wake，旧定时器到点只会发现没有到期 Bucket 并重算下一次延迟。
- `bucket_bump_seconds = 0`（缺省）时不发生写入，`bucket_max_seconds` 缺省等于 window：与固定窗口完全一致。

窗口与上限的取值统一由 `resolveBucketTiming`（`src/platform/config/resolve.ts`）给出；Playground 房间三项都是 0。轮结束、Scheduler 中途推迟与运行结束时的 deadline 推迟都只用 window，不用 max。

## 长活 Invocation 与热注入

`typing` 是 `execute` 注册表中的可选能力（`execute.call`，`tool: "typing"`，`input: {}`）。模型只有在决定接话且接下来需要耗时处理时才调用；快速回复直接 `send`，静默不调用。runtime 每 4 秒刷新，Telegram 适配器按 Chat + Topic 节流且不重叠请求，单次平台请求最多等 3.5 秒。重复调用不重置本轮上限，55 秒后停止刷新并取消在途请求，为 Telegram 最多 5 秒的状态尾部留余量；`freeAgent` 与运行清理停止状态，空闲后下一轮可以再次调用。模型请求的 typing 在本轮 `send` 之后继续刷新（后续工作可能仍在进行）；入库时因 @ 自动显示的 typing 则在 Bot 向该 Chat + Topic 发布后结束，模型此时再调用 typing 会接管为新的一轮。typing 仅为临时状态，不发布 assistant 文本，不计入 send 配额，也不把 Telegram 状态请求失败传给模型。

被 @ 时 runtime 会自动显示 typing，不经过模型：`TelegramIngestion.ingest()` 在实时（非 catch-up）、非编辑、真人（`eligibleHuman`）消息以 `mention` 或 `text_mention` 指向本 Bot（文本、caption 与 Rich Message 内任意位置均算，判定与 participation 共用 `mentionsBot`）、且该消息已进入 Bucket（因此未暂停且通过 participation 闸门）时，在 `IngestResult.mention` 返回 Chat 与 Topic。`src/adapters/local-monolith/runtime/index.ts` 据此调用 `MentionTyping.start`（`src/capabilities/mention-typing.ts`），休眠期间不启动。它复用与模型 `typing` 相同的 `startTypingLoop`（4 秒刷新、55 秒上限）和同一个 `grammySendApi` 实例的节流，所以两者同时存在不会重复请求。每个 Chat + Topic 至多一个循环，重复 @ 不重置上限。循环在以下任一时刻停止：Agent 向该 Chat + Topic 成功发送文本、Sticker 或生成图片（发送失败不停止）；`freeAgent` 与运行清理；进程关闭；55 秒上限。仅回复 Bot 或命中关键词不触发。`telegram.mention_typing_enabled` 设为 `false` 可关闭；模型随后选择沉默时，状态会持续到本轮结束。

`agent.context.idle_grace_seconds` 大于 0 时，Invocation 变成一个运行窗口：它可以跨多个 Bucket，在运行期间接收新注入的消息。

```text
Bucket 到期
  ├─ 该 Conversation 有 running Invocation：attach（写 invocation_buckets + 冻结快照）→ steer 注入
  └─ 否则：创建新 Invocation（既有行为）
```

规则：

- **注入粒度是 Bucket，不是单条消息。** 运行期间到达的消息进入下一个 `collecting` Bucket（同一 Conversation 同时只有一个 collecting Bucket），窗口从该轮结束起算，等满一个窗口才成为一批。

一轮完整循环（`bucket_window_seconds = 15`、`idle_grace_seconds = 60`，假设 Agent 每轮耗时 2 秒）：

```text
T+0    消息 A 到达 → 创建 collecting Bucket 1，deadline = T+15
T+3    消息 B、C 到达 → 进入 Bucket 1（同一个 Bucket）
T+15   Bucket 1 到期 → 该 Conversation 无 running Invocation → 创建 Invocation I 注入，本轮开始
T+16   消息 D 到达（I 还在跑本轮）→ 创建 collecting Bucket 2；它还没等到 Agent 空下来
T+17   I 完成本轮 send → 本轮结束 → Bucket 2 的 deadline 推到 T+17+15 = T+32
T+32   Bucket 2 到期 → attach 到 I 并注入同一 invocation_id，本轮开始
T+34   本轮结束；消息 E 到达 → 新建 Bucket 3，deadline = T+34+15 = T+49 …循环
T+94   若期间再没有新 Bucket 到期，空闲等待耗尽，I 结束
```

要点：**窗口从 `max(第一条消息时刻, 上一轮结束时刻)` 起算**，所以每一批都至少收集满一个窗口；运行期间到达的消息统一归入一批，在该轮结束满一个窗口后注入——既不在一轮中途被切开，也不会在轮结束的瞬间就注入。空闲等待耗尽的时刻若还有未到期的 collecting Bucket，I 正常结束，那批到期时按「无 running Invocation」开新的 Invocation。
- attach 只发生在**同一个 Conversation**。同一 Chat 另一个 Forum Topic 到期的 Bucket 不会 attach，它属于另一个 Conversation Context，等该 Chat 空闲后开新的 Invocation。
- attach 时对该 Bucket 调用 `snapshotInvocation(..., includeHistory: false)`，按 `sequence_no` 续写到 `invocation_messages`，因此「冻结模型输入」的不变量不变：之后编辑已注入的消息不会改动已注入的批次。
- 一批注入即是一个 checkpoint（见「Context 生命周期」），注入方式是 `agent.steer()`；`steer` 的可见点是 turn 边界，长 Tool 批次期间到达的消息会延迟到该批次结束，并且**不等 grace**：待注入的批次会先被注入，再回答它。
- **空闲等待发生在每一轮结束时，不在每个 turn 上**：该 turn 没有 Tool Call、且队列里没有待注入批次时，才等待至多 `idle_grace_seconds`。回合内的工具步骤、以及刚注入一批还没回答的 turn 都不等待，否则一轮里的每一步都要白等一个 grace（回归：一轮内两次 `send` 曾各等满 3 秒）。
- 结束判定顺序：睡眠/暂停/每日预算触顶 → 结束；有已 attach 未注入的 Bucket → 注入后继续；一轮结束时先标记 Agent 空闲并把 collecting Bucket 的 deadline 推到至少 `本轮结束 + bucket_window_seconds`，再空闲等待至多 `idle_grace_seconds`，期间有 Bucket 到期 → 注入后继续；超过 `max_wall_clock_seconds` → 结束；其余结束。
- **`idle_grace_seconds = 0` 是关闭开关**：不空闲等待、到期 Bucket 不 attach，退回「一次 Bucket 一次 Invocation」，但 Conversation Context 依然持久，且运行期间到达的批次仍从本轮结束起算窗口（比从消息自身起算可能晚一个窗口）。这是唯一受支持的降级方式，代码里没有第二套模式或 mode 分支。
- 防失控靠 `agent.rate_limits`：`turns_per_injection` 限制每批注入后最多跑多少轮（注入即重置），`sends_per_window`/`window_seconds` 限制同一 Chat 滑动窗口内的 `send` 次数，`max_wall_clock_seconds` 限制单次运行总时长。per-Invocation 的 `max_turns`/`max_sends`/`timeout_seconds` 已删除。另有不可配置的重复失败熔断（`src/orchestration/repeated-tool-failure.ts`）：连续 3 个 turn 的 Tool Call 全部失败，且工具名、参数与错误文本都与上一 turn 完全相同时，以 `repeated_tool_failure` 结束（`completed`）；注入新批次时清零，重放用同一规则。原样重试一个已失败的调用只会得到同样的失败，没有它时这类循环会一直跑满 `turns_per_injection`。重复发送守卫（`agent.send_duplicate_guard_enabled`，默认开启，见 [send Tool](#send-tool)）在同一 Invocation 内累计被拒超过 3 次时以 `duplicate_send` 结束（`completed`），计数不随注入清零；同一条重复连发时通常先在第 3 次拒绝触发上面的重复失败熔断。静默成功策略（`send_empty_text_strategy: "silent_success"`）下，连续 3 次未真正发出任何消息的静默成功以 `silent_send` 结束（`completed`）：按 Tool 调用计数（一次全部 part 都缺文本的 `send_reply` 只算一次，有任何 part 真正发出的 `send_reply` 不计入），静默计数在真正发布一条消息时清零、注入新批次不清零，避免模型用空 `send` 换取成功结果绕过熔断。
- attach 但从未注入的 Bucket 在运行结束时重新排队成新 Invocation（`invocation_buckets.injected_at` 为 NULL），不会被丢弃。`injected_at` 在该批的 user 消息写进 canonical history（`message_end`）之后才写入，而不是 `steer` 排队时：`steer` 只是把消息放进 Agent 队列，这条消息落库失败导致运行失败时，这批仍按未注入重新排队。
- `/pause` 会中断处于空闲等待中的 Invocation。

## Context 生命周期

每个 Conversation 持有一份 **Conversation Context**：canonical history 是 `context_messages` 的 `[head_seq, next_seq)` 区间**且 `evicted_at IS NULL`**，按 `seq` 严格有序，跨 Invocation 与进程重启存活。运行中的 Pi Agent 从这份历史播种，写回也以它为准；`ConversationRuntime` 里的 Agent 实例只是 LRU 缓存（`agent.context.agent_cache_size`），驱逐后能从数据库重建等价 transcript。

保留窗口有两道守卫，都是为了「淘汰过的行不会以任何方式回到模型面前」：

- **淘汰本身就是权威，不只靠 `head_seq`。** 读取保留窗口一律附带 `evicted_at IS NULL`。因为运行中的 Invocation 持有一份运行开始时的 header 快照，`/cut_topic` 之后它的 `head_seq` 比数据库更旧；纯区间读会把切掉的历史读回来，甚至把这个更旧的值写回去。
- **播种只从 turn 边界开始。** 保留窗口首行不是 `user` 时（例如切点正好落在某一轮中途，被中断的运行还落了一条 `toolResult`），播种前先往前推到第一个 `user` 行；找不到就整段丢弃。两种情况都记 `context_realigned` 日志。这道守卫是必需的：`pi-ai` 只补缺失的 tool result，孤儿 `toolResult` 会原样发给 provider 并被拒绝，该 Conversation 会一直失败到有人再切一次。

写入规则：

- 只有 `user`、`assistant`、`toolResult` 三种 role 进入 canonical history，写入时机是 `message_end`；每条记录产出它的 `invocation_id`。
- 过滤：`stopReason` 为 `error`/`aborted` 的 assistant 消息不写入，内容全空的 assistant 消息不写入（Pi 的 provider 层会静默丢弃它们或在失败时 push 一条空 assistant）。
- 完整 `AgentMessage` JSON 入库（含 `toolCallId`、`toolName`、`arguments`、thinking signature），因此可原样回放；内联图片块不入库，历史图片靠 `img_` 引用按需 `read_image`。
- 编解码必须对 Provider 能产出的任何消息成对成立：`usage` 是原样抄写 Provider 的报告，因此宽松接受未知计数（OpenRouter 的 `reasoning`、Anthropic 的 `cacheWrite1h` 拆分）；`content` 块与消息信封是逐字段投影，仍严格校验。**一行解不开不只是坏行**：它的整段保留窗口都无法播种，该 Conversation 之后每次 Invocation 都会在第一次模型调用之前失败，直到有人手动清历史——因此解码器只在真正缺字段时报错，运行时的异常也必须落日志（见下）。
- `agent_messages` 表继续保存摊平的文本审计，供面板阅读；`context_messages` 才是可回放的 canonical history。

system prompt 拆分（文档中只在此处维护；`ContextBuilder.buildSystemPrompt` 产出稳定段，`renderInjection` 产出注入段）：

- **稳定段**由按固定顺序拼接的分区组成，分区正文是随版本发布的 Markdown 文件（`src/platform/prompts/`），启动时读取，不支持热编辑：`1-core-protocol.md`（Core Agent Protocol，含开场的 BCP 14 关键词声明、消息分区、可信边界、Tool 选择原则与副作用成功判定）、私聊/群聊模式一行、`2-product-knowledge.md`（产品意图索引）、`3-capabilities.md`（Memo Pad 与群聊记忆的用途与检索规则）、System Skill 索引、图片/Sticker 说明、`4-persona.md`（人格分区标题，仅在存在全局人格或 Chat 指令时出现）。人格排在整个运行时内容之后：`4-persona.md` 标题后接全局 `system_prompt`，再接 Chat `instructions_file`（Forum Topic 共用所在 Chat 的指令）；运行时内容不再出现在人格之后。Core Protocol 规定消息分区、Tool 选择原则与副作用成功判定；人格只负责身份和表达风格；稳定段不写「什么时候该参与」——是否发言由模型按当前批次判断；群聊的消息准入由运行期 participation 闸门决定（配置了才生效）。它对一个 Conversation Context 保持逐字节稳定，这样每次请求的前缀能被 provider prefix cache 命中。Sticker 目录（`sticker_id:emoji`）是**不可信数据**，因此随批次注入，不进入稳定段；它只在与保留 transcript 里最新一份不同时才重新附带（被 GC 淘汰后也会重新附带），不是每批都带一份。分区文件由运行时拥有，运营者只能通过全局人格和 Chat 指令定制人格；`AGENT_PROMPT_VERSION` 随分区语义推进。
- `composeAgentPrompt` 在 global/group 覆盖和模板渲染完成后，按最终内容决定是否加入运行时拥有的 `4-persona.md` 标题与说明；它不预先固定在 `promptLayers.prefix` 中。两层都渲染为空时省略整个人格分区。Replay 临时增加首个人格或清空唯一的 Chat 指令，与保存相同配置后构建的 system prompt 保持一致。
- 产品意图索引 `PRODUCT_KNOWLEDGE_INDEX` 读取自 `src/platform/prompts/2-product-knowledge.md`，属于稳定 prefix，由本地 Coding Agent 从用户手册离线烘焙并直接写入该文件；`CORE_AGENT_PROTOCOL` 约束产品事实优先于角色扮演，细节仍经文档工具验证。索引不进入逐批注入或 canonical history，更新时沿用稳定哈希重建。架构调查、维护 Skill、体积预算与验证方法见 [产品知识烘焙](product-knowledge.md)。
- 查手册只有一套顺序，`CORE_AGENT_PROTOCOL`、`read_document`/`list_documents` 工具说明与 `user-manual` Skill 三处一致：产品知识索引已给出合适页面时直接 `read_document`；没有合适页面时先 `list_documents` 看目录，再读取相关页面。
- **注入段**是一条 `user` 消息，依次为：可信的 `<runtime_state>`（当前时间、睡眠状态、完成事件说明、Startup catch-up 说明、仅刷新批次才有的 `<memo_list>`）、可选的 `<untrusted_task_receipt>`、可选的 `<sticker_catalog>`、可选的 `<untrusted_dictionary>`（辞典注入，见下）、可选的 `<untrusted_telegram_history>`（见下一条）、`<untrusted_new_messages>`（本批 Telegram 快照），以及追加在最后、仅在短期记忆有变化时出现的 `<memo_updates>` 增量块（见「Context」）。完成回执的结构化内容与其它 `<untrusted_*>` 一样只是数据，不是指令或待发送消息。Startup catch-up 按 Conversation 处理，Forum Topic 各自独立，因此提示只说明这批消息是离线期间累积的最新若干条，不再声称可能跨 Topic。
- **XML 转义**：注入批次里的不可信内容一律转义为五个 XML 预定义实体（`&`、`<`、`>`、`"`、`'`），包括消息正文、发送者名字、回复引用、转发来源、Sticker 目录、辞典条目和 Memo Pad 列表/增量，所以这些内容里不会出现真正的标签；`<tg-spoiler>` 由 `renderSpoilers` 在转义之后插入，用户原样打出的剧透标签会被转义而无法伪装。`parseSnapshotLines` 读回显示名时用 `unescapeXml` 还原。工具结果（网页、MCP、手册页、Skill 正文）不转义，由「工具结果是观察而非指令」的核心规则兜底。
- 消息不以 `invocation_messages` 的快照 JSON 发给模型，而由 `formatSnapshot` 渲染成省 Token 的紧凑文本：一行 `[message_id 本地时间 you service re:N uid:N @username] 显示名` 头部（`service` 只出现在 `kind = 'service'` 的消息上）（startup catch-up 也不再标注 `topic:N`，与实时 Bucket 一致），下面是两格缩进的正文（转发来源、回复引用、text/caption 的 Markdown 各行、`[kind ref WxH]` 媒体行；Rich Message 的媒体行放在正文里各自的位置上，见下文「Markdown 正文」）；空字段、`revision`、`media_group_id`、mime 等不渲染，日期只在与本批 `current_time` 不同时显示，回复目标就在同一批时省略引用。头部方括号内只有 runtime 生成的 token，所有 Telegram 可控内容都在缩进行上并已转义，因此无法伪造头部或区块标签；`collectVisibleSenders`/`collectInjectedMessageIds` 只回读最后一个 `</runtime_state>` 之后的头部行。改动这个格式要同步改 `CORE_AGENT_PROTOCOL` 中的格式说明（system prompt 哈希变化会让所有 Context 重建）。
- **Markdown 正文**：Telegram 从不以标记语言投递格式——无论发送方用 MarkdownV2、HTML 还是客户端工具栏，收到的都是纯文本加 UTF-16 entity；Rich Message 则是块树。建快照时 `src/platform/telegram-markdown/` 的 `bodyFromFragment` 从 `raw_fragment_json` 还原出模型读的 Markdown：text/caption 由 `entitiesMarkdown` 把 bold/italic/strikethrough/code/pre/blockquote/text_link/text_mention 写回普通 Markdown（`**`、`_`、`~~`、反引号与围栏、`> `、`[文字](url)`、`tg://user?id=N`），Telegram 自动识别的 mention/hashtag/url/command 等本来就是正文，不加标记，所以无格式消息的快照与改动前逐字节一致；Rich Message 由 `richMessageMarkdown` 再拍平一次，与 Revision 的 `text` 完全一致才采信。只在 fragment 的正文与 Revision 一致时才用这些格式，否则原样使用 Revision 正文，渲染失败从不让 Invocation 失败。快照的 `text`/`caption` 因此是 Markdown（Revision 仍是 Telegram 原文），Rich Message 另带 `media_slots`：每个已入库媒体在 Markdown 里的占位区间（`[photo]`、`[document: 名称]`），与媒体行一一对应，`formatSnapshot` 把媒体行（含多模态的 `figure_N`）放回占位处，顺序与直传附件一致；区间对不上（越界、乱序、多于媒体数）时整体忽略，占位留在正文、媒体行退回末尾。Markdown 标记同样要经过 XML 转义，所以引用前缀在模型输入里是 `&gt; `、链接里的 `&` 是 `&amp;`，与其他正文一致。
- **匹配原文**：格式化正文与可见纯文本不同的快照额外冻结 `match_text`，供辞典等 ContextInjector 做字面匹配；不在模型正文中额外展示。普通消息用原始 text/caption，Rich Message 用 `richMessagePlainText`。无差异时省略字段，无格式快照保持不变；旧快照没有该字段时仍用冻结 text/caption，不读取后续编辑后的 Revision。scene 的开场、冻结历史与 Revision 回退路径均保留这份信息。
- **Spoiler（剧透折叠）**：spoiler 区间随 Markdown 一起由 `bodyFromFragment` 还原，偏移指向快照里的 Markdown 正文；按 `text`/`caption`/`reply` 分组（`reply` 是回复引用 `reply_snapshot.content` 的区间：取 fragment 里 `reply_to_message` 的 entity，被回复的是 Rich Message 时取其拍平结果，只在引用仍是被回复正文的前缀时采信，并裁到截断后的长度；回复引用本身仍是纯文本），以 UTF-16 code unit 偏移原样使用——该单位与 JavaScript 字符串索引一致，所以不做码点换算。快照只在有 spoiler 时带上 `spoilers` 字段，`formatSnapshot` 渲染时由 `renderSpoilers` 先按 UTF-16 区间切分、逐段转义 XML 实体，再把每个区间包成 `<tg-spoiler>…</tg-spoiler>`（因此用户手打的剧透标签会被转义，只有 runtime 插入的标签是真的；replay 的 `scene/index.ts` 走同一套：冻结快照透传 `spoilers` 与 `media_slots`，无快照的 Revision 回退路径同样用 `bodyFromFragment` 还原；标签在媒体行处断开，不会包住媒体行）：消息正文与标签一起进模型，既不删除也不占位，落库更早的历史消息也会一并获得标记。重叠、越界或坏掉的 entity 会被裁剪、合并或忽略，标签始终成对。这是发送者主动折叠的社交语义而非机密边界，`CORE_AGENT_PROTOCOL` 里对应一条说明；新增这个标签后 `AGENT_PROMPT_VERSION` 升到 `9n`。
- **代码与链接中的折叠**：Rich Message 的 `pre`/`code` 按可见字符读取子节点，内部 bold、链接等不向代码写入 Markdown 标记或链接目标，spoiler 区间及其内部换行仍保留。普通 text/caption 的 spoiler 覆盖整条链接标签时，生成的 URL（含 `text_mention` 的 `tg://user` 目标）同样处于折叠区间；仅覆盖部分标签时不扩大到其余标签或目标。
- 历史不再被重新渲染成 `<untrusted_telegram_history>`；它由 transcript 本身承载。只有两种情况例外：该 Conversation Context 尚无历史（冷启动），以及历史区段里那些**从未进入 transcript 的消息**（例如被 participation 闸门拦下的消息）——它们仍然必须渲染，否则模型永远看不到。
- 随 Invocation 变化的内容（当前时间、Memo Pad 列表/增量、睡眠状态、完成回执）都必须待在注入段：放进 system prompt 会让每次请求的前缀都不同，既失去前缀缓存，又违反「Context 可以稳定保留」的前提。每个 receipt 只在自己的回执轮次注入一次：新 Invocation 通过 opening Bucket，附加到运行中的 Invocation 则在该回合的热注入中单独消费；后续批次不重新附带该 receipt，canonical history 已保存这次事件，其它 receipt 仍各自独立注入。
- system prompt 变化（`system_prompt_hash` 不同）意味着 Context 重建：丢弃全部 canonical history 重新开始。Prompt 与 Chat `instructions_file` 属于配置热更新白名单：改完文件并在 Admin「Apply config file」或 `/model` 应用之后，该 Conversation 下一次运行就按新哈希重建；运行时切换模型若改变了模板渲染结果或图片说明，同样会重建。清单见 [configuration.md](configuration.md#运行时配置热更新)。
- **模型预算变化也会重建。** `conversation_contexts` 记录构建时的 `context_window` 与 `max_output_tokens`；下一次运行取到当前模型快照后，如果这两个值变了，且保留 transcript 的估算 Token 超过按新窗口、`max_tokens`、稳定 prompt 与 10% Tool 预留算出的输入预算，就丢弃 canonical transcript 并从持久化聊天记录重新渲染（`context_rebuilt` 日志带 `reason = context_window`）。聊天记录、`/cut_topic` 切点与记忆都不动；预算只变大或 transcript 仍放得下时保留连续性，只更新记录值。
- **旧运行不能写回重建前的历史。** `conversation_contexts.generation` 在 system prompt 重建、预算重建、`/cut_topic` 与 `/rebuild_context` 时递增。每次 `append`、`advanceHead`、`clear` 都在事务内核对 header 的 generation，过期写入直接抛 `StaleContextError`；`touch` 这类收尾写入静默跳过。这样即使 abort 信号尚未落地，被中断的 Invocation 也无法把旧 `message_end` 或旧 `head_seq` 写进新 Context。

垃圾回收（GC）是**只删不摘要**的 checkpoint 滑动窗口，挂点只有一个：`prepareNextTurnWithContext`（位于流式输出之后、Tool 批次闭合之后，是唯一安全的裁剪点）。

- checkpoint 是纯 metadata（`context_messages.is_checkpoint`），不是消息；每批注入的 `user` 消息打上该标志。`assistant`/`toolResult` 永远不是 checkpoint。
- 触发条件：保留区间的 `send` 数超过 `agent.context.retained_sends_max`，或估算输入 + `maxTokens` 达到 `contextWindow * hard_token_ratio`。
- 目标 checkpoint：从最新往回找第一个仍保留至少 `retained_sends_target` 次 `send` 的 checkpoint（`send` 少而 Tool 多的历史退回 token 判据），一次跨过多个 `send`，形成 sliding window。有 token 压力时，按 `send` 数选出的候选还必须让保留段落到 token 软预算（`contextWindow × hard_token_ratio × 0.8`）以内，否则改用 token 判据，哪怕保留的 `send` 少于目标。
- GC 之后按保留行与当前 Tool 注册表重新估算输入 Token，再判断是否进入 `context_stop_ratio` 收尾；否则估算仍停在 GC 之前的高水位，刚被 GC 缓解的运行会直接进入收尾。
- 安全校验：目标必须是 checkpoint 的 `user` 消息、必须前进、保留段头部不能是 `toolResult`、保留段内每个 `toolResult` 都要有对应的 assistant toolCall。任一不过就放弃本次 GC，等下一个 turn 边界（最高优先级守卫：provider 不会修孤儿 `toolResult`）。
- GC 后必须同步四处：`head_seq` 前移（旧行软标记 `evicted_at`）、loop context 的 `messages`、`Agent.state.messages`、被淘汰消息携带的 `context_refs`。缺任何一处都会让三份历史分叉。
- 一份 Context 在运行期只允许一个 `ContextHeader` 对象。`ConversationContextStore` 会就地推进传入的 header，而写入方（`#persistMessage`、`#maybeCollect`）走 `entry.header`、注入与引用解析走 `open()` 的句柄，所以缓存命中时必须把新句柄赋给缓存条目。留成两个对象时后者永不推进：复用缓存的运行里，第一批之后的每一批都会把「本次运行开始时的 `next_seq`」写成自己 `img_`/reply 引用的 `source_seq`，于是这些引用会比应有的时间早一次 GC 失效；同时引用解析比对的 `head_seq` 也看不到运行中途的 GC。
- `context_gc` 日志的 `previous_head_seq` 是裁剪前的 head，`head_seq` 与 `target_seq` 是裁剪后的位置；只看后两者无法判断这次丢了多少。
- 一个 checkpoint 都没有（冷启动首轮）时不 GC，只能靠收尾模式处理。

## 引用（capability）生命周期

`img_`（媒体）、`stk_`（Sticker）、`reply:<宿主消息 ID>`（Reply 目标；Telegram 是 message ID，Playground 房间是房间序号）三类引用存在 `context_refs`，按 Conversation Context 隔离并带 `expires_at`（`agent.context.ref_ttl_hours`）：

- 同一媒体在 TTL 内复用同一个引用，历史文本因此不会每轮变化。
- `send` 的校验从「当前 Invocation 授权」放宽到「**当前 Conversation Context 授权且未过期**」；`read_image` 同理。
- 跨 Conversation 的引用永远不解析。引用被 GC 淘汰（其来源消息已不在保留段）后立即失效。
- `/cut_topic` 会同时清空该 Conversation Context，否则命令名义上切了历史、模型仍能从 transcript 看得见。

## 定时活跃与注意力窗口

配置了 `telegram.participation` 或 `chats[].participation` 的群聊不再无条件开 Bucket。先在活跃时段外处理有触发资格的新消息、更新注意力窗口，再判断 participation 闸门；allowlist、暂停状态和消息触发资格仍独立生效：

```text
participation 放行 = 未配置 participation || 处于活跃时段 || 更新后的注意力窗口未过期
```

- **活跃时段**（`active_windows`）按 Chat 时区解释，是半开区间 `[start, end)`；`end < start` 表示跨午夜并归属开始日，`end = "24:00"` 表示到当日结束。时段内行为与未配置时完全一致。
- **触发**只有三类：直接 @ Bot、Reply Bot 自己发过的消息（判定原始 Update 的 `reply_to_message.from.id`）、命中 `trigger_keywords`（`text` 与 `caption`，大小写不敏感）。Rich Message 没有 `text`：@ 判定读其中任意位置的 `mention`（比对 `username`，缺失时比对可见的 `@名字`）与 `text_mention`（比对 user id）；关键词只匹配 `richMessagePlainText` 收集的可见文字——格式片段原地拼接、不同字段各占一行，链接目标、文件名与 `[photo]` 这类拍平占位都不参与，避免误触发。三处判定（participation 闸门、主动回复的直接唤起、@ 自动 typing）共用这一实现。优先级是 mention → reply → keyword，只影响记录下来的 `trigger_kind`，不影响是否放行。
- 可见文字遍历只沿 blocks、items、cells、buttons 等结构字段进入子内容。按钮仅匹配标签，`copy_text.text` 等操作载荷不匹配；媒体 caption 的 text 与 credit 各占一行，因此 `hello` 加署名 `world` 不会命中短语 `hello world`，同一个 text 内的格式片段仍可拼成该短语。
- 仅在活跃时段外，有触发资格且命中的新消息才先写入或刷新 `conversation_attention`（`expires_at = receivedAt + attention_window_seconds`）再判定，因此命中消息自身会通过 participation 闸门。活跃时段内直接放行，不创建或刷新注意力窗口；实时入库与启动追赶复用这一判断。
- 窗口按 Conversation（Chat + Forum Topic）隔离；时段按 Chat 生效，时段内该群所有 Topic 都活跃。
- 只有能开 Bucket 的消息才能开窗口：`sticker_trigger_enabled = false` 时的单独 Sticker 既不开 Bucket 也不刷新窗口。
- 编辑消息不触发、不刷新窗口、不开 Bucket，但仍写入 Revision，并在后续 Invocation 中作为 history 出现。
- 闸门只阻止**创建** Bucket：已有 `collecting` Bucket 时，被抑制的消息仍按原逻辑追加进去。被拦下的消息照常写入 `messages`、`message_revisions` 与 `media`。
- 命中时打印 `agent_attention_triggered`（`chat_id`、`conversation_id`、`trigger_kind`、`telegram_message_id`、`expires_at`）；被抑制的消息不打印，避免静默期每条消息一行。
- 私聊永不受闸门影响；`/pause` 优先（暂停期间既不建 Bucket 也不记窗口）；任务 timer 仍可完成，但回执投递会在 pause/目的地无效时结算为 suppressed。
- 启动追赶同样过闸门：追赶 Bucket 只在处于时段内或窗口未过期时创建，否则记为 `skipped_budget`/`participation_gated`。追赶期间收到的命中消息同样会刷新窗口，因此停机期间被 @ 不会丢。

## 主动回复概率调度

`telegram.proactive_reply` / `chats[].proactive_reply` 开启后，普通群聊批次在**创建 Invocation 或 attach 之前**多一道抽样。判定顺序固定：

```text
Bucket 到期
  → allowlist / 暂停 / agent 配置 / 睡眠 / participation 闸门
  → 批次内是否有直接唤起（@、Reply Bot、trigger_keyword）
       ├─ 有：直接放行，不读写保底计数
       └─ 无：按该 Chat 的连续未命中数抽样
              ├─ 命中：重置计数，创建 Invocation 或 attach
              └─ 未命中：Bucket → skipped_budget / proactive_reply_skipped
```

- 抽样粒度是**一个完成聚合的 Bucket**，不是单条消息；批次里任意一条直接唤起消息都会让整批绕过抽样。
- 概率按 `hard_pity` 保证命中：`attempt >= hard_pity` 时为 1，否则 `min(1, base + (attempt - 1) * increment)`。`attempt` 从 1 开始。
- 状态按 Chat 存在 `proactive_reply_state`，Forum Topic 共享所在群计数；跨重启保持。参数集合变化（指纹不匹配）会在下一次抽样前清零。
- 计数更新与 Bucket 状态转换在同一个 SQLite 事务里；同一进程的 Scheduler 串行执行，抽样不会重复。
- 未命中的批次保留 `bucket_messages`，之后作为历史进入其他 Invocation；不是删除消息，也不是丢弃 Context。
- 私聊、Bot Command 与任务回执不经过这道闸门。直接唤起不增加、不重置保底计数。
- [send 屏障](#send-屏障) attach 的批次也不经过这道闸门：当前 Invocation 已经抽中（或被直接唤起），这批是正在进行的那次回复的延续，沿用这次机会，不抽样、不读写保底计数。到期 attach（idle grace）则仍要抽样：屏障每轮至多 attach 一批，而到期 attach 不受这个限制，不抽样的话一次命中就能把运行窗口无限延长。
- 日志：`agent_proactive_reply_bypassed`、`agent_proactive_reply_sampled`；字段包含 `bucket_id`、`probability`、`attempt`、`consecutive_misses_before/after`、`hit`、`hard_pity`、`state_reset`。

## Context

一次 Invocation 的模型输入由 `ContextBuilder` 的两半拼成：稳定的 `systemPrompt` 与一批注入消息，两者各含什么见 [Context 生命周期：system prompt 拆分](#context-生命周期)。`InvocationContext.userPrompt` 只保存最新一批注入文本，不再「每次重新渲染全部历史」——历史由 Conversation Context 的 transcript 承载。本节只记录拆分之外的组装产物与规则：

- `directImages`：当 `agent` 模型支持 image 时，**本批**消息里的 Photo/图片 Document（含 Rich Message 内的图片）经标准化后成为同一 User Message 的多模态内容，并按 `figure_N` 与消息媒体行中的引用对应。媒体行同时带稳定的 `img_` 引用（`[photo figure_1 img_xxx WxH]`）：codec 落盘时丢弃内联图片块，重启或缓存丢弃后 replay 的 transcript 只剩文本，模型要靠这个 `img_` 用 `read_image` 再看；`read_image` 不接受 `figure_N`。
- `visibleSenders`：本批及保留历史中可见的 Telegram user sender，供 Alarm 插件校验目标。
- `mediaRefs`：本次快照中**所有**可见媒体（Sticker、Photo、图片 Document，不分新消息/历史区段，也不看模型是否支持 image）的 `img_` 引用到 Media ID 的映射，供 `read_image` 解析。
- `omittedNewMessages`：因 Context 上限省略的新消息数量。

Memo Pad 是 **Chat 级**记忆：同一个 Chat 的所有 Forum Topic 共享，私聊与每个群各有一份。条目有 `summary` 与 Markdown `detail`；`expires_at` 为空的是长期条目，非空的是短期条目。**只有短期且未过期的条目会被自动注入，长期条目永不注入**，只能靠 `search_memory` 找到、`read_memory` 读详情。

注入分两种形态，由保留窗口决定（`src/context/memo-pad/injection.ts` 的 `renderMemoInjection`）：

- **完整列表 `<memo_list>`** 只在本批无法假定保留窗口里已有一份列表时渲染：Context 重建后的首批、`memo_refresh_pending` 为 1（配置移除 Chat 或重新加入后强制刷新）、尚无 `memo_refresh_seq`，或上次渲染列表的批次 `seq` 已被 GC（`memo_refresh_seq < header.headSeq`）。列表放在 `<runtime_state>` 内，内容按 `created_at, id` 升序，每行 `- <id>: <escaped summary>`。
- **其他批次只渲染尾部增量 `<memo_updates>`**，追加在 `</untrusted_new_messages>` 之后；行格式 `+`/`~`/`- <id>: <escaped summary>`，分别表示新增、summary 或 `updated_at` 变化、消失。与上次已告知状态（`memo_state_json`）比较后无变化就完全不渲染；没有内容时标签本身也不出现。

字符预算是 `floor(contextWindow × 0.1)`（PRD 按每字符 1 Token 折算），列表超限时从最早的条目开始隐藏，并在末尾给出 `[N earlier short-term memories are not shown; use search_memory to find them]`；增量优先保留最新变化，并有 `[N memory changes omitted]` 提示。截断时只推进实际输出的条目修订/删除，未输出的变化保留到后续批次，已告知部分不重复；单条过大也不能被标记为已告知或阻挡其它可容纳的变化。

`memo_refresh_seq` / `memo_state_json` 与对应批次的 user checkpoint 在同一个 SQLite 事务中提交：每个排队批次携带自己的待提交状态，后续批次不能覆盖或替代前一个批次，活 header 仅在事务成功后推进。渲染只计算，不写库，因此一个最终没有进入 canonical history 的批次不会宣称自己的变化已经告知。Context 重建会把这两个字段与 `memo_refresh_pending` 一起复位，下一次运行重新渲染完整列表。增量跨 Invocation 累积在历史里，直到所在行被 GC；Admin 在批次之间修改或删除条目，会在下一个批次以增量或完整列表的形式出现。

### 群聊记忆（sleeping）

群聊记忆是 Memo Pad 之外的另一类能力，按 Chat 的可选配置 `group_memory` 开启（见 [configuration.md](configuration.md#telegram-chat-与-topic)）。它只记录「群里发生过什么」，不保存模型主动写下的资料；两者互不替代。

- **开启边界**：Chat 的开关从关到开（含首次开启、配置新增已开启的 Chat）时，`SleepingService.reconcile` 为它建一条从「当时最新已存消息」之后开始的 live lane；开启前的历史与关闭期间的消息都不进入整理队列（原文仍可被 `read_group_messages` 读取，只是没有摘要）。开关关闭或 Chat 离开配置时删除它的全部 lane。配置发布（`onPublished`）时立即对齐一次，每次扫描开头再对齐一次，覆盖进程停机期间手改配置的情况。
- **两条 lane**：每个开启的 Chat 有 `group_memory_lanes` 里的 `live` lane（游标 `through_message_id`），追赶旧积压时另有一条 `backfill` lane（游标到 `until_message_id` 闭区间为止）。live lane 最旧的待整理消息早于 Chat 本地的「昨天」时，worker 把昨天之前的部分切给 backfill（`until` = 昨天零点前最后一条消息，live 从它之后继续），所以昨天和今天不必等积压清空；backfill 读到 `until` 时随提交删除。同一时刻每个 Chat 至多一条 backfill，它运行期间 live 再落后就按顺序追。两条 lane 各有认领与退避，backfill 失败不会挡住 live。
- **sleeping 触发**：`src/context/group-memory/sleeping.ts` 的 `SleepingService` 每分钟扫描一次，按 Chat 本地日期一次整理一天；本地日期已结束时无需等待，仍在进行的当天要等最新消息静默 `idle_minutes`。Chat 处于 `/pause`、全局处于 `zzz` 睡眠、Telegram 未就绪或 Chat 已离开配置时跳过；同 Chat 有 queued/running Invocation 或 collecting Bucket 只挡 live lane（正在生成的回复不能和它的输入摘要赛跑），backfill 只读昨天之前已结束的日期，不受影响。候选 lane 跨通道按最近尝试时间排序，并列时 live 优先，避免持续繁忙的 live 队列饿死 backfill，最多 `GROUP_MEMORY_MAX_IN_FLIGHT`（4）条并行；一次扫描最多开始 `GROUP_MEMORY_MAX_BATCHES_PER_TICK`（8）个批次，失败的批次同样计数，供应商故障时不会对每个 Chat 连发。每个批次在认领前、每次模型请求（含修复调用）前，都用当前配置与已流逝的时钟重新检查上述闸门；闸门关闭或认领失效时停止后续请求并立即释放认领。进程停机时 aborted 的批次立刻释放认领，下次启动重试；上个进程没关闭的运行记录在启动时标为 `interrupted`。
- **整理**：用系统级 `tool_model`（缺省继承全局 agent 模型）对一天的消息做 JSON 事件抽取。Prompt 要求摘要不超过 150 字符，校验与落库上限是 200（`GROUP_MEMORY_SUMMARY_MAX_LENGTH`），模型略超不会整批失败。每条事件必须带输入批次内真实存在的闭区间 message id、不得倒退；区间可以重叠、可以乱序（群聊话题交错，重叠区间仍只引用真实消息），落库前按起点排序。回复不合格时把具体原因（事件序号、id、长度，不含消息正文）作为下一轮 user 消息再请求一次；仍不合格，或供应商出错（不做修复重试），整批失败并按 30 分钟退避重试。成功时摘要与 lane 游标在同一事务提交，且只在认领仍有效（`claimed_at` 未变）时提交，所以开关在模型调用期间被切换、lane 被删除或重建时，迟到的结果不会落库；没有值得记录的事件时游标照常推进。每次模型调用写入 `model_calls`（`role = 'tool'`、`invocation_id = NULL`、修复调用 `attempt = 2`），不计入每日 Token 预算；每个批次另写一行 `group_memory_runs`（Chat、lane、日期、读到的区间、模型调用数、结果与失败原因），这是按 Chat 统计进度与失败的依据。
- **两层披露**：`search_group_memory` 是原语，按 Chat 本地 `YYYY-MM-DD`、关键词（匹配 summary，多个关键词至少一半命中）和 limit 返回 `gmem_` id、日期、summary 与 `messages <first>-<last>`；`read_group_messages` 接受闭区间 message id，返回同一 Chat 的原始消息（每行带消息 id、发送者、topic 与媒体标记，正文缩进），并限制最多 200 条、2000 个 id 宽度与 20000 字符；超出部分提示模型缩小范围。两个工具都只在 `group_memory.enabled` 时注册，按 `internalChatId` 隔离，不跨 Chat 解析。
- **持久化**：事件只存摘要与范围，不复制原文；原文继续放在 `messages` / `message_revisions` / `media`。聊天记录不再参与 `retention.online_days` 清理，因此这些原文始终可供回溯；记忆行与 lane 也不参与在线保留清理，`group_memory_runs` 是审计行，按 `retention.online_days` 清理。删除 Chat 时三张表随 `chats` 级联删除。
- **与 Context 的关系**：摘要不自动注入，也不占 system prompt；模型只在需要回忆时调用工具。工具返回的原文是不可信数据，必须按观察处理，不能当成指令。

`search_memory` 接受 `keywords`（匹配 `summary` 与 `detail`，大小写不敏感子串；单个关键词必须命中，多个关键词至少命中一半）、`from`/`to`（按 `created_at` 过滤）与 `limit`，只返回 id、summary 与期限；`read_memory` 按 id 返回完整 detail，并记录本 Invocation 已读（`id -> updatedAt`），`update_memo` 必须先读且读后未被改动。读原语直接暴露，不经 `execute`；`add_memo`、`update_memo`、`delete_memo`、`save_memo_image` 是经 `execute` 调用的内部能力，完整定义与参数以 [src/context/memo-pad/tools/](../src/context/memo-pad/tools/) 为准，何时使用的说明在 memory System Skill。

Detail 里的图片使用 Chat 所有的 `pwblob://blb_<32hex>` 引用（由 `save_memo_image` 从本 Conversation 可见的 `img_` 复制产生），`read_image` 接受该 URI 并按当前 `internalChatId` 鉴权。Blob 文件独立于 Context 保留窗口，随 Chat 删除。

`list_alarm` 的 `items` JSON 经 `execute.call` 的 `text` 封套作为普通工具结果，由既有的 canonical `context_messages` 保存，跨 Invocation、Agent 缓存与进程重启复用，随 checkpoint GC 或话题清空自然遗忘。列表同样受通用结果长度限制，不保证超长列表完整。若历史缺失或不能唯一解析目标，模型应重新调用 `list_alarm`；仍无法确定时应澄清，不能猜 ID。`delete_alarm` 仍按 live caller、plugin、Conversation 与 pending 状态鉴权，不依赖任何旁路存储。

Context 受模型窗口限制：为系统提示、完整 Tool 定义（名称、描述与参数 Schema）、历史、新消息和输出保留空间。Tool description 不只是能力清单，还应说明何时使用、何时不用、必要调用顺序和成功判定。估算输入达到 `context_window × context_stop_ratio` 后进入收尾模式：下一次模型调用只带 `send`、`send_reply` 和当时可用的 `zzz`，模型用这一轮把话说完，这一轮结束后运行以 `context_limit` 结束。Pi 1.x 在 turn 边界先调 `finishTurn`（`turn_end` 之前）再在下一段循环开头调 `prepareNextTurnWithContext`，因此 `contextClosing` 第一次被 `finishTurn` 看到时收尾轮已经跑完，运行随之停止——「进入收尾」和「停止」各占一个 turn 边界，收尾轮恰好一轮。

## Agent 循环

```text
Context（稳定 system prompt + 本批注入）
  → model turn
  → zero or more Tool Calls
  → Tool Results
  → next model turn
  → completed / failed / aborted / outcome_unknown
```

Invocation 结束时 Agent 实例可以留在 `ConversationRuntime` 缓存里供下一次复用；canonical history 才是唯一真相，缓存被驱逐或进程重启都不影响连续性。失败运行（`model_error`）和抛出异常的运行都会主动驱逐该 Conversation 的缓存，避免把半截 transcript 带进下一次：Pi 先把消息推进 `state.messages` 再调用监听器，落库失败时内存里的 transcript 已经和 `transcriptSeqs` 分叉。

运行时抛出的异常（播种 canonical history 失败等）由 Scheduler 记为 `state = failed`、`completion_reason = invocation_error`，异常消息与堆栈以 `agent_invocation_error` 日志落盘——`completion_reason` 是 outcome 词表而不是错误类名，只有日志里才有“为什么”。同一条异常会把该 Invocation 消费的 Bucket 一起置为 `failed`，不会留下悬空的运行中 Bucket。`invocation_error` 意味着代码或存储层出问题，`model_error` 才是 Provider 侧问题。

限制来自配置：全局每日 Token 预算、`agent.rate_limits`（`turns_per_injection`、`sends_per_window`/`window_seconds`）、`agent.context.max_wall_clock_seconds` 与全局并发（`tool_calls_used` 仅作审计统计，不再按次数终止）。除该全局 Token 预算外没有其它每日配额：Chat 不限每日 Invocation 数，MCP Tool 不限每日调用数。模型调用与 Tool Call 分别写入审计；`execute` 每次调用有自己的 `tool_calls` 行，dispatch 到的内部能力还会各自再写一行，因此一次 `execute.call` 在审计里是两条可关联记录（外层 `tool_call_id` 与内层 `<id>:<tool>`）。`add_memo`/`update_memo`/`delete_memo`/`save_memo_image` 是持久化副作用，按 Chat 隔离；`send` 仍是模型驱动的 Telegram 输出的唯一边界。

## Skills 与受控能力调用

工具面分三层：runtime 原语直接暴露、内部能力经 `execute`、MCP Tool 直接暴露。内部能力按需发现，避免每轮请求携带全部定义；这不是放宽授权，Schema、引用和预算仍由 Tool 边界校验。修改能力时先查 [组合根的 `capabilityTools`](../src/adapters/local-monolith/runtime/index.ts)（按符号名检索）与 [原语装配](../src/orchestration/agent-runtime/index.ts)，行为验证见 [验证索引](verification.md#静态与单元验证)。

- **原语**：`read`、`read_member_profile`、`send`、`send_reply`、`execute`、`search_memory`、`read_memory`、`zzz`（条件暴露）。它们的定义、Schema 与约束完全由 runtime 提供，不依赖任何 Skill；未读取任何 Skill 也能直接调用。记忆读原语之所以是原语，是因为查记忆是高频推理步骤，且它们不向 Context 注入 detail。`read_member_profile` 与 `send` 一样常驻注册表：宿主没有资料读取器时（Telegram 未连接）工具仍在，调用时以 `profile_unavailable` 拒绝，而不是在两次运行之间消失。
- **成员资料**：`read_member_profile` 只读当前 Invocation 所属 Conversation 的成员，参数是消息头里那个发送者 token（Telegram `uid:<id>`、房间 `member:member_<n>`，房间也接受裸 `member_<n>`）。授权就是这段历史本身：Telegram 侧先用 `messages`/`message_revisions`/`senders` 确认该 uid 在本 Conversation 说过话，再调 `getChatMember`（`standing` 与 `custom_title`，仅 Bot 是管理员时可得）、`getChat`（只有私聊才问，取 `bio`）与 `getUserProfilePhotos`（最新一张最大尺寸，下载后走工具图片通道）；任一调用失败只让对应字段为 `null`，不整体失败。房间侧只读 `room_participants` 的显示名、角色与加入时间，`username` 只在 Bot 自己那行有值，没有头像与简介。读器接口在 [platform/im-host/profiles.ts](../src/platform/im-host/profiles.ts)，两端实现分别在 [telegram/profiles.ts](../src/adapters/local-monolith/telegram/profiles.ts) 与 [playground/profiles.ts](../src/adapters/local-monolith/playground/profiles.ts)，按调用取当前连接（`ImHost.profiles` 是 getter，连接建立/断开不需要重建注册表）。
- **内部能力注册表**：由 [runtime-host.ts](../src/adapters/local-monolith/runtime/index.ts) 的 `capabilityTools` 装配，完整清单以此为准，不在文档维护副本。其中内置 Agent 插件（[plugins/builtin.ts](../src/plugins/builtin.ts)，当前为 `web-fetch`、`image`、`alarm` 与 `dictionary`）经 `loadPlugins` 校验 id 后按 Invocation 贡献能力；插件只拿到 `InvocationScope`（当前配置快照、活的 Invocation 上下文、deadline、绑定本 Invocation 的 `ToolAudit`、宿主 `orm`、自身 plugin/Conversation 的 task scope，以及宿主接线时才有的 `resolveMedia` 引用解析与 `image` 生图桥；字段以 [plugins/plugin.ts](../src/plugins/plugin.ts) 为准），不持有 Store 或 Runtime。插件能力与其他内部能力走同一条 `execute` 注册、校验、分发与审计路径。模型经 `execute` 的 search/help/call 按需发现与调用；调用前按目标能力的参数 Schema 校验，input 超 32 KiB 拒绝。插件还可以声明 `contextInjectors`（契约见 [context/context-injector.ts](../src/context/injector.ts)；按插件加载顺序、在消息选定后逐个渲染本批的 `<untrusted_…>` 注入块，签名去重状态由 AgentRuntime 按注入器名维护，审计写 `context_injected.injections`）；辞典是它的第一个使用者。
- **MCP Tool**：按配置 allowlist 直接暴露，不进入 `execute` 注册表。

MCP 结果与成员头像共用同一条工具图片通道：[capabilities/media/tool-image-store.ts](../src/capabilities/media/tool-image-store.ts) 的 `ingestToolImage` 负责嗅探、`normalizeImage` 规范化、按 Chat 存入 `PlaygroundAssetStore` 并返回不透明引用。MCP 结果在 [capabilities/mcp/content.ts](../src/capabilities/mcp/content.ts) 转换。全部是 `text` 块的结果保持旧契约：整体 `JSON.stringify` 后按 `result_max_bytes` 截断。含其它块时逐块转换：文本共享 `result_max_bytes` 预算；原生 `image` 先严格校验 base64、MIME/魔数与可解码性，再经现有 `normalizeImage` 规范化后存入当前 Chat 的本地图片资产（与 Playground 上传同一 `PlaygroundAssetStore`），结果里只留 `[image <asset_id>]` 标记与 `details.toolImages` 引用，canonical history、Pi transcript 缓存与审计都不持有 base64；文本 `resource` 与 `resource_link` 以 JSON 描述保留（不抓取链接），音频、blob 等其它块只留「已省略」说明；单张图片失败写入 `[MCP image unavailable: <reason>; ...]` 而不中断整条结果。`isError: true` 的结果以 Pi 的 `isError` 返回（不再抛错），并追加一行 `[MCP tool reported an error: isError=true]`，供没有原生错误标志的 Completions/Responses 识别。stdio 的 `ReadBuffer` 超限与 HTTP 响应体超限都记为 `payload_limit`，且不触发只读重试；结果已收到但转换失败记为 `mcp_result_processing_failed`，提示模型不要重复副作用。

图片字节只在请求前加载（[media/tool-images.ts](../src/capabilities/media/tool-images.ts) 的 `loadToolImages`，由 `run-hooks.ts` 的 `streamFunction` 调用）：每次请求按当前 Conversation 的 retained 工具结果（`seq >= head_seq` 且 `evicted_at IS NULL`）建一次 call ID → 引用表，只有 call ID、asset、位置与标记都对得上、资产属于当前 Chat 时才读文件；被 cut/GC 逐出的结果因此不能再加载。加载预先扣除请求里已有图片的字节与数量，共用 20 MiB 媒体字节预算并遵守模型声明的每请求/每消息图片上限（每消息额度按 Pi adapter 的实际分组计算），从最新结果往回分配。模型不支持图片、越权、超预算或缺文件时，在该位置写入说明文本并以 `harness_nudge` 记录一次，不自动换模型或调用辅助视觉。`openai-completions` 不能在 tool 消息里携带图片，`projectCompletionsToolImages` 把图片移到这组连续工具结果之后的一条 user 消息里，并逐张标注工具名与 call ID，canonical 工具身份不变。`estimateMessageTokens` 按每 32×32 像素块 1 token 给图片加一个保守估计。

`execute.call` 的结果是 `{text, refs}` 封套：内层 `text` 上限 30 KiB，序列化后的整体上限 32 KiB，超限截断带 `[content truncated]` 标记；`refs` 是本次调用产生的 Conversation Context 级引用 token（目前只有 `search_stickers` 的 `sticker_ref`，带 TTL），只能交给对应消费 Tool 在边界校验后使用。`execute` 拒绝原语（`execute_primitive_rejected`）与未知能力（`unknown_capability`），也不会递归调用自己。运行已被 abort 时 `execute.call` 不再 dispatch：内部能力不一定理会 signal（例如 `alarm`），所以在调用之前检查，外层 `tool_calls` 记为 `error`/`aborted`，不产生内层记录。

System Skills 是随 runtime 发布的只读文档包，位于 `src/system-resources/skills/<name>/SKILL.md`，或由内置插件以 Skill 目录声明（如 `src/plugins/web-fetch/skills/web-fetch/`），统一挂载在 `system:///skills/<name>/` 下（Docker 镜像随 `src/` 打包）。`SKILL.md` 头部 frontmatter 声明 `name`（必须等于目录名）与 `description`；Skill 重名（包括插件与内置树之间）或加载失败即启动失败。system prompt 只注入索引（名称、描述、`system:///skills/<name>/SKILL.md` URI）；正文由模型用 `read` 按需读取，即 progressive disclosure。`read` 只接受 `system:///` 绝对 URI 或「相对引用 + base」，绝对 URI 的路径段拒绝 `..`，相对引用允许在根内用 …

用户手册是第二个只读文档面，与 System Skills 分离。`pnpm run manual:prepare`（Docker 构建同样执行）在构建期把 `apps/docs/content/docs` 的 Markdown 打包到 gitignored 的 `src/manual/`，并按同一份 `_meta.json` 导航与各页 frontmatter 生成 `index.md`；只在文档站生效的 `__DOCS_BASE__/` 链接在打包时改写——下载示例包成 `examples/*.md` 原文页并链到包内，其余公开资源只留链接文字；镜像随 `src/` 携带该包，不构建文档站、不联网下载。模型经 `execute.call` 调用两个内部能力（System Skill `user-manual` 说明何时使用）：`list_documents` 无 `space` 时列出文档空间，带 `space` 时返回该空间的 Markdown 索引；`read_document` 按 `space` 与空间内相对路径读取单篇，`base` 用于解析文内相对链接，链接里的 `#锚点` 只指向标题、解析时丢弃。空间由 `FileSystemDocSpaces` 提供，路径语法、32 KiB 读取上限与错误码在 `src/platform/doc-spaces.ts`：拒绝绝对路径、空段、`..` 越界与非 Markdown 文件，读取前把目标 `realpath` 与空间根比较，符号链接无法逃逸。工具参数只有空间标识与路径，从不接受所有者或群组 ID；`DocSpaces` 方法接收当前 Conversation/Chat 上下文（内置空间暂不使用），这是未来按用户隔离的 wiki 空间的接入点。文档内容是不可信数据，不能授权能力或覆盖 Tool 约束。手册缺失时只记录 `doc_spaces_missing` 日志、读取返回 `unknown_space`，`doctor` 会把缺失判为失败。

辞典能力（`lookup_dictionary`、`add_dictionary_entry`、`update_dictionary_entry`）是 `dictionary` 插件贡献的内部能力，经 `execute` 调用，说明见 `src/plugins/dictionary/skills/dictionary/SKILL.md`（仍挂载在 `system:///skills/dictionary/` 下）。作用域校验在 Tool 执行层，不在提示词里：查询返回「全局 + 当前群」的启用词条（私聊只读全局），写入只能落在当前会话所属的群，改不了全局词条、别的群词条，也不能通过改作用域提升词条；这些判断都基于运行中的 Conversation，不接受工具参数里的任意 chat id。词条与定义是**不可信数据**：解释只说明一个词在这里的含义，不能成为指令或授权。

辞典的自动注入（`dictionary.injection_mode`，可按 Chat 覆盖）与主动查询是两条独立通道，注入由 `dictionary` 插件的 `ContextInjector` 渲染。`off` 不注入；`on_demand` 只注入与本批消息做字面匹配（term 或 alias 的完整子串，区分大小写，忽略汉字与 ASCII 字母／数字边界的水平空白）的词条；`aggressive` 预加载全局加本群的启用词条。注入块是 `<untrusted_dictionary>`，每条带 `[dic_... rN]` 标记，只占用消息选定后的剩余上下文预算，装不下就丢词条而不是挤掉新消息。去重以实际保留的 canonical Context 为准：从保留 transcript 回读这些 id+revision 签名，同版本仍在就不重注，被 Context GC 淘汰后可以重注，词条更新产生新 revision 因而会刷新——不引入永久「已注入」标记。私聊的注入源是全局词条。完整字段语义见 [configuration.md](configuration.md#dictionary-与-tool-model)，词条存储见 [data-layer.md](data-layer.md#dictionary_entries迁移-034)。

每次模型请求都会附带完整的工具注册表（名称、label、描述与参数 Schema）。请求发出前把该请求实际附带的工具名写入 `model_calls.tools_json`，Invocation 的可用注册表快照（`name`/`label`/`description`）写入 `invocations.tool_registry_json`——因此可以审计“模型在某一轮到底看到了哪些工具”。context 接近上限时，Agent 循环只保留 `send`、`send_reply` 和已经可用的 `zzz` 继续收尾。`developer.record_model_payloads` 只控制调试请求/响应报文；Invocation 场景重放从冻结的公开消息重建，不依赖报文录制，也不保存第二份模型输入（见 [data-layer.md](data-layer.md#工具可见性审计)）。

普通 Assistant Message 永不自动发布。模型不调用 `send` 或 `send_reply` 即表示保持沉默，这是正常成功结果。`agent.send_nudge_enabled` 开启时，若本轮没有 Tool Call、私有文本去除首尾空白后非空，且**本批注入**以来尚未调用 `send` 或 `send_reply`，harness 会在会话自然结束前至多注入一次 `steer` 提醒；提醒后仍不调用则静默放行，文本不出 Telegram。提醒的判定必须**早于**注入下一个批次与空闲等待：后两者都会延长这次运行，而草稿只有在自己那批仍是最新批次时才可挽回——排在它们后面会让整段运行期间每个「有草稿又被下一批接上」的批次都静默丢回复（只有真正静默满一个 grace 才会被提醒）。

## 睡眠

全局当日 `model_tokens` 剩余比例严格低于 5% 时，当前 Agent 才会看到 `zzz`；恰好 5% 不可见。全局用量是所有 Chat 的主 Agent 与聊天触发 `read_image` 用量之和，同时保留各 Chat 的归属统计；计量口径包含缓存读写（见 [configuration.md](configuration.md#agent-与-vision)）。运行中的会话越过阈值后，在下一次 model turn 边界更新工具注册表，不为此额外创建会话。

`zzz` 可见性与注入块里的睡眠状态说明由同一个判断渲染：只要 `zzz` 可见，本批注入的 `<runtime_state>` 就带一段自然语义的状态说明（现在很困、该睡就睡、静默结束也应该直接睡），而不是只让模型从 tool description 推断自己的状态。状态放在注入块而不是 system prompt，是因为 system prompt 必须对一个 Conversation Context 保持稳定。会话中途越过阈值时，工具注册表立即更新，状态说明在下一次注入时出现；如果该批注入之后 `zzz` 才可见，模型仍可从 tool description 推断。`zzz` 的 description 同样只用自然语义描述睡意，不暴露 token、budget、quota 等实现细节。

`zzz` 把全局 `bot_sleep_until` 写入 `app_state`，取 `max(调用时间 + 8 小时, 下一次 UTC 日预算重置)`。写入使用 SQLite IMMEDIATE transaction，重复或并发调用保持同一状态。调用后当前会话停止下一轮模型请求，后续实际 Tool Call 被阻止。

睡眠期间 Telegram Update、Message、Revision 与 Bucket 仍照常保存；Scheduler 将到期 Bucket 和尚未启动的 queued Invocation 标记为 `skipped_budget`/`sleeping`，不创建新 Agent。本该 attach 到运行中 Invocation 的到期 Bucket 同样跳过、不注入，空闲等待中的运行不会因此被唤醒再跑一轮；Chat 已移出配置时同理记为 `chat_removed`。首次在 `sleep_until` 之后检查状态时原子删除该键并恢复调度，因此状态可跨进程重启且不会因预算提前重置而提前唤醒。

管理员调大预算后可在 Admin Overview 手动解除睡眠；`POST /api/wake` 原子删除该键并唤醒 Scheduler，重复调用幂等。已因睡眠跳过的 Bucket 不会重放，后续到期 Bucket 与新消息恢复正常调度。

## Alarm / Deferred Invocation

`LongTaskService` 保存脱离创建 Invocation 继续存活的通用任务。插件只能取得绑定自身 plugin 与当前 Conversation 的 scope：创建时由可信插件冻结 payload 与 delivery policy；以后可用同一绑定 scope 的 completion handle `complete`/`fail`，不依赖创建 Invocation 或其 `AbortSignal`。没有通用后台 worker、executor、running/progress 或 retry。

1. 任务先处于 `waiting`。有 timer 的任务由唯一 Scheduler 到期完成；无 timer 的任务等待插件的外部 completion handle。完成、失败或取消在同一事务写入唯一 receipt，任务状态与投递状态分别是真相。`LongTaskService` 允许带一个宿主集合构造：带上集合的实例只把该集合内 Conversation 的到期 timer 视为到期（`processDue` / `nextDeadline` 同一条件），不带则照旧处理全部宿主——组合根按进程实际服务的宿主传入，单宿主进程因此不会替别的宿主触发定时任务。
2. Scheduler 先处理到期 timer，再按创建时间/ID 选择 pending receipt。目的地 allowlist、Topic 与 pause 仍在投递前检查；每次 claim 都创建一个独立的空 Bucket，不伪造 Telegram Update/Message/Revision。
   - 如果同一 Conversation 已有 running Invocation 且仍接受注入，receipt 的 Bucket 会 attach 到该 Invocation，不另开 Invocation；同一 Invocation 可以拥有多个 receipt。
   - 如果同 Chat 没有运行中的 Invocation，则创建 queued receipt Invocation，启动时优先于普通 Bucket，但仍受 Chat 串行与全局并发。
   - 如果同一 Conversation 的运行正在 closing，或同 Chat 另一 Topic 正在运行，receipt 保持 `pending`，等可接收时再 claim。
3. receipt 的 opening 或热注入都包含可信的“当前完成事件”说明及不可信结构化 receipt。运行中的注入在工具链结束后一次注入一条 receipt，和普通消息不混合为同一 round；若尚未开始回执轮，已 attach 的普通消息批次优先。receipt 不触发普通回复的 `send` barrier；已经开始的回执轮也不会被新消息拦下发送，普通批次等回执轮结束再注入。模型自行决定是否、如何回复；普通 assistant 文本仍不会发布，只有 `send` 能产生 Telegram 副作用。task 完成不等于模型已发言或 Telegram 已送达。
4. pending receipt 可在完成后被取消投递（任务结果不回退）；claimed 不可单独取消。未消费的 attached receipt 在运行失败或结束时重排给新 Invocation 并转移归属；已 claim 的进程恢复收为 handled/`outcome_unknown`，绝不重放。`/pause` 或 Admin cancel 会让尚未注入的 attached bucket 过期，避免之后复活。Admin「Cancel ongoing」只取消已排队或运行的会话工作，不取消尚未 claim 的 pending receipt；这些回执仍可在后续调度中投递。
5. delivery policy 默认走普通预算、也不自动 mention。可信代码创建时冻结 `bypassDailyBudget` 才可绕过 sleep 与每日 Token gate，且仍受目的地、pause、串行、并发、wall-clock、发送限流和失败处理约束；它不赋予其它豁免。`zzz` 与预算状态按当前回执轮动态恢复，caller 清空；mention/bypass 只对当前回执轮次有效，冻结 mention 只在该轮第一次成功文本发送时附加一次。

Alarm 是第一个 `plugin_id = "alarm"` 的 consumer，通过 `execute.call` 暴露 `alarm`、`list_alarm`、`delete_alarm`；它不直接发送 Telegram 文本：

1. `alarm` 要求 `target_user_id` 是当前 Invocation 可见的 Telegram **user** sender（sender_chat 与任意 ID 拒绝）、`summary` 为 1–500 字符、`datetime` 是带 `Z` 或显式 offset 的严格未来绝对时间且不超过 365 天；同一 Invocation 最多创建 3 个。
2. owner 是创建者而非 target。没有可靠 caller 时三个工具都 fail closed 为 `alarm_caller_not_available`；历史 `created_by_user_id IS NULL` 行不能被用户 list/delete，也不会把 target 回填为 owner。
3. Alarm 创建一个带 timer 的任务，冻结目标 mention 及预算豁免；到期结果是结构化 reminder 数据，不是预生成聊天文本。`list_alarm` 保留 waiting 或 completed+pending 的本人项目；`delete_alarm` 可取消 waiting Alarm 或尚未投递的 pending receipt。不存在、他人、已 claimed/已结算项目统一为 `alarm_not_found`。
4. Admin 继续以四态 Alarm 投影展示：waiting 或 completed+pending 为 pending、claimed 为 firing、handled 为 fired、取消任务或 suppressed 投递为 cancelled。completed+pending 仍可 list/cancel；claimed 不可单独取消。

## send Tool

`send` 是模型驱动的 Telegram 输出的唯一边界（[`send_reply`](#send_reply) 只是把一次回复拆成几次 `send` 依次发出），支持以下形式；确定性的 Bot 命令回复不经过模型，见 [Bot Commands](#bot-commands)：

- 文本默认按纯文本发送；显式设置 `parse_mode: "MarkdownV2"` 时由 Telegram 按 MarkdownV2 解析。没有 `sticker_ref`、`image_generation_id` 与 `image_ref` 时 `kind` 默认为 `text`。不属于所选 kind 的字段直接忽略（有的模型会给所有可选字段都填上占位值），只有三种情况拒绝：非图片带 `resend:true`，Sticker 带 `text`（会被悄悄丢掉），以及 `kind: "file"` 没有恰好一个来源。拒绝时错误码是 `send_input_invalid`，错误文本会写明要改哪个字段，模型不用盲目重试。
- 配置允许且当前 Conversation Context 授权的 Sticker（`stk_` 引用）。
- **以文件发送图片**（`kind: "file"`，Telegram `sendDocument`，多张为一组 document `sendMediaGroup`，说明挂在第一份）：不压缩地发送图片，Tool 描述规定只有用户明确要原图或要文件时才能用。runtime 无法判断「用户是否明确要求」，这条只约束模型，不做运行时拦截——完成回执轮里兑现用户早先「画完发原图」的请求同样合法。来源二选一：`image_generation_id` 发该 generation 的全部原始输出（授权同图片交付）；`image_ref` 取当前 Context 授权的 `img_` 引用——若它是 Bot 以照片交付的生成图（经 `media → message → host_sends(kind=image, success)` 按宿主消息 ID 反查），改发那次交付 `asset_ids` 对应的原图，generation 不属于本 Conversation 或原图已清理时以 `file_original_unavailable` 拒绝，不拿压缩版冒充；其他图片经 `MediaService.readOriginalFile` 原样下载（不走归一化），Sticker 以 `file_source_unsupported` 拒绝，读取失败为 `file_source_unavailable`。文件名补齐真实类型的扩展名（生成输出名本身不带）。读取（可能下载）发生在 abort/deadline、重复守卫、Reply 去重、send 屏障与 claim 之前，所以这些检查都在等待之后执行；`send_reply` 预检只校验来源授权，读取留到该条发送时。台账 `host_sends.kind = 'file'`（迁移 `049`），`request_json` 记 `image_ref`、`generation_id`/`asset_ids` 与 `files` 数；因为 kind 不是 `image`，它既不算图片交付、也不被图片交付去重拦截。Bot 消息 revision 记为 `kind = 'file'` 与说明，不写 `media` 行。重复发送守卫按逐字比对覆盖它（无内容键，不参与「重复上一条」与烧毁）。Playground host 以 `unsupported_media` 拒绝 `document` 部件（房间里的图片本来就是原始字节，且没有文件消息）。
- 可选 Reply：模型传 `reply_to_message_id`，目标必须命中当前 Conversation Context 里仍在保留段内且未过期的 `reply:<宿主消息 ID>` 引用。跨过宿主边界的只有宿主自己的消息 ID：Telegram 是 wire message ID；房间是房间序号，由 Playground host 在本房间内解析成存储行，发送结果（`Sent message N`）报告的也是新消息的序号，不是 `messages.id`。
- **同一消息只回复一次**（默认行为，`agent.allow_reply_message_multiple_times` 缺省为 `false`）：按目标 Conversation + `reply_to_message_id` 查询保留的 `telegram_sends`，文字、贴纸、图片共用一次回复机会，不按内容或 Invocation 区分。已有 `success` 时拒绝为 `reply_already_sent`；已有 `pending` / `outcome_unknown` 时保守拒绝为 `reply_delivery_unknown`（未决优先），只有明确 `error` 不占回复机会。先在 send 屏障前预检，再在写入 pending 的同一个 IMMEDIATE 事务内复检，覆盖并发、跨 Invocation、Context 重建与重启。屏障自身的 Bucket 挂载事务必须独立提交，不能被后续发送审计失败回滚成「内存已排队、数据库未挂载」；旧审计同样生效，超出在线保留窗口不承诺去重。显式设为 `true` 时整段守卫跳过，允许对同一显式目标多次发送；它不绕过授权、预算、发送限流与 send 屏障，也不关闭图片 generation/asset 交付去重或结果未知保护（见 [Image 生成](#image-生成)）。`send` 的 Tool 描述随该配置切换。被 Reply 去重拒绝的文本/贴纸内容在本次 Invocation 内烧毁：以 kind + 内容（文本，或贴纸 ref 解析出的 sticker file id——每次 `search_stickers` 都会为同一张贴纸生成新 `stk_` ref，按 ref 比对会被重搜绕开；不含 `reply_to_message_id` 与 `parse_mode`）为键，改换或省略目标重投一律以 `send_bypass` 拒绝，实现是查本 Invocation 内 `tool_name = send`、`state = error`、`error_code` 为 `reply_already_sent`/`reply_delivery_unknown` 的审计行，对留存的原始输入（含模型塞入的占位字段）重新归一化后比对键；去重开启时，带 Reply 目标的 `send_duplicate` 行同样烧毁（原样重发已发出的 Reply 必然指向已回复消息，只是重复发送守卫先拦下），`send_reply` 预检因此把带目标的 part 1 精确重复留给交付路径，让它落成可烧毁的 `send` 审计行（part 1 最先发送，整组仍不会发出任何消息）。`send_reply` 预检同样逐条比对烧毁，命中整组不发。烧毁随 Invocation 结束失效、不跨运行继承，与持久的 Reply 去重互补。图片豁免，理由同重复发送守卫（generation 可能增加成品后再交付新图）；send 屏障与限流拒绝不烧毁内容，两者都明确允许稍后重试。`send_bypass` 拒绝在重复发送守卫开启时同样计入 `duplicateSendRejections`，但拦截本身不依赖 `send_duplicate_guard_enabled`。重放场景沿用同一烧毁与拦截规则。
- 该守卫开启时（默认），重复 Reply 只新增 `tool_calls` 错误审计，不调用 Telegram、不写新的 `telegram_sends`、不计发送额度，也不触发 send 屏障。`resend:true` 不绕过限制；已交付图片的 `replayed:true` 是无发送的成功重放，不算第二次回复。被 Reply 拒绝的内容在本运行内删掉或改换目标重投会以 `send_bypass` 拦截（见上一条）；不带 Reply 的独立发送仍可用，runtime 不推断其语义归属，也不做文本相似度去重。关闭守卫（`allow_reply_message_multiple_times: true`）后以上拒绝路径全部不触发，模型仍须为自己的每次发送提供依据。
- **同一次运行不原样重发**（`agent.send_duplicate_guard_enabled`，缺省即开启，显式 `false` 关闭）：`send` 与 `send_reply` 的每一条在发出前，查本 Invocation 的 `tool_calls` 里有没有 `tool_name = send`、`state = success`、`side_effect = 1` 且 `arguments_json` 与本条归一化输入（`narrowSendInput` 的结果：kind、文本或 `sticker_ref`、`parse_mode`、`reply_to_message_id`）逐字相等的行；命中即以 `send_duplicate` 拒绝，不调用 Telegram、不写 `telegram_sends`、不计发送额度。另有一条只看上一条的内容判重（`repeatsLastSend`）：取本 Invocation 最后一条同条件的成功 `send`，用 `sendContentKey`（kind + 文本或贴纸 file id，不含 `reply_to_message_id` 与 `parse_mode`）比对，相同也以 `send_duplicate` 拒绝，专防「同一句话挨个回复不同的人」；它排在烧毁检查之后，已被 Reply 去重烧毁的内容仍报 `send_bypass`。只比上一条，是为了不误伤隔了别的消息后再出现的短句；A → B → A 交替靠逐字比对与 Reply 去重兜底。按 file id 比对也让重搜贴纸得到的新 ref 无法绕过。带 Reply 目标被拒的这类行同样按上一条规则烧毁内容。只看 Telegram 已接受的发送：明确失败的同一条可以原样重试，结果未知的仍由「不能盲目重发」约束。`send_reply` 在预检阶段同时比对之前的发送与本组前面的条目（内容判重时 part 1 比本次运行上一条发送，后续各条比前一条 part；带目标的 part 1 同样留给交付路径），命中则整组不发。图片豁免：同一 `image_generation_id` 可能在成品增加后再次交付新图，重复由 asset 交付去重处理。每次拒绝都回调 runtime 计数，累计超过 3 次（`DUPLICATE_SEND_REJECTION_LIMIT`）时在该 turn 结束后以 `duplicate_send` 停止；重放的合成 send 在场景内套用同一规则与停止条件。它与上一条 Reply 去重相互独立，线上开启 `allow_reply_message_multiple_times` 后仍防住了「同一句话对同一条消息连发 24 次」这类循环。守卫开启时 `send`/`send_reply` 的描述会多一句「与本次运行已发内容完全一致的文本或贴纸，以及改换或省略引用目标重复上一条的内容，会被拒绝」。

发送前写 pending 审计并标记副作用边界。明确失败可按策略处理；网络中断后无法确认 Telegram 是否接收时记录 `outcome_unknown`，不能盲目重发。进程若在 pending 落盘后、结果落盘前崩溃，重启恢复只结算 Invocation，不会把发送行按年龄改成 `error`；默认去重策略下，遗留 pending 在审计保留期内继续阻止 Reply，不能靠超时推断未送达。

- 运行已被 abort（`/pause`、`/cut_topic`、Admin 取消）或已过 Invocation deadline 时，`send` 在写 pending 审计之前直接拒绝：Tool Call 记为 `error`，错误码 `aborted` / `deadline_exceeded`，不写 `telegram_sends`、不调用 Telegram。
- Telegram 返回 429 时按 `retry_after` 等待后重试，等待超过 deadline 则不重试；等待期间 abort 记为 `error`/`aborted`。开启 send 屏障时，等待结束后会再判断一次屏障，命中则不重试，记为 `error`/`send_barrier`（此时已有 `telegram_sends` 行）。
- 发送进入 Telegram 调用后失败时，`send` 的 `tool_calls.result_text` 记录返回给模型的同一段错误文本；Telegram API 错误（`telegram_<code>`，含 5xx 的 `outcome_unknown`）在末尾附上 Telegram 的 `description`，例如 `Telegram send failed: telegram_400 (Bad Request: can't parse entities: …)`，让模型能据此修正 MarkdownV2 转义等问题。`telegram_sends` 只记错误码。
- Telegram 已接受、但本地落库失败（例如写 `messages` 出错）时，Tool 仍向模型返回成功，避免模型重发；日志输出 `send_record_failed`（带 `telegram_message_id`），并尽量单独把 `tool_calls` / `telegram_sends` 标为 `success`。这种情况下该条外发消息可能不在 `messages` 里。

`agent.send_max_text_length` 配置了文本最大字符数（默认不限制）时，超长文本在进入发送前被拒绝：Tool Call 记为 `error`、错误码 `send_text_too_long`，不写 `telegram_sends`、不消耗窗口额度。

`agent.send_disallow_blank_lines` 开启（默认关闭）时，包含任何空行的文本同样在发送前被拒绝，错误码 `send_blank_lines`。

`agent.send_empty_text_strategy`（可选，默认 `reject`）决定解析为文本（`kind: "text"` 或 kind 缺省且没有 `sticker_ref`/`image_generation_id`/`image_ref`）却没有 `text` 的一条怎么处理；旧字段 `send_empty_text_fallback_enabled: true` 在策略缺省时等价于 `random_text`。

- `reject`：以 `send_input_invalid` 拒绝，不调用 Telegram。这是默认值，也是没有该策略字段且旧开关未开启时的行为。
- `silent_success`：Tool 入口直接返回成功，结果明确说明「已处理但没有发送任何消息」，不写 `host_sends`、不占发送额度、不触发 Reply 去重/重复发送/屏障；`tool_calls` 为 `success` 且 `side_effect = 0`。`send_reply` 逐 part 处理：缺文本的 part 跳过并各记一条成功审计，其余 part 照常发送，`reply_to_message_id` 落到第一条真正发出的 part。`send_reply` 预检拒绝与中途失败的报错都沿用模型原调用里的 part 序号，部分失败只列出真正发出的 part。静默成功不视为实际发送，连续三次会以 `completion_reason = silent_send` 结束运行（与重复失败熔断同为三次）；熔断按 Tool 调用计数，一次全部静默的 `send_reply` 只算一次，任何真正发出的消息都会把该连续计数清零。
- `random_text`：由 `fillEmptyText` 在 Tool 入口从 `send_empty_text_fallback_texts`（默认 `["……"]`）随机取一条补上，并去掉 `parse_mode`（兜底文本没有按 MarkdownV2 转义）。补全发生在任何检查之前，所以长度/空行规则、Reply 去重、重复发送守卫与烧毁、`tool_calls.arguments_json`（`send_reply` 行与各 `:<n>` 行）看到的都是实际发出的文本：同一次运行里连续两次无文本发送抽中同一条，第二次照常以 `send_duplicate` 拒绝。Tool 结果在原文之后追加一句说明发出的是哪条兜底文本（`send_reply` 按 part 编号逐条说明），模型的 transcript 里保留的仍是它原本的调用参数。

三种策略都不影响 Sticker、图片、文件与带了 `text` 的发送；`text: ""` 仍被 schema 的 `minLength: 1` 拒绝，不视为缺少 `text`；其他参数形状错误（例如文本带 `resend: true`、Sticker 没有 `sticker_ref`）也照常拒绝。Tool 描述不提及此功能；重放的合成 send 按当前配置套用同一策略与静默熔断。

`agent.allow_reply_message_multiple_times`（可选，默认 `false`）是上述「同一消息只回复一次」守卫的总开关，与 `send_*` 同级、全局生效、无 per-Chat 覆盖：`false`/省略时守卫启用，`true` 时跳过查重并允许对同一显式目标多次发送，但图片 generation/asset 交付去重与结果未知保护不受影响。它属于热更新白名单：显式应用配置后**下一次** Invocation 与重放读取新值，运行中的 Invocation 继续用启动时的快照；Tool 描述在每次运行时按该快照生成，因此同一进程里新旧运行可能看到不同的 `send` 描述。

`agent.rate_limits.sends_per_window` / `window_seconds` 限制同一 Chat 在滑动窗口内的 `telegram_sends` 行数，不区分状态（失败的尝试同样消耗额度，否则失败重试的循环就没有刹车）；超出时 Tool Call 记为 `error`/`send_rate_limited`，不写 `telegram_sends`。这是长活 Invocation 取代 per-Invocation `max_sends` 的刹车。

### 一条消息对应一个话题

`send` 的 Tool 描述要求「一条消息对应一个话题」：同一批新消息里有多拨人在聊不相关的事情时，模型为每个它选择参与的话题各调用一次 `send`，并分别带上指向该话题内消息的 `reply_to_message_id`，而不是把不相关的内容合进一条消息。没话要说的话题可以不回；单个回答不拆成多次 `send`，需要连续几条（例如先发 Sticker 再接文字，或把中等长度的回答分成几句短消息）时用一次 [`send_reply`](#send_reply)。

话题分线仍只是 Tool 描述层面的倾向，runtime 不推断话题，也不强制 `reply_to_message_id`；但默认配置（`allow_reply_message_multiple_times` 为 `false`/省略）下，显式指向同一消息的重复 Reply 会被上述守卫硬性拒绝，显式开启 `true` 后同一目标可以多次回复。模型从消息头的 `re:N`、`uid:N` 与时间顺序自行推断话题归属；同一个 Forum Topic 内部的多话题仍属于同一个 Conversation。不同回复目标的多次 `send` 各自独立审计、独立计数、独立失败，不能因「一个回答不拆多条」而把不相关的话题合并。

代价是群里会更容易连发若干条，从而更容易撞上 Telegram 自己的群聊发送速率限制；那只是多走一次既有的 429 `retry_after` 重试，不丢消息。

### send_reply

`send_reply` 把一次回复拆成 2–4 条连续消息按顺序发出：`parts` 的每一项是一条消息，字段与 `send` 相同（文本、`kind: "sticker"` + `stk_` 引用、`kind: "image"` + `image_generation_id` 与可选说明、`kind: "file"`），顶层可选 `reply_to_message_id`。它不是第二条发送通道，每一条都走完整的 `send` 管线：

- **先全部检查，再发第一条**：字段与 kind 是否匹配、Reply 目标是否可见、`send_max_text_length` 与 `send_disallow_blank_lines`、Sticker 引用授权、图片 generation 是否属于本 Conversation 且有成品、文件来源的 `img_` 授权（读取与原图反查留到该条发送时）、图片与文件说明长度、abort/deadline，以及本 Chat 滑动窗口剩余额度是否容得下全部条数。任一项不过，整次调用记为一条 `send_reply` 的 `error` Tool Call，不写 `telegram_sends`、不调用 Telegram、不消耗额度。
- **逐条发送**：第 n 条以 `<tool_call_id>:<n>` 作为自己的 `send` Tool Call 走原有流程（审计、`telegram_sends`、限流计数、429 重试、写入可见历史、完成回执首条文字的 @ 提及）；外层另有一条 `tool_name = 'send_reply'` 的 `tool_calls` 行，成功时 `result_text` 为 `telegram_message_ids=…`。
- **Reply 只挂在第一条**：顶层 `reply_to_message_id` 只给第一条，后续几条不带 Reply。因此「同一消息只回复一次」守卫只作用于第一条：目标已被回复过时第一条被拒，整次什么都不发。
- **send 屏障只拦第一条**：第一条发出后，期间到达的新消息不再拦下后面几条（429 等待后也不再判断屏障），避免把一次回复切成两半；新消息按原规则在本轮之后注入。
- **中途失败**：第 k 条失败（Telegram 错误、结果未知、abort 等）时停止，前面已发出的保留；外层 `send_reply` 行记为 `error`，错误码取自失败那条，`result_text` 记录已发出的 message ID；Tool 结果向模型列出已发出的消息并要求不要重发，剩余条目不尝试。
- **计数**：每一条都是一行 `telegram_sends`，各自计入 `sends_used` 与 `sends_per_window`；成功的 `send_reply` 在 Conversation Context 中算作**一次**发送（一个 toolResult 带 `send_seq`）。它与 `send` 一样计入 send nudge 判定、收尾模式只保留的工具与 `execute` 不可调用的原语。
- Scene 重放把它合成为每条一个 `send` 输出（`<id>:<n>`），同样先检查全部条目，第一条受场景内的同一消息只回复一次约束。

### send 屏障

`agent.send_barrier_enabled` 开启时，`send` 在所有输入校验都通过、即将写 pending 审计之前多做一次判断：模型组织回复期间，同一 Conversation 是否又开了 `collecting` Bucket。若有，就不发这条，而是：

1. 在同一事务里把这个 Bucket attach 进当前 Invocation（与到期 attach 同一个 `attachBucketToInvocation`：写 `invocation_buckets`、Bucket 置 `running`、按 `sequence_no` 续写 `invocation_messages` 快照），再 `queueInjection`。
2. 本次 Tool Call 记为 `error` / `send_barrier`，不写 `telegram_sends`、不消耗发送配额；Tool 结果告诉模型新消息紧随其后，请读完再决定发什么——两批延续同一个话题时可以一条消息同时回应，是不同话题则各发一条。
3. 该 turn 结束时，turn 边界上既有的 `injectPending` 把这批 steer 进去（它本身就是一个 checkpoint），模型在下一次调用里同时看到被拦的原因与新批次。

约束：

- **每轮至多拦一次**：`barrierSpent` 只在 Agent 空下来（`freeAgent`：该轮结束或运行结束）时重置，屏障自己触发的注入不重置它。所以群里一直有人说话时，第二次 `send` 照常发出，之后到达的消息按原规则等下一轮。
- 已排队、尚未注入的普通消息批次会拦下同一 turn 里之后的所有 `send`，直到模型读过它，不会出现「第一条被拦、第二条先发出去」。待注入的 receipt 不触发这个屏障；当前处于回执轮时也不因新用户消息拦下 `send`，避免把回执政策与普通批次混合。
- 运行处于收尾（`context_stop_ratio` 的 send-only 轮，或已 `beginClosing`）时屏障放行：收尾之后不再注入，拦下只会丢掉这次回复。已 attach 未注入的批次按原规则在运行结束时由 `releaseUninjectedBuckets` 重新排队。
- 只看已开 Bucket 的消息：被参与闸门拦下、其他 Bot 的消息、不开桶的单独 Sticker 都不会触发屏障。
- 屏障 attach 不经过[主动回复概率调度](#主动回复概率调度)：沿用当前 Invocation 已获得的机会，不抽样、不改保底计数。
- 触发时日志输出 `send_barrier`（`invocation_id`、`bucket_id`、`conversation_id`、`chat_id`）。

成功发送后：

- `tool_calls` 记为 success。
- `telegram_sends` 保存 Telegram 返回 ID/时间。
- 发送内容写入可见消息历史。
- Agent 的私有 Assistant 文本仍不进入 Telegram。

## `web_fetch`

`web_fetch` 是经 `execute.call` 调用的内部能力，接受模型生成的单个 URL，只执行无 Cookie、无认证 Header 的 HTTP(S) GET。它只允许协议默认端口，最多跟随 3 次跳转；每一跳都重新解析并校验目标，连接固定到已经校验的 IP，防止 DNS rebinding。

直接提交的环回、私网、链路本地、文档与保留地址会被拒绝；IPv4 映射地址（`::ffff:0:0/96`）靠「IPv6 只放行 `2000::/3`」拦截，不能写进 `BlockList`——Node 的 `BlockList` 会拿 IPv4 查询去匹配该 IPv6 规则，结果拒绝所有 IPv4 地址；嵌入 IPv4 目标的 IPv6 过渡地址（6to4 的 `2002::/16`、Teredo 的 `2001::/32`）同样拒绝，否则有对应隧道路由的主机会绕过 IPv4 黑名单。域名解析到 `198.18.0.0/15` 默认拒绝：任何人都能把自己的域名解析到这个网段，所在网络恰好路由它时就是 SSRF。只有使用 fake-ip 代理（Clash、Surge 等把所有域名解析到该网段）的部署才应设置 `web_fetch.allow_proxy_synthetic_addresses: true`，此时也只放行「域名解析结果」，模型直接提交该网段 IP 仍会被拒绝。`web_fetch.dangerously_allow_all_ip_addresses: true` 跳过以上全部地址校验（含 IP 字面量与跳转目标），Tool 描述随之告知模型可访问私网；端口、协议、凭据、跳转次数与响应类型限制不变。

Tool 只返回文本、JSON、XML 或 JavaScript 响应，拒绝压缩和二进制内容。默认 `Accept` 以 `text/markdown` 优先（`web_fetch.accept_markdown`，缺省开启；`raw: true` 时不声明），站点返回 `text/markdown` 时原样返回并加 `Format: Markdown served by the site` 行，`details.format` 记为 `markdown`。`text/html` 与 `application/xhtml+xml` 默认读取最多 2 MiB HTML，经 [Defuddle](https://github.com/kepano/defuddle) 抽取正文并转成 Markdown（去掉图片，Header 附 `Format` 与 `Title` 行）；模型传 `raw: true` 才返回原始 HTML，其他类型原样返回。转换固定 `useAsync: false` 并注入拒绝所有请求的 `fetch`：Defuddle 默认会为 YouTube、X、Bilibili 等页面调用第三方 API，那些请求绕过上面的地址校验与审计。转换是同步 CPU 工作，2 MiB 上限同时约束它阻塞事件循环的时长；转换失败返回 `conversion_failed`，不隐式回退原文。复杂解析（JS 渲染、登录页等）不在本 Tool 范围，交给用户自接的 MCP。单次调用最多 15 秒、结果最多 32 KiB；结果前缀明确标记网页为不可信数据。调用参数、结果、耗时和失败码写入 `tool_calls`，`side_effect = false`。

## `web_search`

`web_search` 是经 `execute.call` 调用的内部能力，只在 `web_search` 可用（总开关打开且至少一个引擎启用）时注册；同一状态还决定 `web-search` Skill 是否出现在索引里。它只负责发现：返回标题、URL 与摘要，不读取正文；需要正文时由模型对选中的 URL 调用 `web_fetch`。

- **输入**：`{ action?, query?, engine?, count? }`。`action: "list"` 返回当前启用的引擎与备注（可用于配置在运行中被修改后刷新列表）；默认 `search` 需要非空 `query`（最长 500 字符）。`engine` 省略时用第一个启用的引擎；`count` 覆盖该引擎的默认条数（1–10，服务商可能自行限制）。
- **引擎可见性**：每个引擎的 `note` 同时出现在 Tool 描述（最多 8 个、每条截断到 160 字符）与 `action: "list"` 的结果里，模型据此选择引擎。描述不写死某家服务商的上限或默认条数，避免同一个 Invocation 内配置变化后描述失真。
- **按请求冻结**：每次调用开始时读一次当前配置，固定本次的引擎、服务商、地址、已解析密钥、条数与超时；查询按该服务商上限静默裁剪。搜索进行中修改配置，在途请求继续用旧配置完成，同一 Invocation 的下一次搜索用新配置。审计记录实际使用的引擎与服务商。
- **运行中变化**：关闭总开关或禁用所有引擎时，进程会 abort 所有运行中的 Invocation（`web_search_disabled`），它们保留的旧 Tool 集合因此不会再被使用；接下来的消息重建 Context。只禁用部分引擎时不打断运行：请求到被禁用的引擎会返回 `engine_disabled`，并通过 steer 注入一条提醒，要求模型重新读取引擎列表；请求不存在的引擎只返回 `unknown_engine`，不 steer。
- **边界**：查询、标题、URL 与摘要都是不可信数据；标题与摘要清掉控制字符与换行，URL 只接受绝对 HTTP(S)、去掉 fragment 与凭据，防止用换行伪造结果行。服务商重定向一律拒绝，失败响应体不读取，响应最多 256 KiB，失败不自动重试。结果文本上限 24 KiB、单条摘要 600 字符，超出部分截断并标记。失败按认证（401/403）、额度（402/432/433）、限流（429）、上游不可用（5xx）、请求被拒（其余 4xx）、重定向、响应过大、超时、Invocation 到期、密钥无法解析、响应无法解析与网络失败分类；密钥不进入审计、日志或模型上下文。

## 用户图片模型分流

当 `agent` 模型支持 image 时，`new` 区段的 Photo 与受支持的图片 Document 随冻结 Context 直接送入主模型，不经过 `read_image` 或独立 `vision` 模型；历史区段的图片只保留 `image_ref`，模型可用 `read_image` 按需查看，避免旧图占用输入或分散注意力。Telegram Photo 只保留最高分辨率变体，避免同一照片重复占用模型输入。

当 `agent` 模型只有 text 输入时，所有普通图片不附到主模型请求，而是在 Context 中保留按 Conversation Context 授权、带 TTL 的 `image_ref`（`img_`，见[引用生命周期](#引用capability生命周期)）。Agent 可按需调用 `read_image`，由独立 `vision` 模型返回文字描述。普通图片分析继续按 `file_unique_id + analysis_version` 缓存，随在线保留窗口（`retention.online_days`）清理。

直传图片在首次 Agent 请求前下载到 `paths.media_cache` 临时目录，并执行下载大小、真实格式、像素数、EXIF 移除、最大边长与标准化输出大小限制；请求载荷完成构造后立即删除临时文件。下载或校验失败会使 Invocation 失败，不会把缺失图片伪装成成功。

## Image 生成

图片生成把「Agent 提交意图 → 后台生成 → 回执注入 → `send` 交付」拆成两个模型回合，全部经由既有机制，没有第二条投递路径：

- **工具挂载**：`image_generate`（写）与 `list_image_models`（只读）是内置插件（`src/plugins/image/`）经 `execute` 暴露的内部能力，不是 MCP，也不是 runtime 原语。图片功能禁用（`image` 段缺失、被剥离或刚被删除）时这两个能力与 `image-generation` 技能都不会出现在 Agent 的工具注册表与 Skill 索引里——技能索引按 `skillVisibility` 过滤，`read` 也按同一规则把隐藏技能下的文档当作不存在（`resource_not_found`，绝对 URI 与相对引用都一样），模型不会看到「存在但不可用」的图片工具。挂载按 Conversation 判定：Telegram 会话跟随全局 `image` 配置；Playground 房间默认关闭，只有 `rooms.image_enabled`（管理员经房间能力端点开启，记录 `image_enabled_by` / `image_enabled_at`）为真时该房间才拿到工具与技能。开关属于房间 revision 保护的能力设置，翻转会改变该房间下一次运行的稳定 prompt（技能索引在列），从而重启该 Conversation 的 Context——与其它能力开关一致；关闭只阻止**新提交**，已受理的生成继续执行并把回执与成品送回原房间。
- **模型目录**：提交前先读目录。`list_image_models` 只读分页返回当前配置的模型目录：输入 `{}` 或 `{offset}`（整数 0–100），每页最多 4 个模型，按 `execute` 的序列化字节预算缩小页长而不截断备注，返回 `models`/`total`/`next_offset`（翻完为 `null`）；单个模型元数据仍超限则明确报错。模型对象是 PublicModel：`id`、`name`、`description?`、`provider`、`upstreamModel`、`providerTag`、`capabilities`，**不含 `credentialRef` 或任何凭据**，调用不触发上游请求、不产生任何费用。`description` 是管理员对每个 providerTag/upstreamModel 路由的独立备注（最长 1000 字符，可空），注明适用画风/任务与提示词风格；它只作选型与写 prompt 的指导——系统不自动拼接备注原文、不把它作为独立字段发给生图上游、不能覆盖工具授权。模型按能力与备注选型：用户点名时优先遵循（能力兼容前提下），否则由模型自主选择，不按画风硬编码路由。只配置一个模型时 `image_generate.model_id` 可省略；多个模型必须显式传 `model_id`。目录变化、模型被拒或删除后重新读取目录，不静默 fallback 到别的模型。
- **输入授权**：`input_image_refs` 只接受本 Conversation Context 授权的 `img_` 引用（经 `resolveMedia` 解析为真实 Media ID），任意 file ID、URL 或其它会话的引用在提交前就被拒绝并审计（`image_input_ref_unauthorized`）。
- **提交与幂等**：bridge 以 actor `agent:<conversationId>` 向 image core 提交生成意图（idempotency key 绑定 Conversation），同一 Conversation 内同内容重复提交返回既有 generation（`replayed: true`），不重复计费；每个 Invocation 最多 3 次提交。工具立即返回 `generation_id`，图片此时还不存在。
- **回执**：生成落定（成功、部分成功、失败、重启后由 `reconcile` 对账）时，bridge 经 long task 完成对应任务，Scheduler 把任务完成回执作为消息注入原 Conversation——回执是**不可信数据**（`generation_id`、status、输出清单），与 Alarm 回执同一通道。进程重启不影响未完成生成：启动时 reconcile 重建 core 状态，晚到的结果照常投递，不会重复回执。
- **交付**：模型用 `send kind:"image"` + `image_generation_id` 交付。运行时按「该 generation 的 actor 是否就是本 Conversation」解析输出（`sendableOutputs`，跨 Conversation 引用拒绝），声明输出的文件读取失败时直接以 `image_generation_unavailable` 拒绝并审计，不静默缩小相册、不发图也不占发送预算。随后按目标 Conversation、generation 与 asset ID 查询 `host_sends`（Telegram DTO 仍由 `telegram_sends` 投影），只把尚未成功交付的成品一起发送（单图 sendPhoto，2 张以上 sendMediaGroup）。发送请求审计记录 `asset_ids`；全部已送时返回成功的 `replayed:true`，Tool 结果文本列出相关投递批次的旧 Telegram message ID，只增加 `tool_calls` 和 canonical toolResult，不新建发送行、不增加 `sends_used`、限流用量或 Context 的 `send_count_total`/`send_seq`。生成后来增加的成品不被旧资产交付误拦；默认配置下显式 Reply 仍受同一消息只回复一次的限制（`allow_reply_message_multiple_times: true` 时放开，见 [send Tool](#send-tool)）。去重随在线发送审计保留，跨 Invocation 与进程重启有效，不承诺超出保留窗口的幂等。
- **Playground 房间的图片输出**：房间的 `send kind:"image"` 走同一条管线；`photo` / `photo_album` 由 Playground host 发布为一条房间消息，图片按内容校验后复制进房间本地资产（`<data_dir>/images/playground/`，按 `(chat, sha256)` 内容去重，多条消息可以共享同一个文件），message、revision、media 行与发送台账在同一事务内提交，`host_sends.message_id` 指向该消息，`response_json.message_id` 记房间序号。已送达判据对两个宿主一致：状态为 `success` 且记有宿主消息 ID（Telegram 的 wire message ID，房间的序号）即算已交付；保留期删掉房间消息、清空 `message_id` 后仍按序号认定，模型看到的「已交付」消息也是这个序号。生成原件仍留在图片归档（随备份整体复制、不继承媒体 TTL）；房间副本按引用计数清理——没有任何 `media` 行引用后才删除文件。图片 worker 的启动恢复、入队与领取，以及 bridge 的启动对账，都经组合根注入的宿主执行资格判断：进程不服务的宿主，其生成既不执行也不被恢复改写。
- **延迟回执与重发**：图片回执在实际注入时附带 `image_delivery`，由互斥的 `delivered_asset_ids`、`pending_asset_ids`、`unknown_asset_ids` 三类列表组成且结果未知优先（同一 asset 的成功不抵消任何未决尝试，整代资产集合不可证明时全部归入未知），而不是沿用任务刚完成时的交付快照；因此工具链中已发送的图会被标为已送。用户明确要求重新发送时，只有普通用户消息轮（有 caller）可用 `resend:true`；完成回执轮不能绕过去重。任一待送资产存在 pending 或 `outcome_unknown` 的未决尝试、或旧发送带 `asset_ids_unknown` 时，都会阻止本次盲重试，即使显式 resend 也不绕过。真正发图仍审计 bot 消息与 `media`，并保留既有授权、引用 TTL、限流与发送屏障。
- **失败语义**：失败/中断的轮次同样完成任务（回执带失败状态）；模型用自己的话解释失败，重试是新的 `image_generate` 提交，未送达的输出没有隐藏重发路径。

配置段（模型、凭据、能力契约、热更新、软降级）见 [configuration.md](configuration.md#image-生成)；Admin 三页与启用开关见 [admin-panel.md](admin-panel.md#api)。

## `read_image`

`read_image` 是经 `execute.call` 调用的内部能力。模型只能使用 Context 中展示的不透明 `image_ref`。所有可见区段中的 Sticker、Photo 与图片 Document 都会生成 `img_` 引用，`read_image` 按当前 Conversation Context 授权解析，不按区段或模型能力设闸；多模态 Agent 的新消息图片另外直传主模型，Prompt 只是引导它优先看直传内容（重启或缓存丢弃后仍要靠 `img_` 再看）。Tool 不接受原始 Telegram file ID、任意 URL 或任意 Media ID。

处理流程：

1. 校验 capability、Invocation deadline 与全局 agent 每日 Token 预算。
2. 从 Telegram 下载到 `paths.media_cache` 下的临时目录。
3. 检查下载大小、图片格式、像素数和标准化输出大小。
4. 提取 Sticker 代表帧。
5. 调用 Vision 模型并审计 Token/图片预算。分析开始时取一次当前配置快照：这一份的 vision 模型与缓存版本在整次分析里不变，运行期间发布的换模型不会改变这次分析的结果。
6. 按 `file_unique_id + analysis_version` 缓存，`analysis_version = <provider>/<model>/prompt-<prompt_version>`：换 vision 模型或 prompt 版本后旧行不会被命中。
7. 删除临时文件。

Sticker 代表帧：

- Telegram thumbnail 优先。
- 静态 WEBP 直接标准化。
- 视频 WEBM 使用 FFprobe 获取时长、FFmpeg 提取中间帧。两者都固定 `-f matroska -protocol_whitelist file`：`is_video` 只是元数据，不能说明文件内容；如果放开格式探测，伪装成视频的播放列表（HLS）或 concat 文件会让 FFmpeg 以服务身份读取其他本地文件或访问网络。不是 Matroska/WebM 的内容直接失败。
- 动画 TGS 使用 python-lottie 导出指定中间帧 SVG，再由 Sharp 标准化。读取帧范围之前先在进程内解压，解压结果上限 8 MiB（`maxOutputLength`），超过即失败，不会调用转换器：20 MB 的下载上限挡不住 gzip 炸弹，而 `gunzipSync` 会在事件循环上同步展开它。

Sticker 视觉元数据通过严格 Tool Call 返回：中文描述、情绪、动作、中英文标签。不要改回“提示模型输出 JSON 后直接 `JSON.parse`”；Provider 可能返回 Markdown code fence，曾导致真实 `read_image` 失败。

## Sticker 搜索与后台索引

`reconcileStickerSets` 在启动与每次发布 `telegram.sticker_sets` 时把配置对账进 `sticker_sets`（按名称大小写不敏感识别 Set，昵称与备注只是复制；新增或重新添加的 Set 标为 `pending`，删除的 Set 停用其贴纸并删掉搜索行、保留分析）。Telegram 连接上线时 `StickerService.sync` 拉取全部已配置 Set，发布后 `refresh` 只拉取未同步的 Set；拉取串行执行，拉取期间被删除的 Set 丢弃其结果：

- Set/Sticker 元数据写入 SQLite。
- 重新启用的已索引 Sticker 若缺少搜索行，会回到 `pending`，由 worker 用缓存的分析重建搜索行（不再调用视觉模型）。
- 新增或版本变化的 Sticker 进入索引队列。
- 后台固定单并发，前台 Sticker `read_image` 优先。
- 分析成功后更新 `sticker_search` FTS5 trigram 索引。
- 失败记录次数与 `next_retry_at`，避免热循环。

`search_stickers`（经 `execute.call` 调用）支持语义查询，也支持一次解析最多 5 个目录 `sticker_id`；两种方式都只返回已允许、已成功索引的 Sticker，并生成当前 Conversation Context 的 `sticker_ref`（带 TTL，历史里引用过也仍然有效），结果附带所属 Set 的昵称。

注入批次里的 `<sticker_catalog>` 每个 Set 一行：`<sticker_set alias="…" note="…">id:emoji …</sticker_set>`。`alias` 与 `note` 由运营者写入，Core Protocol 声明它们可信，`id:emoji` 来自 Telegram 仍不可信；所有值经 XML 转义，备注折成一行，因此无法提前结束块或伪造标签行。目录内容与 transcript 已携带的最新目录不同时才重新渲染，所以改昵称或备注会在下一批注入时生效。目录 ID 与 Telegram file ID 都不能直接发送，`send` 只接受 `search_stickers` 返回的 capability；`execute.call` 的结果封套会在 `refs.sticker_ref` 中同时列出这些授权 token。

## Bot Commands

`/pause`、`/resume`、`/status`、`/model` 与 `/effort` 是 Chat 级控制命令，作用于发送命令的 Chat（含 Forum 全部 Topic），不按 Topic 隔离——`/model` 与 `/effort` 读写的就是该 Chat 的模型与思考强度覆盖，Topic 共用 Chat 设置。`/cut_topic` 与 `/rebuild_context` 是 Conversation 级命令：切点与 Context 重置都只作用于命令所在的 Topic。`/allowlist` 把命令所在的 Chat 追加进 `telegram.chats` 白名单。

- 判定：`message.entities` 中 offset 为 0 的 `bot_command`；命令名大小写不敏感；带 `@用户名` 后缀时必须匹配当前 Bot；Bot 发送者的消息不触发命令。未知命令与非命令消息照常入库。
- 启动时（`getMe` 后）调用 `setMyCommands` 自动注册 `/pause`、`/resume`、`/status`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/whoami`、`/allowlist`、`/ignoreme`、`/unignoreme` 及中文描述（`BOT_COMMANDS` 是唯一事实来源，注册前校验每个命令都能被 `parseBotCommand` 解析）；注册失败只记 `command_registration_failed`，不阻塞启动——命令菜单是便利设施，文本解析不依赖它。
- 命令消息只写 `telegram_updates` 审计，不写入 `messages`，因此不会创建 Bucket 或进入 Agent 历史。`parseBotCommand` 返回的命令附带 `messageId`（命令消息自身的 Telegram message ID）与 `threadId`（命令所在 Forum Topic），供 `/cut_topic` 记录切点，并供 `/cut_topic`、`/rebuild_context` 定位要操作的 Conversation Context。`threadId` 与入库共用 `conversationThreadId` 规则：只有 forum supergroup 的 topic 消息才取 `message_thread_id`，其余一律视为 thread 0，包括私聊（开启话题模式后消息会带 `message_thread_id`）和普通 supergroup 里 Reply 链自带的 `message_thread_id`。两边规则不一致时，带这类 thread id 的 `/cut_topic` 会找不到 Conversation、只写切点不清 Context，却仍回复「已清空」。
- 回复是确定性 Bot 输出（不经模型），直接通过 Bot API 发送并 Reply 原命令消息，不经过 `send` Tool；发送失败只记 `command_reply_failed` 事件，不重试。

`/pause`、`/resume`、`/model` 与 `/effort` 仅对 Bot 管理员开放（`telegram.admins` 配置，见下文）；`/status` 对任何成员开放。`/whoami` 同样对任何成员开放：回复发送者的 Telegram 数字 ID，发送者身份无法识别（`message.from` 缺失）时回复「无法识别发送者。」。非管理员或匿名身份执行受限命令会收到拒绝回复，不产生任何状态变更。

`/ignoreme`、`/unignoreme` 对任何可识别的个人账号开放，无需管理员权限：在当前 Chat 的 `ignored_user_ids` 中加入/移除发送者自己的 `message.from.id`，参数和 Reply 不会指定其他用户。作用范围是整个 Chat（含全部 Forum Topic）；迁移群写回迁移前配置条目。两者写回 `config.jsonc` 并立即热应用，重启后仍保留；已忽略用户仍可使用这两个命令，其他命令继续被丢弃。Chat/Topic allowlist、Bot 发送者、编辑和启动追赶仍按原有边界处理，不会靠自助命令越过。匿名 `sender_chat` 或无法识别发送者时不能改名单。

自助命令与其它配置写入共用 `ConfigReloader` 锁：在锁内读最新文件、按 Chat ID 定位列表并只增删自己的 ID，并发成员不会覆盖彼此或其它 Chat；重复请求不重写文件，但仍重新应用文件，可恢复之前已保存但应用失败的变化。应用也会带上文件中其它热字段并报告待重启项。文件写入失败时配置保持不变；写入成功而应用失败时明确回复「已写入 config.jsonc，但应用失败: …」，进程继续使用旧配置。已有历史与运行中模型已收到的消息不会追溯删除。

`/allowlist` 同样仅限管理员，是唯一能在**未列入白名单的 Chat** 里生效的命令：ingestion 在按 allowlist 拒绝 Update 之前单独放行「管理员发送的 `/allowlist`」（其余命令与普通消息在未允许 Chat 一律照旧拒绝，Bot 不回复陌生人），因此管理员把 Bot 拉进新群后可以直接用它开白。命令把 `{ id }` 追加进 `config.jsonc` 的 `telegram.chats` 并热应用（新增 Chat 是热变更，ingestion 白名单与参与策略注册表按发布代数重建，无需重启）；已配置的 Chat 回复「本群已在白名单中」。命令消息本身不进入消息流，该 Chat 的正常入库从下一条普通消息开始。删除 Chat 也是热变更（发布后停止其运行并保留数据），修改 Topic 范围仍是 restart，见 [configuration.md](configuration.md#运行时配置热更新)。

`/model` 同样仅限管理员，在当前 Chat 上运行时切换 agent 模型（与 Admin Panel「Models」页共享同一 `AgentModelSwitcher` 与 `ConfigReloader`，但只写当前 Chat 的 `telegram.chats[<id>]` 覆盖，不碰全局 `agent.*`；全局切换仍走 Admin `PUT /api/model` 或配置文件）：`/model` 按每页 20 条列出该 Chat 生效的模型与思考强度（未覆盖的项标注「继承全局」）与第一页可切换序号，每行在有 `nickname` 时只显示 `序号. 昵称`，否则显示 `序号. provider / model（name）`；`/model page 页码` 翻页，所有页面保留全局序号；`/model 纯数字序号` 把序号对应的 `provider` / `model` 写入 `config.jsonc` 中该 Chat 的覆盖，同时把该 Chat 的 `thinking_level` 重置为目标模型接受的最弱级别，再重新加载配置，成功回复「已为本群切换: …，已写入 config.jsonc 并立即生效。」与「思考强度已重置为该模型最弱的一档: <级别>」两行，因此重启后仍然生效。`/model default` 删除该 Chat 的 `provider`/`model`/`thinking_level` 三项覆盖，恢复继承全局；文件中已无覆盖时不重写文件，但仍应用文件里的其它热更新并报告待重启项。写入与加载共用同一把锁，两个并发切换不会交错；配置文件是符号链接、权限不允许或写后校验失败时回复错误，文件与当前配置都不变；文件已写入但应用失败时回复「已写入 config.jsonc，但应用失败: …」。越界页码、无效参数与 `/model reset` 都按无效序号处理。切换（含 `/model default`）立即生效：配置应用后，该 Chat 中仍在用旧模型的 Invocation 不经确认直接中止（`model_switched`，规则与范围同 Admin Panel，见 [admin-panel.md](admin-panel.md#模型切换立即生效)），回执多一行「已终止 N 个仍在使用旧模型的会话，它们正在处理的消息不会再得到回复。」；范围只限该 Chat，同时被应用的其它文件改动不会让别的 Chat 被中止；清单与语义见 [configuration.md](configuration.md#运行时配置热更新)。

`/effort` 同样仅限管理员，只管当前 Chat 的 `telegram.chats[<id>].thinking_level`，不动 `provider` / `model` 覆盖：`/effort` 列出该 Chat 生效模型（含 Chat 自己的模型覆盖）接受的思考级别、当前级别（未覆盖标注「继承全局」）与设置方式，模型标签与错误回执同 `/status` 一样优先显示 `nickname`；`/effort <级别>` 校验级别在该模型接受的列表内后写入覆盖并热应用，失败时文件不变；`/effort default` 只删除 `thinking_level` 一项覆盖，模型覆盖保留、思考强度回到继承 `agent.thinking_level`。级别取值与非推理模型只有 `off` 的规则见 [configuration.md](configuration.md#模型-thinking-级别)；写入与 `/model` 共用同一 `ConfigReloader` 锁，因此两个命令不会交错，成功只是对后续 Invocation 生效，正在运行的 Invocation 继续使用启动时快照。

`/pause` 立即生效（与 scheduler 同一事件循环，无竞态）：

1. 写入 `chat_pause`（chat_id 为内部 `chats.id`）。
2. 该 Chat 所有 `collecting`/`queued` Bucket 置为 `expired`、`error_code = chat_paused`；对应 `queued` Invocation 置为 `aborted`、`completion_reason = chat_paused`。
3. Scheduler 中止该 Chat 正在运行的 Invocation（`pauseChat`），包括正处于空闲等待（等待下一个 Bucket）的长活 Invocation；正在飞行中的 `send` 可能已经落盘，属正常结果。

暂停期间消息仍入库并保留 Revision，但不创建 Bucket、不启动会话；`processDue` 与启动追赶也会跳过暂停 Chat（追赶 Bucket 记 `skipped_budget`/`chat_paused`）。`/resume` 删除 `chat_pause` 行，恢复正常节拍。

`/status` 返回当前 Chat 生效的模型与思考强度（`本群模型: provider / model`，模型条目配置了 `nickname` 时改为 `本群模型: 昵称`；`思考强度: 级别`，未覆盖的项带「（继承全局）」标记；Admin Panel 的全局热切换与该 Chat 自己的 `/model` 覆盖都反映在生效值里）、本 Chat 的当日 `model_tokens` 用量，以及全局当日用量、`agent.daily_budget.max_tokens` 上限与四舍五入到两位小数的用量百分比；所有 token 数量使用千位分隔符。随后按该 Chat 的 Model Call 审计拆分显示 `读取`、`写入`、`缓存读取`、`缓存写入`，四项之和即上面的本群用量。日期口径均为 UTC；暂停中额外显示一行。每个 Conversation 再追加一行 Context 状态（保留消息数、保留窗口内的 `send` 数、`head_seq`、上次 GC 时间，尚未建立时显示 `Context: 尚未建立`）。配置了 `participation` 的 Chat 再多一行互动状态：`互动: 活跃时段内`、`互动: 注意力窗口至 <UTC ISO>` 或 `互动: 静默（仅 @、Reply 或关键词触发）`；暂停时只显示 `互动: 已暂停`。

`/cut_topic` 仅对 Bot 管理员开放，用于在群聊上下文被旧话题污染时手动切断历史：

1. 把命令消息自身的 Telegram message ID 写入 `conversation_context_cutoffs`（每 Conversation 一行，即 Chat + Forum Topic；重复执行只会前移切点，更旧的命令不会把切点往回挪）。Forum 中切一个 Topic 不影响同群其他 Topic 的 history。该 Topic 还没有任何入库消息时（没有 Conversation 行）不写切点，因为没有可切的历史。
2. 之后新建的 Invocation 在冻结 history 快照时排除 `telegram_message_id <= 切点` 的消息，命令消息本身也在切点上，因此不会进入下一个会话的上下文。
3. 先中断该 Conversation 正在运行的 Invocation（`BucketScheduler.abortConversation`，abort reason `context_cut`），再清空 canonical history（`head_seq` 推进到 `next_seq`、`context_refs` 全删、`generation` 递增），并驱逐进程内的 Agent 缓存。三步都必要：运行中的那次调用把切点前的 transcript 和一份运行开始时的 `head_seq` 快照都留在内存里，不中断它就会继续按被切掉的历史回答，还可能把这份更旧的 `head_seq` 写回去覆盖切点；`generation` 递增让它在中断信号落地前已经排好的写入直接被 `ConversationContextStore` 拒绝。
4. 不删除任何消息、Revision 或已淘汰的 Context 行（只软标记）；被切 Conversation 之外的已排队/运行中 Invocation 不受影响，启动追赶的 `new` 消息也不受影响。

`/rebuild_context` 同样仅对 Bot 管理员开放，用于**丢弃连续 Context 但不截断聊天历史**——典型场景是模型的 `context_window` 调小后，希望下一次会话按新预算重新开始，同时保留最近的聊天内容：

1. 定位命令所在 Conversation（Chat + Forum Topic），先中断正在运行的 Invocation（abort reason `context_rebuild`）。
2. 丢弃 canonical history（删除 `context_messages` 与 `context_refs`、`head_seq`/`next_seq` 复位到 1、`generation` 递增、Memo 刷新状态复位），并驱逐进程内的 Agent 缓存。`generation` 递增保证被中断的运行无法在命令返回后把旧 transcript 写回来。
3. **不写** `conversation_context_cutoffs`，因此 `/cut_topic` 划掉的历史不会被重建带回；已存消息、Revision、Memo Pad 与群聊记忆都不动。
4. 命令本身不触发模型回复；下一次正常 Invocation 用当前模型配置、Context Window 与 `history_messages` 规则，从持久化聊天记录重新渲染最近的 history。重复执行安全；没有 Conversation 或 Context 时直接回复无需重建。

## Bot 管理员列表

`/pause`、`/resume`、`/model`、`/effort`、`/cut_topic`、`/rebuild_context`、`/allowlist` 的白名单是配置文件里的 `telegram.admins`（Telegram User ID 数组），Bot 全局共享，它是唯一事实源：

- 旧版 `bot_admins` 表已删除（迁移 `026_drop_bot_admins.sql`）；旧表内容用 `scripts/migrate-admins.ts` 搬进配置（须在升级启动前运行）。
- 权限判定在 `BotCommandService`：命令发送者的 `message.from.id` 命中运行中配置的 `telegram.admins` 才放行；`sender_chat` 匿名身份一律拒绝。
- `telegram.admins` 在热更新白名单里（见 [configuration.md](configuration.md#运行时配置热更新)）：Admin「应用配置文件」或 Bot admins 页面的增删都会热应用，下一次命令执行就用新列表，无需重启；面板的增删是配置写端点（If-Match revision），写的就是这一字段。

## 常见排查顺序

1. `check-config` 输出是否为预期哈希。
2. `serve_started.config_hash` 是否一致。
3. `telegram_updates.allowed/rejection_reason`。
4. Bucket 与 Invocation 是否进入终态。
5. `model_calls` 是否 success，Token 是否计入。
6. `tool_calls` 与 `telegram_sends` 是否 success/outcome_unknown。
7. 媒体问题检查 `media_analyses` 和对应 Vision `model_calls`。

一次自然语言回复看似成功，不代表内部 Tool 都成功；必须以审计表为准。
