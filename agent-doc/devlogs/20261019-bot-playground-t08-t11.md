# Surowan - 20261019 Bot Playground T08–T11：生图输出、房间 API、Playground-only 与页面

## 背景

[Bot Playground Epic](../design/20261016%20Bot%20Playground%20Epic%20与实施交接.md) 的 T00–T07 已把宿主中立存储、虚拟交付、Context/准入投影、Hold/Release、执行隔离与本地媒体资产做完，但 Playground 仍只存在于测试里：没有写入口、没有页面、生图仍是 Telegram 专属、进程也只会以 Telegram 形态启动。本次按 Critical Path 依次交付 **T08 → T09 → T10 → T11**，每个任务一个提交，最后写这份组合交接。

任务边界（Epic 原文）：T08 生图 opt-in、回执与真实媒体输出；T09 Admin Playground API 与房间审计；T10 共存装配与 Playground-only 生命周期；T11 Admin 虚拟群聊页面。共同约束与 §3.1 的不变量 R01–R14 是验收口径，最后一节逐条对照。

开工前按「先确认前置任务验收」的要求检查了 T00–T07 的代码，发现并单独修复了一处缺口（见下）；其余前置接口按现状复用，没有另发明替代接口。

## 主要变更

### 0. 前置修复：房间输入消息没有 `current_revision_id`（`af1770c`）

`PlaygroundStore.submit` 写入了 `messages` 与首条 `message_revisions`，却没有回填 `messages.current_revision_id`（虚拟输出路径有，Telegram 路径有）。任何按 current revision join 的读者（T09 的 timeline、审计视图、`snapshotInvocation` 的 history 查询）都看不到房间输入。修复在同一个事务里补写指针，回归测试 `an admitted message points at its own revision`；T08 的一个测试助手因此改为只取 bot 消息（输入进入 join 后计数变化）。

### 1. T08 生图 opt-in 与虚拟图片输出（`c1f0f52`）

- **房间开关**：`rooms.image_enabled` 增加 `image_enabled_by` / `image_enabled_at`（迁移 `041`），`PlaygroundStore.setImageEnabled` 用 revision 守卫、记录操作者，值未变化时是 no-op（重试不会因自己造成的 revision 失败）。
- **按 Conversation 判定**：`ImageBridge.enabledFor(conversationId)` —— Telegram 跟随全局 `image` 配置，房间必须开关为真；`submit` 先判定位（旧 transcript 的直接调用也走这条），拒绝时**不创建** generation、long task、输入资产或文件。图片插件 `hosts` 扩到两个宿主，技能索引改为按 Conversation 过滤（`SkillVisibilityTarget`），`PLAYGROUND_PROFILE.hiddenSkills` 不再写死 `image-generation`。
- **配额顺序**：per-invocation 配额（3 次）改为在 core 创建（并入队）generation 之前判定，堵住「配额拒绝但生成已开始付费」的旧路径；`test/playground-image.test.ts` 的 `a quota refusal creates no generation and starts no provider call`。
- **结算一次**：`reconcile()` 不再把 queued/running 的 generation 结算成失败（旧代码会在重启对账时用「生成失败」完成等待中的任务，并让真实结果永远进不来）；`a running generation is not settled by reconciliation` 用 gate 固定该时序。
- **执行资格钩子**：`packages/image-service` 的 worker 接收 `executionEligibility`，作用于启动扫描、`enqueue`、领取以及中断恢复；bridge 的 reconcile 用同一判断。组合根按进程服务的宿主集合注入（`src/image/host-eligibility.ts`）。
- **虚拟图片输出**：Playground host 接受 `photo` / `photo_album`，按真实内容校验后复制进房间资产（`(chat, sha256)` 内容去重，多条消息可共享一个文件），message/revision/media 行与 `host_sends` 在同一事务提交；`imageDeliveryState` 的「已送达」判据改为 `COALESCE(telegram_message_id, message_id)`，Telegram 语义不变。
- **装配共享**：`src/adapters/local-monolith/host-tooling.ts` 收拢「宿主 profile + 插件 hosts + 生图桥按会话开关」的唯一判定，组合根与验收测试共用；`resolveConversation` 现在按会话行决定宿主；`BucketScheduler.nextDelayMilliseconds()` 公开以便直接断言「不忙等」。

