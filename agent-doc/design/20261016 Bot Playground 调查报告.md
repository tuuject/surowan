# Bot Playground — Current Architecture Investigation

调查日期：2026-10-16（Asia/Singapore）。代码基线：`a509b0637335c495fbb408d5d42b6cec0ff33472`（`Optimize bot prompt template`）。

本文记录本次只读调查的源码证据；推荐设计见[架构方案](20261016%20Bot%20Playground%20架构方案.md)，任务与验收见[Epic 与实施交接](20261016%20Bot%20Playground%20Epic%20与实施交接.md)。没有实施 Playground，没有修改运行代码。未读取旧设计正文或 devlog；父级索引只用于确定文档归档位置。

## 1. 调查结论

1. 可以复用真实 `AgentRuntime`、`BucketScheduler`、`ConversationRuntime`、canonical Context、模型注册表和 Admin 认证。没有必要先完成完整多 IM 框架。
2. `createCoreRuntime` 已解耦本地文件与进程生命周期，但**没有**解耦 Telegram：必传 `telegramApi`，Context 身份与配置解析、发送审计、媒体定位仍采用 Telegram 语义。
3. 当前不是 trailing-edge debounce。首条可触发消息开启固定 Bucket；普通后续消息不重置 deadline。运行中还有延后窗口、热注入、发送屏障三种行为。
4. Hold 不能用“消息照常进 collecting Bucket，只暂停 Scheduler”实现。发送屏障能绕过 deadline attach；历史快照能读到没有 Bucket 的消息。必须单独持久化“尚未获准交给 Agent”的输入状态。
5. `ReplayRunner` 是有价值的隔离先例，但不是 Playground 的执行入口：它使用内存场景循环和合成工具，不走生产调度与 canonical Context。
6. 当前发送工具是 `send` / `send_reply`，并不存在名为 `send_message` 的 Agent 原语。没有任意文件发送工具；支持文本、Sticker、生成图片。

## 2. 实际调用链

### 2.1 进程装配与消息接收

```text
cli.ts → parseCli → local-monolith/runtime-host.ts::serve
  → loadConfig / SecretStore / ServeLock / SqliteStore.open
  → grammY Bot → getMe / registerBotCommands / deleteWebhook
  → TelegramIngestion + MediaService + StickerService + McpManager
  → loadPlugins + createCoreRuntime
  → runStartupCatchUp → scheduler.start → AdminServer.start → bot.start

bot.use
  → TelegramIngestion.ingest(update)
  → 命令分流或 Message/Revision/Media 入库
  → participation / pause / Bucket 准入
  → MentionTyping（可选）
  → scheduler.wake()
```

证据：[runtime-host.ts](../../src/adapters/local-monolith/runtime-host.ts) 的 `serve`、`bot.use`；[runtime.ts](../../src/orchestration/runtime.ts) 的 `createCoreRuntime`；[startup-catch-up.ts](../../src/startup-catch-up.ts) 的 `runStartupCatchUp`。

`serve` 在启动 Admin 前已经解析 Telegram token、访问 Telegram、同步 Sticker、排空 pending updates。仅接入一页 Admin UI，不能得到无需 Telegram 连接的启动方式。普通停机还依靠 `bot.stop()` 让 `bot.start()` 返回，再执行资源清理。

### 2.2 入库不是单纯的 Telegram 类型转换

[telegram-ingestion.ts](../../src/ingress/telegram-ingestion.ts) 的 `TelegramIngestion.#ingestTransaction` 在同步事务内依次完成：