### 2. T09 Admin Playground API 与房间审计（`a322645`）

- 新增 `src/ingress/admin/playground-admin.ts`：房间列表/创建（请求 key）、身份、Hold、原子 Release（revision + `through_seq` 边界）、保守 retry、timeline keyset 分页（含状态摘要）、Release 详情、能力开关、上传与内容读取、房间 scoped invocation 审计。全部仅面板 Session；带 `Authorization` 的请求在 Session 之前就被拒（程序化 key 权限面不变），`POST/PUT` 走既有 Origin 校验。
- 创建类写入用新表 `playground_mutations`（迁移 `042`，`(kind, room_chat_id, request_key)` 唯一）做幂等：同 key 同内容返回原结果，同 key 不同内容 409；消息/Release/retry 复用 T05 各自已有的 key 列。**key 先于 revision/through_seq 判断**，断线重试不会变成 409 或第二次运行。
- 嵌套 ID 全部按路径里的房间校验（跨房间 404/403 且无行变化），路径与 body 只接受规范十进制（无符号、无前导零、不超 int64）；`through_seq` 允许 0（空房间的 Release 边界）。
- `LongTaskService` 支持按宿主集合构造：带集合的实例只把集合内会话的到期 timer 视为到期（`processDue` / `nextDeadline` 同一条件），E2E 的房间运行时用它避免吃掉仿真夹具里的 Telegram 告警。
- E2E 夹具（`apps/admin-next/e2e/server.ts`）装配真实 `createCoreRuntime` + Scheduler + Playground host，模型用本地 faux 提供方并带脚本钩子；`20-playground.e2e.ts` 先落地 API 部分。

### 3. T10 共存装配与 Playground-only 生命周期（`4cb14f7`）

- `serve --playground-only`：不解析 Telegram token、不构造 Bot、不注册命令、不删 webhook、不启动 ingestion / Sticker 同步 / 生产 MCP / 启动追赶；`admin.enabled` 必须为真，否则启动即报错。其余生命周期完全一致（一个 ServeLock、`--takeover`、面板重启退出码 75、同一套优雅关闭）；`serve_started` 带 `mode: "playground-only"`，长进程等待点是关闭信号而不是 long polling。
- `AgentRuntime` 改为持有 **host 映射**：投递按 Conversation 的 `host_kind` 选宿主，缺项时明确失败，不会落到另一个平台。混合模式同时绑定 Telegram 与 Playground 宿主（房间沿用 Telegram bot 的显示名），Playground-only 只绑定房间宿主。
- **调度器作用域 = 运行时绑定宿主集合**：`InvocationQueueService` 的 recover、到期批次、receipt 投递、suppress 与 `BucketScheduler` 的启动候选、下一唤醒 deadline 都按同一子查询过滤；`LongTaskService` 的 timer 完成从一开始就同源。Playground-only 打开混合库时，Telegram 的 running/queued Invocation、Bucket 与到期 alarm 保持原样。
- 文档：`operations.md` 增加模式语义与配置限制（`telegram` 段仍是 schema 必需，E05 再精简）、`architecture.md` 写明 host 映射同时是调度范围。

### 4. T11 Admin 虚拟群聊页面（`c6a4c1b`）

- 新增 `apps/admin-next/src/pages/playground.tsx`、`routes/playground.tsx`（`?room=` 深链与校验）、侧栏入口与中英 locale（`locales/{en,zh-CN}/playground.ts`，键结构逐一对齐）；`routeTree.gen.ts` 由项目生成流程更新。
- 覆盖 MVP 操作面：建房（内联填身份）、身份创建/选择、时间线（Reply、静态图片上传与展示）、Hold 与 pending 计数、Release、运行列表（状态、用量、保守 retry）、Release 详情、生图开关（标注真实费用与操作者）、未挂消息上传的清理提示。
- 数据行为：每组请求 key 与草稿/房间 revision 绑定，**重试复用同 key**；拒绝不乐观显示为成功、保留草稿并展示服务端错误码；消息与状态分两条查询轮询，keyset 分页按 message id 去重并按房间序号排序；切房间清空草稿且所有查询按 room id 隔离；`completed` 但无发送的运行显示“已结束/未发送”，unsupported 媒体显示原因，不把私有 assistant 文本当群消息。所有控件有 label，窄屏堆叠。

## §3.1 不变量对照（T08 起适用）

逐条给出「满足 / 不适用」与证据（`文件:行` 或测试名）。

| 编号 | T08 | T09 | T10 | T11 |
| --- | --- | --- | --- | --- |
| R01 生产装配即验收 | 满足：`test/playground-image.test.ts` 用 `createImageService`/`createImageBridge`/`loadPlugins(BUILTIN_PLUGINS)`/`createHostTooling`/`createCoreRuntime` 与真实技能树跑完 generation→receipt→send；开工前 T07 的验收套件（`test/playground-media.test.ts`：房间图片进入模型、`read_image` 按 ref 且不访问 Telegram）全绿。 | 满足：`test/admin-playground.test.ts` 经真实 `AdminServer#handle` 路由 + 真实 ingress/资产库；E2E 夹具装配真实 Scheduler（`apps/admin-next/e2e/server.ts` 的 `createCoreRuntime`）并断言 Release 真实执行（`a Release runs the real scheduler and the room shows the bot output`）。 | 满足：`test/playground-only.test.ts:1` 经真实 `serve(..., { playgroundOnly: true })` + 本地 Responses API 夹具完成完整房间回合；`test/playground-only-serve.test.ts` 用真实 CLI 子进程验收启停。 | 满足：Playwright 页面用例驱动同一真实 E2E 后端（`20-playground.e2e.ts` 的建房→Release→回答用例）。 |
| R02 声明即生效 | 满足：开关翻转同时改变技能索引、prompt 文案、`execute` 注册表与提交判定（`the switch flips the skill index, the copied prompt, the registry and paid submission together`）；`image_enabled_by/at` 有读者（房间详情与审计）。 | 满足：`playground_mutations` 的每个 `kind` 都有写入路径与重放测试；能力开关的值未变化时 no-op（`flips the image switch with a revision and keeps it attributed`）。 | 满足：`hosts` 映射缺项有明确失败路径；`mode` 字段出现在 `serve_started` 并被测试断言。 | 满足：locale 键进 `resources.ts` 并被页面读取；`?room=` 有校验与恢复测试。 |
| R03 Host 隔离覆盖全部入口 | 满足：image 开关作用于插件 `hosts`、`capabilities()`、技能索引、旧 transcript 直接调用（`submit` 强校验）与 receipt 调度（`a foreign generation is never resolvable…`、`a room without the image switch…`）。 | 满足：房间 API 只写房间；`mixed room data does not break the existing Telegram-scoped lists` 断言既有 Telegram 列表 200 且不把房间当群。 | 满足：`a playground-only process runs the room round and leaves Telegram work untouched` 断言 running/queued Invocation 与到期 alarm 原样；`serve --playground-only` 子进程无 `commands_registered` / `startup_catch_up_completed`。 | 满足：页面只用房间 API；`01-routes` 的只读断言覆盖 `/playground`（加载不发写请求）。 |
| R04 拒绝不留状态 | 满足：关闭/配额拒绝不建 generation、task、资产或文件（`a room without the image switch…`、`a quota refusal…`）。 | 满足：被拒上传不落行不落文件、跨房间写入无行变化（`uploads a picture…`、`every nested id must belong to the room in the path`）。 | 满足：Playground-only 启动失败（缺面板）在取锁前返回，不产生任何数据。 | 满足：`a refused upload keeps the draft and shows the server reason`（服务端 422 文案 + 草稿保留）。 |
| R05 单个元素不绕过上限 | 满足：单张超限图片在房间资产库被拒（T07 的 `too_large`），T09 的上传端点沿用。 | 满足：`uploads a picture, serves its bytes and refuses what the store rejects` 覆盖单张 10 MiB+1。 | 不适用（无新上限）。 | 满足：超限/截断/动画的拒绝原因来自服务端（页面不做客户端预检替代）。 |
| R06 内容校验做到底 | 满足：房间图片走 T07 的完整解码校验（含 `acTL` 动画 PNG），T08 的图片输出同样经过该入口。 | 满足：上传路径复用同一校验，`uploads a picture…` 断言 422 `upload_<reason>`。 | 不适用。 | 满足：拒绝按服务端卡片/文案展示。 |
| R07 写路径按归属匹配 | 满足：`sendableOutputs` 按 `agent:<conversationId>` 授权；房间开关按房间读。 | 满足：`every nested id must belong to the room in the path`（release、sender、asset、room 四类）。 | 满足：recover/launch 的过滤条件同时匹配会话与宿主。 | 不适用（页面无新写路径）。 |
| R08 混合数据不让读路径出错 | 满足：Telegram 列表与审计在 PG 行存在时不变（既有套件 + T09 的混合用例）。 | 满足：`mixed room data does not break the existing Telegram-scoped lists` 覆盖 invocations/contexts/messages/chats/memories/overview/usage。 | 满足：Playground-only 与混合库共存的子进程用例。 | 满足：页面只消费 API DTO。 |
| R09 级联与保留不吞台账 | 满足：`message retention keeps the generation archive and an unhandled receipt`（消息被清理后 generation 与未处理 receipt 仍可查）。 | 满足：`playground_mutations` 随房间级联删除（`ON DELETE CASCADE`），release/retry 的 FK 行为未变。 | 满足：scope 过滤不清除任何行，只改变处理范围。 | 不适用。 |
| R10 文件生命周期与备份 | 满足：`message retention keeps the generation archive…`（共享文件在最后一个引用消失后才删除；生成原件不随房间保留清理；房间资产出现在备份的 `.images` 目录里）。 | 满足：暂存上传有清理窗口且状态可查（`staged_assets`）。 | 满足：`backupDatabase` 递归复制整个 `<data_dir>/images`（含房间资产与生成原件），复制不删除任何文件，因此运行中的上传/生成临时文件不受影响。 | 不适用。 |
| R11 幂等指纹覆盖全部语义字段 | 满足：`one tool call bills once; a conflicting replay of the same key is refused`（同 key 不同 prompt 冲突、重放不重复计费）；生图幂等 key 由运行时代入（`tool:<toolCallId>`，仅存在于图片幂等表）。 | 满足：T09 的 key 覆盖 sender/text/reply/asset（`admits messages under request keys…`），Release/retry 重放返回原结果（`holds, releases once per key…`）。 | 满足：过滤不改变幂等语义。 | 满足：`a lost response keeps the draft and the same key never admits twice`（路由拦下响应、重试复用 key、房间 pending 仍为 1）。 |
| R12 外部 ID 解析严格 | 满足：`asset_ids` 只来自会话授权 ref；`image_generation_id` 保持 UUID 形状约束。 | 满足：`refuses ids that are not canonical decimals`（错前缀/负数/前导零/超 int64）。 | 满足：CLI/子进程用例不引入新 ID 解析。 | 满足：`?room=` 只接受规范十进制，否则丢弃。 |
| R13 闸门与计量键一致 | 满足：房间回合的 agent 用量写 `daily_usage.scope = 'playground'`（`a generation finishes into a receipt…` 断言出现 playground、不出现 chat）；TG 生图的闸门键、用量与回执行为不变（`image-delivery*.test.ts` 全绿）。 | 不适用（未改模型调用路径）。 | 满足：混合模式宿主映射不改变 `invocationGateKey`/预算 scope（TG 套件全绿）；`a playground-only process runs the room round and leaves Telegram work untouched` 断言 TG 工作状态未被处理。 | 不适用。 |
| R14 交接与测试可核对 | 本表即交接；测试名的断言与实际覆盖一致（如 `a receipt queued behind a full concurrency never makes the scheduler spin` 断言 `nextDelayMilliseconds() > 1000`）。 | 同左；被改动的既有测试：迁移版本 pin（041/042）、房间图片助手只取 bot 消息、Playground 运行时/帮助器的 `host` → `hosts`（API 迁移，非语义放宽）。 | 同左；`test/playground-only.test.ts` 的断言逐条对应上面 R01/R03/R10/R13。 | 同左；`01-routes` 新增 `/playground` 用例只增不减。 |