- 只选取 `message` / `edited_message`，或用 `my_chat_member` 更新 Chat。
- 先记录合法 Chat migration，再检查 Chat/Topic allowlist；channel 不接受。
- `telegram_updates.update_id` 冲突时直接结束，实现传输 update 去重。被拒绝 update 不留 raw JSON。
- 识别 Bot 命令；命令单独审计和处理，不进入普通消息流。catch-up 仅重放 `/pause`、`/resume`。
- 检查 ignored users，upsert Chat/Sender/Conversation；自身消息不从 ingress 再入库。其他 Bot 是否入库由配置决定。
- `#storeMessage` 新增 Message 或追加 Revision；非 edit 的同一 `(chat, telegram_message_id)` 不重复存储。
- 非 edit 消息才参与 `evaluateParticipation` 和 Bucket 分配；编辑不触发新 Bucket。
- `#appendToBucket` 检查 pause、eligible human、参与时段。其他 Bot/服务/默认不触发的纯 Sticker 只能陪伴既有 Bucket；其他 Bot 的待处理消息可在下次 human 开 Bucket 时被收编。

`conversationThreadId` 来自 [bot-commands.ts](../../src/orchestration/bot-commands.ts)，不是盲取消息中的所有 thread 字段。Telegram allowlist、迁群、命令、`sender_chat`、mention/attention 应留在 Telegram 输入边界，Playground 不应伪造 `grammy.Update` 借用这些规则。

## 3. 身份与引用的真实含义

证据：[schema.ts](../../src/store/schema.ts)、[invocation-snapshot.ts](../../src/store/invocation-snapshot.ts)、[invocation-context.ts](../../src/platform/invocation-context.ts)。

| 对象 | 持久化与唯一性 | 当前耦合/陷阱 |
| --- | --- | --- |
| Chat | 内部 `chats.id`；`telegram_chat_id` 非空且全局唯一 | `canonical_chat_id` 也是 Telegram 数值，不是跨平台 identity namespace |
| Conversation | 内部 `conversations.id`；`(chat_id, message_thread_id)` 唯一 | 普通聊天 thread 为 0；Forum Topic 独立 Context，但调度仍按 Chat 串行 |
| Sender | 内部 `senders.id`；`(telegram_type, telegram_id)` 唯一 | 类型只有 `user` / `sender_chat`；匿名群管理员的 `from` Bot 占位不能当真实作者 |
| Message | 内部 `messages.id`；`(chat_id, telegram_message_id)` 唯一 | `telegram_date` 为消息事件时间；`received_at` 为接收时间；两者不同 |
| Revision | `(message_id, revision_no)` 唯一；Message 指向 current revision | Sender/文本/媒体/Reply 属于 Revision；快照冻结当时 revision |
| Reply | `message_revisions.reply_to_message_id` | 是 Telegram message ID，不是 `messages.id`，也不是有 FK 的内部消息引用 |
| Reply snapshot | `reply_snapshot_json` | 允许目标原消息没入库时保留 sender/content 的截断引用；引用文字本身不授权发送 |
| Media | `media.id` → revision | `file_id` / `file_unique_id` / `telegram_json` 必填；不能拿本地文件路径假扮 Telegram file ID |
| Invocation | 内部 id → opening bucket / conversation | 一次运行可有多个 Bucket；不能用 opening bucket 判断全部输入 |

`ContextIdentity.chatId` 和 `InvocationContext.chatId` 当前实际是 **Telegram Chat ID**；Scheduler 查询中的 `v.chat_id` 却是内部 Chat 主键。`VisibleSender.userId` / `callerUserId` 是 Telegram 用户 ID。仅重命名这些字段会制造静默串群风险。

[context-refs.ts](../../src/context/context-refs.ts) 的 `ContextRefStore`：

- `img_…` → 内部 media ID；`stk_…` → Telegram sticker file ID。
- `reply:<telegramMessageId>` → conversation/thread；`createCapabilityResolver.resolveReplyTarget` 对参数执行 `BigInt`。
- 所有引用均绑定 Context、`source_seq`、TTL；`source_seq < head_seq` 或过期即失效。
- `send` 的 reply schema 只接受正整数字符串；不能直接支持 Discord 等任意 opaque ID。
- `ContextBuilder.renderInjection` 为本批选中的新消息注册 reply 引用；历史中展示一个 ID 不自动等于仍可回复。