## 验证

```bash
pnpm test
# Test Files  125 passed (125)
# Tests  1525 passed (1525)

pnpm run check          # 通过
pnpm run lint           # biome lint/format 通过（lint --write --unsafe + format --write 仅自动格式化）
git diff --check        # 通过

pnpm run admin:build && pnpm run admin:test:e2e 20-playground          # 12 passed
pnpm run admin:test:e2e 00-auth 01-routes 02-lists-filters 03-invocation-detail 04-writes 05-readonly-security 06-trust-boundary 13-sender-ids
# 81 passed
```

任务级证据（都能在提交里核对）：

- T08：`test/playground-image.test.ts`（11 例，含 R01 链路、`a receipt queued behind a full concurrency never makes the scheduler spin`、`a standalone process never executes or recovers work of a host it does not serve`）；`image-*` 套件与迁移 pin（041）。
- T09：`test/admin-playground.test.ts`（9 例）+ `apps/admin-next/e2e/20-playground.e2e.ts` 的 API 部分；`test/long-tasks.test.ts` 的 `a single-host instance completes only its own timers`。
- T10：`test/playground-only.test.ts`、`test/playground-only-serve.test.ts`；既有 Telegram 套件（`image-startup`、`runtime-host`）继续通过。
- T11：`20-playground.e2e.ts` 12 例、`01-routes` 新增用例、`04-writes`、`06-trust-boundary`。

## 未覆盖

- **真实 Telegram**：本次没有连接真实 Telegram 群验证文本/Reply/Topic/编辑/Sticker/图片与 pause/startup（Epic T12 的人工矩阵项）。Telegram 路径的行为合同由 T00 的既有套件与 `git diff` 范围约束：本组改动未触碰 Telegram prompt、工具文案、发送规则或闸门键。
- **真实生图 Provider**：图片链路全部走 fake provider（返回真实 PNG 字节），没产生真实费用，也没有验证上游模型质量。页面上的「已开启（真实计费）」文案与 API 语义已经就位，T12 在授权 Provider 上做一次真实生成即可。
- **真实模型理解**：房间回合用的模型是本地 fixture/faux（faux 或 Responses-API 夹具），只证明运行时与工具链，不证明真实模型的参与倾向与图片理解。
- **E05 的配置精简**：Playground-only 仍需 schema 合法的 `telegram` 段（占位 SecretRef 不必可解析），这是当前 schema 限制而不是房间配置。
- **迁移回滚**：迁移 041/042 只向前；按仓库规则，需要回滚时用迁移前备份或 forward fix。

## 提交

```txt
c1f0f52 Add room image opt-in and virtual picture output        # T08
af1770c Point an admitted room message at its own revision      # T05 前置修复
a322645 Add the Admin Playground API and room audit             # T09
4cb14f7 Add a Playground-only lifecycle and one host set for the scheduler  # T10
c6a4c1b Add the Admin Playground page                           # T11
```

后续任务（T12 及 P1/P2）可直接依赖的接口：`ImageBridge.enabledFor`、`PlaygroundStore.setImageEnabled/listRooms/timeline/releaseDetail/roomInvocation`、`createHostTooling`、`AgentRuntimeOptions.hosts`、`serve(configPath, { playgroundOnly })`、`/api/playground` 端点表与 `20-playground.e2e.ts` 的夹具钩子（`/playground-seed`、`/playground-model`）。

## 评审修复（追加）

T11 提交后对 `7d293d2..c6a4c1b` 跑了一轮 open-code-review（48 个文件，28 条意见，无 critical）。高危和中危的意见逐条对照源码核实，修复分三个提交；低危的没有处理。

### 勘误

上面的不变量对照表里有几处说法和代码不符，以本节为准：