内部 DB ID 使用 bigint；HTTP 中应保持字符串。跨 IM 通用层需要内部身份与可见引用分离，不能依靠正负号、范围保留或假 Telegram ID 来区分 Host。

## 4. 媒体链路与实际支持范围

### 4.1 输入

`normalizeMessage` 当前识别：

- 文本；Photo 取最大尺寸。
- Document 仅接收 MIME 为 JPEG/PNG/WebP、已知大小且不超过 20 MiB 的图片。
- Sticker 支持静态 WebP、TGS、WebM 元数据。
- 其他 document、voice、audio、一般 video/animation 等没有通用文件理解流水线；可能留下 `unsupported` kind、caption/raw fragment，但不能因此宣称已支持。

[media-download.ts](../../src/capabilities/media/media-download.ts) 已有 `MediaDownloader` 接口，但参数仍是 `fileId`；`TelegramMediaClient.download` 通过 `getFile` 和带 token 的 Telegram 文件 URL 下载，限制 20 MiB、禁 redirect、写 0600 临时文件。

[media-image.ts](../../src/capabilities/media/media-image.ts) 的 `prepareMediaImage` 使用 Sticker 专属元数据选择 thumbnail、FFmpeg/FFprobe 代表帧或 python-lottie，再经 Sharp 归一化。解码像素、解压后 TGS、归一化大小均有上限。

[media.ts](../../src/capabilities/media/media.ts) 的 `MediaService`：

- `loadDirectImages`：支持 image 的模型直接接收新批次图片，顺序与 `figure_N` 一致。
- `createReadImageTool`：只接受当前 Context 授权的 `img_`；Vision 输出按 file unique ID + analysis version 缓存，写审计与 token 用量。
- `prepareInputImage`：供生图引用输入；`prepareSceneImage`：供重放读取，后者不写生产分析状态。
- canonical transcript 不永久保存二进制载荷，后续读取依赖 ref/资产仍有效。

### 4.2 输出

[send-tool.ts](../../src/capabilities/send-tool.ts) 的 `createSendTools` 提供：

- `send`：text（可选 MarkdownV2）、授权 Sticker、当前 Conversation 的 `image_generation_id`。
- `send_reply`：2–4 个 part，先检查整组，每个 part 仍走 `deliver`；只有首条带 Reply 并经过 send barrier。中途失败会报告已经发出的 part，不能整组重试。
- 没有任意路径、URL、`sendDocument` 或任意文件上传原语。

`grammySendApi` 位于 [telegram-send-api.ts](../../src/capabilities/telegram-send-api.ts)，把生成图片映射到 `sendPhoto` / `sendMediaGroup`。`TelegramSendApi` 不只是网络接口：参数含 `MessageEntity`、`message_thread_id`、`reply_parameters`，返回 `message_id/date/chat/photo`，仍是 Telegram 协议。

`deliver` 内含引用授权、字符限制、回复去重、图片投递去重、滑动限流、deadline、barrier、发送审计、重试与出站 Message 持久化。抽象时必须保留这些共同业务规则，不能仅把 `api.sendMessage` 换掉。

429 在 deadline 内按 `retry_after` 重试，重试前再检查 barrier；`HttpError` 和 Telegram 5xx 记 `outcome_unknown`。成功后即使出站 Message 落盘失败，也不能向模型谎报“发送失败”。生成相册当前只将首个响应用于 `recordOutgoingMessage`；这是现有表示限制，不应在本 Epic 顺带改变 Telegram 相册行为。Playground 可在同一发送结果中保留多资产，但须如实表明与 Telegram 表示的区别。

### 4.3 Activity

[typing.ts](../../src/capabilities/typing.ts) 的 `createTyping` 是经 `execute` 调用的内部能力，不是顶层原语。`startTypingLoop` 每 4 秒刷新、最多 55 秒，失败仅为 cosmetic。`MentionTyping` 在 ingress 收到直接 @ 后可提前开启输入状态，runtime 回合结束/退出时停止。Telegram 适配器做 per-chat/thread throttle。