- **R03 / R13（T10）**：原文说「Playground-only 进程不碰 Telegram 工作」，实际并不成立。生产组合根的 `LongTaskService` 没有带作用域，所以房间进程照样会完成 Telegram alarm、生成 receipt。`servedHosts` 写死为两个宿主，生图 worker 会去执行或恢复 Telegram 的 queued generation。recover 的陈旧 Bucket 清扫、launch 时的睡眠跳过和回执压制也都没有过滤宿主。`a playground-only process runs the room round…` 没发现这些问题，原因有二：一是 `/api/alarms` 会把「task 已完成、receipt 仍 pending」的 alarm 也显示成 `pending`；二是种子数据没有陈旧 Bucket、睡眠窗口或 claimed 回执。
- **作用域 timer 的 receipt**：`LongTaskService.processDue` 带作用域的 raw SQL 把列名读成了 `timerResultJson`，但实际返回的是 `timer_result_json`，结果 receipt 的 `result_json` 被写成 null。`a single-host instance completes only its own timers` 没有断言 receipt 内容，所以没抓到。
- **T11 数据行为**：原文说「消息与状态分两条查询轮询」，实际只有状态在轮询，时间线不会自动刷新。原文说「切房间清空草稿」，实际只有点击切换会清空，浏览器前进/后退不会。
- **验证计数**：原文 `00-auth … 13-sender-ids` 记为 81 passed，按当前代码这 8 个套件一共 77 例（这三个提交没有删除其中任何用例），以下文的验证结果为准。

### 修复

**`0a70944` 宿主作用域（高危）**

- `servedHosts` 改为按模式取值：Playground-only 只有 `['playground']`。生图执行资格、`LongTaskService` 和 `previewContext` 共用这一个集合。
- `createCoreRuntime` 的默认 task service 带上运行时绑定的宿主集合。如果外部传入的 `LongTaskService`（新增 `hosts` getter）作用域和运行时不一致，直接抛错，防止再次漏配。
- 作用域 timer 查询加上 `AS timerResultJson` 别名。
- `InvocationQueueService` 的 recover 过期清扫、`suppressInvalidQueuedReceipts`、`skipQueuedInvocations` 都加上 `#servedConversations` 过滤。`PlaygroundStore.expireQueued()` 只在调度器服务房间时才执行。
- `previewContext(hostKind)`：Playground-only 进程按 `playground` 宿主校验工具注册表。原来 `validateAdditionalTools` 取不到 Telegram 宿主会抛错，导致每次「应用配置文件」和 `/model` 都报 `model_unusable`。

**`b264459` 后端 API 与投递（中危）**

- timeline 每页只查一次媒体，按 `messageId` 分组，并且只取当前 revision 的媒体。原来每条消息都挂着整页的图片。
- 新增 `PlaygroundStore.roomSummary`。建房重放和 `GET /rooms/:id` 都返回真实计数器，原来重放时一律是 0，详情页也没有 queued/running。
- 路径和查询参数里的 ID，以及能力开关的 `revision`，统一走 `canonicalId`：19 位但超出 int64 的值在查询前就返回 400。
- 消息请求体上限改为 `16_384 × 6 + 8 KiB`，16K 个 CJK 字符或 `\uXXXX` 转义的合法文本都能送达。
- 消息重放先于资产解析：`PlaygroundStore.replaySubmission` 直接用 key 自己的 tombstone 回答。幂等指纹改为按调用方给的 `asset_ids` 计算（同一个 asset id 只对应一个房间里的一份内容）。同时删掉了生产里没有调用方的 raw `attachments` 入口，相关测试改为先上传再引用。
- Release 边界改用新增的 `RoomState.latestInputSeq`（API 字段 `latest_input_seq`）。中途落库的 Bot 输出会推进 `next_seq`，但不再误报 `release_conflict`。
- retry 的 attempt key 绑定到 Release：同一个 key 用在别的 Release 上返回 409 `input_conflict`，不再把第一个 Release 的结果当成重放返回。
- 生图配额判定前先查幂等 key（`generations.createKeyUsed`）。到达上限后，重放已经接受过的 tool call 会返回 `replayed`，不再抛 `TaskQuotaError`。
- Playground host：相册在写入前整组校验（新增 `PlaygroundAssetStore.validate`）。`ingest` 返回 `created`，没有发布成功的投递会用 `discard` 回收自己新建的资产（内容去重命中的旧资产不动）。复制前后各检查一次 `signal`，取消时返回 `aborted` 且 `outcomeUnknown: false`。

**`cd6c89c` 页面（高危 1 条，其余中危）**

- 时间线开始轮询；打开的 Release 详情在还有 queued/running attempt 时轮询，重新打开或 retry 成功后都会失效重取。
- 房间工作区抽成 `RoomWorkspace key={roomId}`：草稿、身份选择、上传回调和请求 key 都只属于一个房间，点击切换和浏览器前进/后退的行为一致。
- 请求 key 改为 `usePayloadKey`：同一个 payload 复用同一个 key，换了 payload 就换新 key；key 是不透明 UUID，不再拼入身份名。4xx 视为服务端已明确拒绝，释放 key；网络错误或 5xx 视为结果未知，保留 key，并把草稿锁定为那次的 payload，直到重发确认，或者用户显式选择「改为编辑新消息」。发送过程中锁定草稿和附件，上传未完成时不能发送。
- retry 按新的 `release_id` 寻址，`attempt_key = retry-of-<invocationId>`，断线后再点会重放原来那次重试。建房、建身份和 retry 失败时都会提示服务端返回的原因。
- 文档：`admin-panel.md` 的 Playground 端点表和 `operations.md` 的 Playground-only 段落已同步上述字段和语义。

### 验证

```bash
pnpm test                                   # 125 files, 1532 passed
pnpm run check                              # 通过
pnpm run lint                               # 通过
git diff --check                            # 通过
pnpm run admin:build && pnpm run admin:test:e2e   # 全量 172 passed（20-playground 15 例）
```

新增或加强的断言都回退过实现代码，确认能在旧代码上复现原故障：

- `test/playground-only.test.ts`：种子补上陈旧 Bucket、claimed 回执、睡眠窗口和到期 alarm。进程停止后直接读台账，断言 `long_tasks`、`task_receipts`、`buckets`、`invocations` 都没变；在运行中的房间进程上应用配置应返回 `applied`。旧代码上依次失败于 `skipped_budget` 和 422。
- `test/long-tasks.test.ts`：作用域 timer 的 receipt `resultJson` 必须等于原 timer 结果。旧代码上得到的是 null。
- `test/admin-playground.test.ts`：新增 6 例（重放计数器、字符上限、Bot 输出不推进边界、attempt key 绑定 Release 和 `release_id`、timeline 媒体归属、清理后的重放），超 int64 的 ID 用例并入既有测试。旧代码上全部失败。
- `test/playground-image.test.ts`：到达配额后重放已接受的调用返回 `replayed`，不新增 generation、task 或 provider 调用。
- `test/playground-delivery.test.ts`：坏相册、复制途中取消、已经取消三种情况都不留资产行和文件。
- `20-playground.e2e.ts`：新增前进/后退不串草稿、带空格或 CJK 字符的身份名、建房被拒时提示原因三例。用旧页面跑时三例全部失败。

### 仍未覆盖

- 时间线和 Release 详情轮询的实际刷新效果，只有「建房 → Release → 回答」这条 e2e 间接覆盖；queued/running 计数器只在 API 层有断言。
- `servedHosts` 对图片 worker 的收窄没有端到端用例，只有 `generationEligibilityForHosts` 的单元覆盖和组合根代码审查。
- 「结果未知时锁定草稿」的交互只验证了重发这条路径（`a lost response…`），「改为编辑新消息」按钮没有 e2e 用例。

### 提交

```txt
0a70944 Scope Playground-only timers, recovery and housekeeping to its hosts
b264459 Fix Playground API replays, boundaries and picture delivery cleanup
cd6c89c Key the Playground workspace by room and retry runs by their release
```

接口变化（供 T12 及以后的任务参考）：`RoomState.latestInputSeq` / `latest_input_seq`、`RoomInvocationSummary.releaseId` / `release_id`、`PlaygroundStore.roomSummary` / `replaySubmission`、`PlaygroundAssetStore.validate` / `discard`（`ingest` 返回 `created`）、`LongTaskService.hosts`、`previewContext(hostKind)`、`generations.createKeyUsed`；`PlaygroundIngress.submit` 不再接受 `attachments`。