通用 Host 应提供可选 activity action；刷新时长/Telegram chat action 参数留在 Telegram 实现。Playground 可以记录短期 typing 状态，无需模拟 Telegram 网络请求。

## 5. Bucket、Invocation、Checkpoint 与失败

### 5.1 正常调度

```text
TelegramIngestion.#appendToBucket
  → collecting，deadline = 首条 receivedAt + bucket_window_seconds
  → BucketScheduler.#loop
      → processTasksDue / processDue
      → InvocationQueueService.#queueBucket 或 #attachBucket
      → snapshotInvocation
      → BucketScheduler.#launchQueued
      → AgentRuntime.run
      → terminal transaction / releaseUninjectedBuckets / wake
```

源码：[scheduler.ts](../../src/orchestration/scheduler.ts)、[invocation-queue.ts](../../src/orchestration/invocation-queue.ts)。

| 状态/条件 | 当前真实行为 |
| --- | --- |
| 后续普通消息进入 collecting | 追加 `bucket_messages.sequence_no`；不会每条重置 deadline |
| 同 Chat 有 queued Invocation | 普通 due Bucket 暂不创建新 Invocation |
| 同 Conversation 正在一个 round 中 | `processDue` 延后 Bucket，至少 250ms；round 结束再延后至 `round end + window` |
| 同 Conversation running 且可接受 attach | 冻结快照，写 `invocation_buckets`，`queueInjection`；下个安全 turn 边界注入 |
| 同 Chat 不同 Topic running | 不 attach，保持 Chat 串行 |
| closing | 不接收新 attach；留待后续运行 |
| 全局并发满 | 已排队不等于已启动；`max_concurrency` 限制实际运行 |
| 配置快照 | 在 queued → running 的同步事务中 `beginInvocation()`；`config_hash` 此时更新 |
| sleep / chat removed | 可能 `skipped_budget`，不是自动等待重试 |

`idle_grace_seconds` 控制正常 round 结束后的等待，不是 Hold 开关。取 0 会取消 idle wait，但不能据此推断“运行中绝不吸收新消息”：发送屏障和已经排队的注入仍有各自路径。

### 5.2 发送屏障会绕过普通 deadline

`AgentRuntime.#runInvocation` 内的 `holdForNewMessages`：发送前查询本 Conversation **任意 collecting Bucket**，不要求已到 deadline，调用 `attachBucketToInvocation` 后阻止本次发送，下一 turn 注入。每 round 有限使用，且完成回执 round 不做此操作。

这不是用户要求的 Hold。把 held 消息放进 collecting Bucket，即使暂停 Scheduler，也会被正在运行的 Agent 读到。必须让 held 数据在该查询之外。

### 5.3 历史选择也是输入通道

`snapshotInvocation` 的 history 查询按 Conversation 取可见消息，排除本 Bucket 的消息，遵守 `/cut_topic` cutoff，再按 `telegram_date, telegram_message_id` 排序截取。它**不要求消息曾经进 Bucket，也没有“本次 Release 的最大消息序号”条件**。

这服务于 Telegram participation 期间的聊天背景。但对 Playground，单纯“held 消息不建 Bucket”仍不够：它们可能被另一次 Invocation 快照作为 history 读入，尤其在排队、重启、失败重试、receipt 触发时。Playground history 必须增加明确的 admission 状态与批次边界。

### 5.4 模型输入与 canonical history

`snapshotInvocation` 冻结 Message/Revision 到 `invocation_messages.snapshot_json`。`ContextBuilder.identity`、`buildSystemPrompt`、`renderInjection` 将其转换为稳定 system prompt 与增量批次。

- 稳定 prompt 含 Core Protocol、Skills 索引、人格、Chat instructions、媒体说明；当前多处显式写 Telegram。
- Context 按 conversation 持久化于 `conversation_contexts/context_messages/context_refs`；`ConversationRuntime` 中 Pi Agent 是 LRU 缓存。
- 新批次按可用字符预算从新到旧选择，**当前允许省略较早的新消息**，以 `omittedNewMessages` 和文本提示记录。Release 成功不能直接等同“所有消息都被模型看到”。
- `#persistMessage` / `#markBucketInjected` 在消息事件中写 canonical history、checkpoint 与 `invocation_buckets.injected_at`。Checkpoint 是 Context GC 的安全切点，不是 delivery ACK，也不是可任意回滚到的事务快照。
- `#maybeCollect` 只在安全 turn 边界推进 `head_seq`、loop messages、Agent messages、refs；不摘要。缓存与运行必须共享一个 header 对象。

证据：[context-builder.ts](../../src/context/context-builder.ts)、[agent-runtime.ts](../../src/orchestration/agent-runtime.ts)、[context-store.ts](../../src/context/context-store.ts)、[context-gc.ts](../../src/context/context-gc.ts)。

### 5.5 终止、恢复与重试边界

- Scheduler 将运行记为 `completed/failed/aborted/outcome_unknown`，同步关闭实际消费的 buckets。
- 正常收尾时，已 attach 但 `injected_at IS NULL` 的非 opening Bucket 经 `releaseUninjectedBuckets` 创建新 Invocation；opening Bucket 不走该补偿。
- `recover` 把 running Invocation 按 `side_effect_started` 标记 `aborted` 或 `outcome_unknown`，不是恢复 Agent 的执行栈。
- 重启时超过五分钟的 collecting/queued 工作过期；五分钟规则不是正常运行时的批次寿命限制。
- claimed task receipt 重启后关闭为 handled/unknown，绝不自动重放。
- 没有“所有失败 Invocation 自动重试”能力。Provider `streamSimple` 的有限请求重试也不是整个 Invocation 的重试。
- 数据库接纳一次、模型收到一次、工具产生一次副作用，是三个不同保证；不能宣称跨网络 exactly-once。

## 6. 工具、副作用与隐藏的共享状态

注册入口：[runtime-host.ts](../../src/adapters/local-monolith/runtime-host.ts) 的 `capabilityTools/additionalTools`、[plugin.ts](../../src/plugins/plugin.ts) 的 `loadPlugins`、[builtin.ts](../../src/plugins/builtin.ts)。

| 工具/功能 | 实际执行与作用域 | Playground 含义 |
| --- | --- | --- |
| `read` | 只读 `system:///` Markdown；有审计 | 可复用真实实现 |
| `execute.search/help` | 注册表查询 | 可复用，列表须与执行权限一致 |
| `web_fetch` | 公网 HTTP(S) GET、SSRF 限制、审计 | 真实外部读取，可复用；不能称为完全无网络的纯函数 |
| `read_image` | 授权媒体读取、可能调用 Vision、写缓存/用量 | 可复用归一化/Vision，替换资产来源与用量 scope |
| `search_stickers` | 已配置 Telegram Sticker 索引查询、签发 file ID ref | 不是通用媒体搜索；本地 Playground 不能据此自动下载 Telegram |
| `send` / `send_reply` | 外部发送 + 出站落盘 + 审计/去重 | 必须绑定虚拟 Host；普通 assistant 文本继续私有 |
| `typing` | Telegram chat action | 可映射本地 activity |
| `add_memory/delete_memory` | 按 Conversation 的真实持久化 | 独立虚拟 Conversation 可安全复用，不应混入真实群 |
| `alarm/list_alarm/delete_alarm` | 持久化 `long_tasks/task_receipts`，后续真实 Scheduler 唤醒 | 并非立即发消息，但确实是延迟副作用；不能只拦 send 后放任创建 |
| `image_generate/list_image_models` | 真实付费生成，图片 worker + task receipt | 需要明确 opt-in 和虚拟目标约束 |
| `lookup_dictionary` | 读取 global/group 条目 | 实现为读，但插件把三个辞典工具统一标为 `sideEffect=true`；不能只按布尔值自动分类 |
| `add_dictionary_entry/update_dictionary_entry` | Chat 级词条写入 | 当前 Chat ID 是 Telegram ID；`privateChat: chatId > 0n` 也是 Telegram 假设 |
| `zzz` | 写全局 `app_state.bot_sleep_until` | 测试可使生产 Bot 休眠，必须隔离或不暴露 |
| MCP | `McpManager` 按本地配置 allowlist/read_only/timeout 策略执行 | 默认禁用 Playground 的 MCP；不能把远端 description/annotation 当授权 |

`ExecutableCapability.sideEffect` 是审计元信息，不是完整 sandbox policy。直接原语、MCP、插件 Context injector、后台任务都不完全经过这一个布尔值。

`readDailyTokenBudget` 当前汇总 `daily_usage.scope='chat'`；Agent 和聊天 Vision 都写这个 scope。复制虚拟 Chat ID 仍会消耗生产全局预算。LongTask 的 delivery `bypassDailyBudget`、全局 sleep、辞典自动注入和配置切换都需要纳入隔离检查。

[image/service.ts](../../src/image/service.ts) 的 `createImageService` 以 `startWorker: true` 装配图片核心；[worker.ts](../../packages/image-service/src/worker.ts) 的 `GenerationWorker.start` 先恢复 interrupted 工作，再扫描全部 queued generations。目前没有 Host 范围过滤。[image/bridge.ts](../../src/image/bridge.ts) 的 `agentActor` 用 `agent:<conversationId>` 绑定生成，`reconcile` 将终态写回长任务。只限制 Scheduler 的 Telegram 发送，不能阻止图片 worker 恢复真实收费任务。另一个需保留的区别是：当前 `<data_dir>/images` 生成原件属于备份归档，不自动继承媒体缓存 TTL。

证据：[sleep.ts](../../src/store/sleep.ts)、[execute-tool.ts](../../src/capabilities/execute-tool.ts)、[mcp.ts](../../src/capabilities/mcp.ts)、[alarm.ts](../../src/plugins/alarm/alarm.ts)、[dictionary/index.ts](../../src/plugins/dictionary/index.ts)、[long-tasks.ts](../../src/store/long-tasks.ts)。

## 7. Admin 与审计基础设施

[server.ts](../../src/ingress/admin/server.ts) 的 `AdminServer.handle/#api` 复用 `BusinessStore`，是手工路由分派，不是现成通用 CRUD 框架。

- Session 使用 Argon2id 密码、随机 cookie token / SHA-256 摘要、HttpOnly + SameSite=Strict；已有 passkey 支持。
- POST/PUT/DELETE 执行 Origin 检查；现状允许无 Origin 的非浏览器调用，不应在报告中写成“缺 Origin 一律拒绝”。
- Authorization header 走独立 API key 路径，绝不回退 cookie；当前 key 只允许指定 inspection/Invocation 读取与重放，不能自动获得 Playground 写权限。
- 当前没有按虚拟房间划分的管理员角色；Session 是面板管理员权限。
- 已有 TypeBox 参数边界、稳定错误码、请求大小上限、脱敏、keyset 分页。
- `listMessages` 默认按内部 id 倒序；Chat filter 是 Telegram ID；DTO 对 Telegram ID 调用 `.toString()`。新增 nullable Host 数据后若不审计所有查询，会直接产生 500。
- `getInvocation` 聚合 `model_calls/tool_calls/agent_messages/telegram_sends/invocation_messages`；没有现成的 Playground room timeline API。

前端为 TanStack Router 文件路由、React Query、shadcn 组件和中英 locale。入口包括 [routes/__root.tsx](../../apps/admin-next/src/routes/__root.tsx) 的 `AuthGate`、[app-sidebar.tsx](../../apps/admin-next/src/components/layout/app-sidebar.tsx)、[api.ts](../../apps/admin-next/src/lib/api.ts)、[queries.ts](../../apps/admin-next/src/lib/queries.ts)。消息页当前是审计表格；不是可编辑聊天组件。图片生成页面已经用 `refetchInterval` 轮询，可以复用该模式，MVP 无需 WebSocket/SSE。

Admin 重放：[replay.ts](../../src/orchestration/replay.ts) 的 `ReplayRunner`、[replay-tools.ts](../../src/orchestration/replay-tools.ts) 的 `createReplayTools`。它们可参考拒绝未知工具、dispatch 审计和场景预检方式；不能借用其内存合成 `send` 替代真实发送管线。重放会真实调用模型，但不续写生产 canonical Context。

## 8. 耦合清单与改动归属

| 位置/符号 | 耦合 | 建议归属 |
| --- | --- | --- |
| `TelegramIngestion`、`BotCommandService`、`ParticipationRegistry` | Telegram Update、chat migration、command、allowlist、mention | 保留 Telegram Adapter 输入职责 |
| `AgentRuntimeOptions.telegramApi/bot/mentionTyping`、`#buildTools` | 直接组装 Telegram send/typing | 接收绑定当前 Conversation 的 Host actions |
| `ContextBuilder.identity/buildSystemPrompt/renderInjection` | Telegram 配置/日期/ID/历史标签/用户类型 | Host 投影 → 通用 Context 输入；Telegram 文本输出保持原样 |
| `snapshotInvocation` | Telegram 字段及 history 排序/cutoff | 共用快照写入；由 Host 提供可见输入与投影规则 |
| `InvocationQueueService` | `resolveChatConfig`、全局 sleep、catch-up、receipt 目标 | Host admission policy；状态机继续共享 |
| `BucketScheduler` | sleep、Telegram window、diagnostic Chat ID | 运行资格和 pacing 取 Host policy；共享串行/并发 |
| `createSendTools` | grammY 错误、entities、结果结构、`telegram_sends`、outgoing writer | 共同发送规则保留；Telegram 格式与传输搬到 Adapter |
| `ContextRefStore` | 数值 reply ref、sticker file ID | reply 用 opaque 可见引用并绑定内部目标；Sticker 留 Host 扩展 |
| `MediaService/prepareMediaImage` | file ID、Telegram JSON、缓存身份 | 校验过的媒体 source 选择；复用已有处理引擎 |
| Dictionary/Alarm | Chat 正负号、Telegram user ID、mention URL | P0 禁用 PG 相关能力；Telegram scope 在边界映射 |
| Admin audit/retention/image delivery/replay | 直接 SQL 读取 Telegram 列与发送表 | 同步迁移查询；旧 Telegram DTO 与重放行为保持 |
| `serve` | Admin 前必须成功连接 Telegram | 可选择装配的 Host；复用一个进程生命周期 |

## 9. 已执行验证与证据限制

本次执行：

```bash
pnpm run check
pnpm run lint
pnpm test test/telegram-ingestion.test.ts test/scheduler.test.ts test/context-hot-inject.test.ts test/context-send.test.ts test/send-reply.test.ts test/reply-dedup.test.ts test/runtime-host.test.ts test/replay-tools.test.ts
```

结果：类型检查与 lint/format 检查通过；8 个测试文件、138 项测试通过。它们为现有行为基线，**不证明尚未实现的 Playground**。依赖由 pnpm 从本地内容存储准备，未改 lockfile。lint 首次输出被命令包装器错误解析，随后用 `rtk proxy pnpm run lint` 取得原始结果，两个 Biome 检查均成功且未修复文件。

没有启动 `serve`、没有调用 Telegram/真实 Provider/MCP，没有读取 `dev-data` 或密钥。未执行完整测试集、浏览器 E2E 与真实消息验收；仅文档修改不涉及现有前端行为。后续实施的必跑套件和手工步骤见 Epic。
