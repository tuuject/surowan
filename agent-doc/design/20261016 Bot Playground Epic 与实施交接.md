# Epic: Bot Playground & Minimal IM Host Abstraction

日期：2026-10-16。调查基线：`a509b0637335c495fbb408d5d42b6cec0ff33472`。

配套：[Current Architecture Investigation](20261016%20Bot%20Playground%20调查报告.md) · [Architecture Decision Proposal / Open Questions](20261016%20Bot%20Playground%20架构方案.md)。本次只交付规划；下列任务全部待实施。

下文 PG 指 Playground，TG 指 Telegram。

## 1. 交付标准与拆分原则

第一个可运行 MVP：管理员可在无需 Telegram 连接的 Admin 页面创建虚拟群、用多个身份发送文本和静态图片、建立 Reply、Hold 攒批、Release 进入真实 Scheduler/AgentRuntime、看到真实 send 输出与错误；打开明确的生图授权后可看到真实媒体输出。所有 IM 输出只回虚拟群，默认不能触发 Alarm/MCP/辞典写/全局休眠。

每个任务应成为一个可单独验收的提交。前置接口必须由其所有者先交付；下游不要自己发明替代接口。中途始终保持 Telegram 可运行；只在最后装配完隔离策略后开放 Playground 写入口。不要为了赶 UI 进度把 mock loop 当 MVP。

任务中的“新增”文件名是交接建议，尚不存在；实施时可沿已有组织微调，但 PR 必须记录对应关系。现有文件使用源码真实路径。新增 migration 使用当时下一个编号，不锁死为本调查时的下一个版本。

## 2. 依赖图与 Critical Path

| 编号 | 优先级 | 独立交付内容 | 前置 |
| --- | --- | --- | --- |
| T00 | P0 | Telegram 行为合同与最小 Host 契约 | 无 |
| T01 | P0 | Telegram 发送/activity 传输边界提取 | T00 |
| T02 | P0 | 双 Host 身份存储与既有读取兼容 | T01 |
| T03 | P0 | 共同发送台账、虚拟交付与去重 | T02 |
| T04 | P0 | Context 输入投影、执行身份和准入策略 | T02、T03 |
| T05 | P0 | 持久化 Hold/Release 与安全重试 | T04 |
| T06 | P0 | 工具、副作用、预算和后台任务隔离 | T04、T05 |
| T07 | P0 | 本地静态媒体输入、读取与保留 | T02、T04、T06 |
| T08 | P0 | 受控生图与虚拟媒体输出 | T03、T05、T06、T07 |
| T09 | P0 | Admin Playground API 与 scoped 审计 | T05、T06、T07、T08 |
| T10 | P0 | 共存装配和 Telegram-free 启停 | T06、T08、T09 |
| T11 | P0 | Admin Playground 页面 | T09、T10 |
| T12 | P0 | 跨链路验收、故障矩阵与用户指南 | T00–T11 |
| E01 | P1 | 可选 Telegram 节拍/热注入仿真 | T12 |
| E02 | P1 | 场景 seed、导出、复制与重建 | T12 |
| E03 | P1 | 受控只读 MCP、辞典与本地 Sticker | T12 |
| E04 | P1 | 单场景程序化 Eval 驱动 | E02 |
| E05 | P1 | 无 Telegram 节的精简配置 | T10、T12 |
| X01 | P2 | 具体下一平台的能力差异验证 | T12，另行指定平台 |
| X02 | P2 | 高级 Eval 编排与评分 | E04，独立产品授权 |
| X03 | P2 | 虚拟时钟与可控延迟任务实验 | E01、E04 |

**最短安全实施顺序：T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12。** 这是单 Agent 可直接按顺序执行的 Critical Path；没有把 P1/P2 放成前置。

T05 后能用测试驱动文本闭环，但不能称为面板 MVP。T09 后是 API 里程碑；T11 后首次可人工操作完整 MVP，T12 是合并/发布验收门。T07 的媒体工作可在依赖满足后与无关的 API 只读 DTO 工作分开实施，但不是交付授权下的并行 Agent 指令。

## 3. Implementation Handoff：统一交接合同

Coding Agent 接任务时只需读根 `AGENTS.md`、对应主题文档、本任务、架构方案涉及的小节与列出的源码，不默认遍历旧设计/devlogs。用户明确要求实施本 Epic 后，才执行下列改动。

每次开工先记录 working tree 与 commit；已有用户改动不得覆盖。提交前输出：实际改动文件、行为变化、数据库/配置影响、通过的测试、未做的真实环境检查、风险和下一任务可依赖的接口。失败测试不能用改低断言或跳过来消除。

共同约束：

- Node 可擦除 TypeScript、同步 Drizzle/IMMEDIATE transaction、边界 TypeBox、bigint/string ID、SecretStore 脱敏。
- 不读 `key.json`；不启动真实 Bot 验证虚拟发送。测试使用临时目录和已有 Faux/provider fixtures。
- 共享接口切换所有调用方，删除旧执行路径；不保留假 ID 模式、production fallback 或双写台账。
- migration 与 schema 同提交，空库/升级/备份恢复同验收；迁移后回滚只能停机恢复迁移前备份或 forward fix，不能仅换回旧 binary。
- 所有代码任务至少运行受影响测试、`pnpm run check`、`pnpm run lint`、`git diff --check`；跨模块最终跑完整 `pnpm test`。lint 修复按仓库规则，但不得混入与任务无关的重构。
- 任何 Admin 前端/API/locale 变化必须运行相关真实 Admin E2E，不能用 Vitest 代替；先 `pnpm run admin:build`，再 `pnpm run admin:test:e2e <suite>`。
- 新时间测试采用一个固定虚拟时钟或全部从当前时钟推导；异步竞态用明确 gate/barrier，不依赖短 sleep 或固定“未来”日期。

### 3.1 T00–T07 回顾得出的共同不变量（T08 起适用）

T00–T07 经两次独立实现与 review，重复出现的缺陷归纳为下列不变量。T08 起每个任务的「补充验收」列出相关条目；交接报告逐条写「满足 / 不适用」，满足的附测试名或 `文件:行`。

开工前先确认前置任务的验收在当前代码上按 R01 成立；不成立时先修，单独提交并在交接中注明，不在下游任务里绕过或重新发明。

| 编号 | 不变量 | 最低证据 |
| --- | --- | --- |
| R01 | **生产装配即验收对象**：验收场景用组合根（`runtime-host.ts` 的真实装配）产出的 Runtime、profile 与依赖运行。测试里手动注入 loader、工具或依赖只证明单元行为，不算验收。 | 至少一个测试经真实装配函数构造 PG Runtime 并走完本任务验收链路 |
| R02 | **声明即生效**：新增的 profile 字段、能力开关、配置项必须有读者；状态枚举的每个值都有写入路径。 | 翻转字段后行为变化的测试；每个状态值至少一个到达它的测试 |
| R03 | **Host 隔离覆盖全部入口**：一项能力对 PG 的开关同时作用于 system prompt 文案、Skills 索引、工具注册、`execute` search/help/call、context injector、后台任务/receipt 与 Scheduler 唤醒。 | 按入口逐一断言，含旧 transcript 直接调用；不只断言工具列表 |
| R04 | **拒绝不留状态**：校验失败、409、超限、未授权等拒绝返回后，不留下行、文件、ref、checkpoint、计数或 staged 资产。先校验、先量容量，后分配、后写入。 | 拒绝前后相关表行数与目录文件列表相等 |
| R05 | **单个元素不绕过上限**：长度、字节、像素、条数上限对第一个或唯一一个元素同样生效，不写「至少放进一个」的特例。 | 单个超限元素的拒绝测试 |
| R06 | **内容校验做到底**：图片校验完整解码像素并拒绝动画；只读 header/metadata 不算校验。 | 探针含头部完整而像素截断的 PNG、APNG（`acTL`）、动画 WebP/GIF |
| R07 | **写路径按归属匹配**：接收内部 ID 的写、删路径（含既有 Admin 端点）在同一条件里同时匹配 ID 与所属 room/Conversation/Host；只按 ID 匹配视为跨房间写。 | 跨 room ID 的写/删返回 404/403 且无行变化 |
| R08 | **混合数据不让读路径出错**：既有只读 API、审计列表与详情、快照解析（含 GC 与缓存恢复后的重建）在含 PG 行的库上不 500，也不按 Telegram 数字格式解析而丢字段。 | 每种新 PG 行进入一次既有列表/详情端点的混合 fixture |
| R09 | **级联与保留不吞台账**：保留期清理与 FK 删除行为不得静默删除台账、回执、审计行；需要终态的行先写终态再删关联消息。migration 里的 FK 与 `schema.ts` 声明一致。 | purge 后台账仍可查询且状态正确；新增 FK 写明删除行为 |
| R10 | **文件生命周期与备份**：新增本地文件目录进入备份与恢复；清理只删确认无行引用的文件，并以条件删除先认领行再删文件，不能被并发上传或重新引用插入；备份不删正在写入的临时文件。 | 备份恢复后可读；共享文件的引用计数测试；清理与上传的并发测试 |
| R11 | **幂等指纹覆盖全部语义字段**：request key 指纹包含 body 中所有影响结果的字段（文本、asset、reply ref、sender 等）；同 key 重放 Release/retry 返回原结果；runtime 自动生成的 key 与客户端 key 不同命名空间，冲突返回稳定错误而非 SQLite 异常。 | 只换一个字段的同 key 请求得 409；重放不产生第二次模型调用 |
| R12 | **外部 ID 解析严格**：HTTP 与模型可见 ref 的解析区分 kind 前缀；十进制 ID 只接受 safe/int64 规范形式（无前导零、无符号、不超界）。 | 错 kind、前导零、超界、负数的拒绝测试 |
| R13 | **闸门与计量键一致**：同一 TG 群的 Agent、Vision、replay、生图等模型调用沿用基线闸门键与 usage scope；PG 一律带 Host 范围。新增模型调用路径时写明它使用的闸门与计量 scope。 | TG 闸门键与 usage 行和 T00 合同对比无差异 |
| R14 | **交接与测试可核对**：交接里的每条行为声明附测试名或 `文件:行`；测试名声称覆盖的内容必须有对应断言，不用 `void x` 之类占位；改动既有测试时说明是 API 迁移还是语义变化，不放宽断言。 | 评审能逐条复核；既有断言没有被弱化 |

## 4. P0 任务

### T00 — 固定 Telegram 行为合同和 Host 输入输出边界

**目标与范围**：建立后续迁移可比较的基线；只提取两个 Host 已需要的类型，不改变生产行为。

**涉及模块/文件**：现有 `test/runtime-host.test.ts`、`test/context-hot-inject.test.ts`、`test/context-send.test.ts`、`test/send-reply.test.ts`、`test/reply-dedup.test.ts`、`test/runtime-config-snapshot.test.ts`；新增建议 `src/platform/im-host.ts`、`test/im-host-contract.test.ts`。

**前置依赖**：无；确认架构提案采用的 MVP 调度默认值。

**具体步骤**：

1. 在已有 fixture 中固定相同输入的 prompt、冻结消息、reply/uid、send request、工具注册、审计状态与 Context 序列；只补关键合同，不复制全部测试。
2. 定义内部 Chat/Conversation/Sender ID 与模型可见 ref 的区别，写清现有 `chatId` 的 Telegram 含义及迁移目标。
3. 定义绑定目标的 delivery/activity 与 conversation policy 值；不在叶子模块放查询或 IO。
4. 明确 Telegram 原 prompt/工具参数/返回错误合同由哪一侧继续生成；记录 Host 无能力时必须拒绝的结果。

**验收标准**：契约能表示 Telegram 与本地虚拟目标且没有 grammY 类型；现有 Telegram 测试无行为 diff；没有接入新页面或新执行器。

**必要测试**：上述现有套件；新增契约只验证跨 Host/opaque ref/unsupported 行为，不写只断言 TypeScript 属性存在的测试。

**不在范围**：统一所有消息类型、协议版本协商、完整 Adapter SDK。

**风险与回滚**：把平台字段偷偷带进通用接口会固化耦合；本任务无数据变更，可直接撤回类型与新增测试提交。

### T01 — 提取 Telegram delivery 与 activity 实现

**目标与范围**：让 `AgentRuntime` 不直接持有 `TelegramSendApi`、grammY 错误或 `MentionTyping` 类；保留完整发送业务规则。

**涉及模块/文件**：`src/capabilities/send-tool.ts`、`telegram-send-api.ts`、`typing.ts`、`mention-typing.ts`；`src/orchestration/agent-runtime.ts`、`runtime.ts`；`src/adapters/local-monolith/runtime-host.ts`；新增建议 `src/adapters/local-monolith/telegram-host.ts`。

**前置依赖**：T00。

**具体步骤**：

1. 将 Telegram 参数/响应映射、mention entity、429/5xx/网络错误分类、typing 刷新实现放到 Telegram Host 边界。
2. 把调用目标绑定为 server-resolved Conversation，工具不接收任意平台目标。
3. 共用 `createSendTools` 保留输入校验、授权、barrier、多 part、限流和结果状态；传输接受/未知/拒绝有显式结果。
4. 改 Runtime/sceneToolDefinitions/registry validation/组合根及测试调用方，删除旧构造入口。

**验收标准**：Telegram 相同 tool input 产生相同 API request、消息文本与审计；错误/429/部分发送行为不变；Runtime 无 grammY/TelegramSendApi/MentionTyping 类依赖。此时只注册 Telegram 实现。

**必要测试**：`test/context-send.test.ts`、`send-reply.test.ts`、`reply-dedup.test.ts`、`typing.test.ts`、`image-delivery.test.ts`、`context-hot-inject.test.ts`、`runtime-host.test.ts`；跑 check/lint。

**不在范围**：更改发送相册表示、TG 工具文案、重试策略或 reply 规则。

**风险与回滚**：不要把 accepted-but-not-recorded 改成可重试 error；不新增 migration，可整体回退该边界提交。

### T02 — 为虚拟身份加入最小共享存储支持

**目标与范围**：共享 Message/Context 的内部主键，允许无 Telegram ID 的真实虚拟行，既有面板读取不报错。

**涉及模块/文件**：`src/store/schema.ts`、`migrations/`、`store.ts`；`src/ingress/telegram-ingestion.ts`；`src/ingress/admin/audit.ts`、`memory-admin.ts`、`invocation-media.ts`；`src/context/scene-context.ts`；`src/orchestration/replay.ts`；相关直接 schema 调用方；`agent-doc/data-layer.md`。

**前置依赖**：T01。

**具体步骤**：

1. 加 `host_kind`、条件式 Telegram metadata 约束，保持旧行和旧 ID；新增 room/participant membership 扩展表，但暂不开放写 API。
2. Telegram upsert 始终写/校验 Telegram 身份。PG sender 必须归属虚拟房间，不用 ID 符号判群类型。
3. 盘点所有 nullable 列读取；Telegram 审计、cutoff、replay、memory Chat picker、migration 查询显式限制 Host，或在通用读边界处理类型。
4. 新增 snapshot format 标识，旧快照只补 format，不改 JSON 内容；增加 P0 后续所需的本地 reply/顺序扩展字段。
5. 调整 retention 的 sender/room/FK 处理，保留映射完整性。对收缩/重建表验证索引和 FK，不关闭约束蒙混升级。

**验收标准**：旧库升级后消息数、ID、revision、Context、Telegram DTO不变；同库可插入没有任何 Telegram ID 的虚拟房间/身份；现有只读 API 接触混合数据不出现 500，也不把虚拟行当真实群管理。

**必要测试**：`test/schema.test.ts`、`store-boundary.test.ts`、`telegram-ingestion.test.ts`、`scene-retention.test.ts`、`replay.test.ts`、`admin.test.ts`、`admin-invocation-media.test.ts`；新增升级/混合 Host fixture；相关 E2E `01-routes`、`02-lists-filters`、`13-sender-ids`、`05-readonly-security`。

**不在范围**：永久通用外部地址库、自动迁入任何真实聊天历史、修改 Telegram API key 的权限。

**风险与回滚**：最高风险是 SQLite 表重建和漏掉隐式 Telegram 假设。回滚恢复迁移前备份；不提供旧代码读新混合 schema 的隐藏兼容层。

### T03 — 统一发送审计并实现本地虚拟交付

**目标与范围**：在同一 `send/send_reply` 管线支持虚拟输出，保留一套去重与发送台账。

**涉及模块/文件**：`src/capabilities/send-tool.ts`；`src/store/schema.ts`、`migrations/`、`image-delivery.ts`、`store.ts`；`src/ingress/admin/audit.ts`；`src/context/scene-context.ts`；新增建议 `src/adapters/local-monolith/playground-host.ts`。

**前置依赖**：T02。

**具体步骤**：

1. 一次迁移把 `telegram_sends` 切到 `host_sends`，保留原主键、FK、索引、未知状态与原 response metadata；切换全部查询。
2. Telegram 公开审计 DTO 用原契约投影；现有 slice replay 仍只处理 Telegram sends，PG 调用明确 unsupported。
3. 实现绑定虚拟目标的 delivery：按发送审计 ID 幂等，将出站 Message/Revision、媒体关联、成功审计原子写入；普通 assistant text不落聊天消息。
4. 共享 reply 去重/限流用内部作用域，拒绝跨房间目标、过期 capability、未知 Host。
5. 支持本地 activity 到期/清除，成功输出立即可被同 Conversation 后续 Context看到。

**验收标准**：fake Provider 经真实 `send/send_reply` 产生有审计的虚拟消息；重复 delivery key 不重复发；同名房间不串群；真实 Telegram API spy 为零；TG 合同不变。

**必要测试**：`test/context-send.test.ts`、`send-reply.test.ts`、`reply-dedup.test.ts`、`image-delivery.test.ts`、`invocation-search.test.ts`、`scene-slice.test.ts`、`replay.test.ts`；新增建议 `test/playground-delivery.test.ts`；相关审计 E2E `03-invocation-detail`、`05-readonly-security`。

**不在范围**：任意文件发送、新 Sticker系统、自动重发 unknown、改变 TG 相册只记首条的现状。

**风险与回滚**：遗失旧去重记录会重复回复；迁移需逐项对比发送记录与索引。回滚恢复备份，虚拟入口仍未上线。

### T04 — 把 Context 与执行准入改成绑定 Host 的投影

**目标与范围**：真实 Runtime 能运行虚拟 Conversation，Telegram 的 prompt、ID显示、配置与预算行为保持原样。

**涉及模块/文件**：`src/context/context-builder.ts`、`context-refs.ts`、`context-injector.ts`、`context-codec.ts`；`src/platform/invocation-context.ts`、`agent-protocol.ts`；`src/store/invocation-snapshot.ts`；`src/orchestration/agent-runtime.ts`、`invocation-queue.ts`、`scheduler.ts`、`runtime.ts`；两个 Host 实现。

**前置依赖**：T02、T03。

**具体步骤**：

1. 两种显式快照格式校验后映射为中性 Message view；Telegram renderer保持原文本，PG 使用自己的 host wording。
2. 通用 Context 使用内部 Chat/Sender scope，visible ref 与内部授权目标分离；Telegram Alarm/辞典等既有工具在 Host 边界获得原 Telegram target，不能把内部 ID 当平台 ID。
3. 从核心移走直接 `resolveChatConfig`、`config.telegram.bucket_window_seconds` 读取，改用固定 Invocation policy；TG policy 复用原解析和窗口。
4. `createCapabilityResolver` 支持 opaque reply ref，并返回授权的内部 Message/Conversation 目标；TG格式验证在 TG侧。
5. 模型 gate 的键包含明确 Host/内部 scope；replay/Vision 与 TG正常 Agent继续共享同一个TG闸门。
6. `renderInjection` 对PG支持“全部新消息或明确拒绝”，在新引用注册和 canonical append 前判定容量，不能只看 API字节限制；拒绝时不留下checkpoint或已注入标记。

**验收标准**：多虚拟用户名称/稳定ref进入真实Provider请求，reply正确；不会访问`telegram.chats`查PG配置；TG稳定prompt hash不变；GC/header一致性和引用TTL不变。

**必要测试**：`test/context-store.test.ts`、`context-gc.test.ts`、`context-hot-inject.test.ts`、`context-send.test.ts`、`scene-context.test.ts`、`runtime-config-snapshot.test.ts`、`alarm.test.ts`、`dictionary-runtime.test.ts`；新增建议 `test/host-context.test.ts` 覆盖 opaque ref、跨群、超长整批拒绝与持久状态。

**不在范围**：全文重写 Core Protocol、多IM通用 prompt语言、改变TG历史排序或截断契约。

**风险与回滚**：最危险的是内部/外部ID混用或prompt变化重建所有Context；用TG原输入/输出合同对比。代码回滚前保持PG入口关闭；涉及schema则使用T02/T03备份。

### T05 — 持久化 Hold / Release、排队与保守重试

**目标与范围**：建立恰好一次接纳的输入台账和明确的失败语义，复用唯一 Scheduler。

**涉及模块/文件**：新增建议 `src/ingress/playground.ts`、`src/store/playground.ts`；现有 `schema.ts`、`migrations/`、`invocation-snapshot.ts`、`store.ts`；`src/orchestration/invocation-queue.ts`、`scheduler.ts`、`agent-runtime.ts`；`src/startup-catch-up.ts`。

**前置依赖**：T04。

**具体步骤**：

1. 实现输入 request key、内容指纹、严格递增序号、room revision、release key与membership；room持久化序号高水位，retention后不复用旧序号；所有引用验证和写入在同一事务。
2. 从既有 `#insertInvocation` 提取共用enqueue入口；Telegram `#queueBucket`仍走原规则，PG提交sealed queued Bucket，禁止直接调Runtime。
3. Hold默认开启；每次输入递增room revision。Release校验revision及最新`through_seq`，释放全部pending并关闭Hold；并发输入先到则409并保持Hold，后到则进入下一自动批次；empty只改变模式。
4. PG history按 admission 与本次boundary过滤；显式排除held/未来输入；TG startup catch-up、send barrier查询限定对应Host/policy。
5. 多release queued按接纳顺序执行；同Conversation running唯一、同Chat串行、全局额度不变。调整 next deadline查询，不能因一堆queued工作busy-loop。
6. 安全retry只允许零注入/零模型请求/零副作用且已终止的attempt；同房间已有更晚的Release/receipt则拒绝。否则从原冻结快照创建新Invocation，记录key与关联，拒绝active/unknown/部分执行，不能吸收仍held的输入。
7. 处理重启、超过五分钟queued过期、pending在线保留过期；状态必须可查询，绝不默默重新释放。

**验收标准**：Hold数据不会通过任何输入通道进入模型；重复POST/Release最多一次接纳；每个非空release一openingInvocation；运行中Release排队；失败记录和输入仍可追踪；模型成本和side effect不被重复提交隐式重放。

**必要测试**：新增建议 `test/playground-ingestion.test.ts`、`test/playground-scheduler.test.ts`；真实Scheduler + Faux + DB断言覆盖本文件验收矩阵V02–V10；重跑 `scheduler.test.ts`、`context-hot-inject.test.ts`、`startup-catch-up.test.ts`、`task-hot-injection.test.ts`。

**不在范围**：TG pacing仿真、PG热注入、自动拆批、自动恢复已执行模型、任意Context回滚。

**风险与回滚**：事务提交后、HTTP返回前断线是主要幂等风险；send barrier与history为主要泄漏风险。部署开关保持关闭；已上线则先禁用PG写入，保留台账，数据库回滚走备份。

### T06 — 执行 profile、工具及预算隔离

**目标与范围**：确保PG不会因原语、插件或后台任务间接改变真实环境。

**涉及模块/文件**：`src/adapters/local-monolith/runtime-host.ts`和Host实现；`src/orchestration/agent-runtime.ts`、`scheduler.ts`、`invocation-queue.ts`；`src/capabilities/execute-tool.ts`、`mcp.ts`；`src/plugins/plugin.ts`、`builtin.ts`；`src/context/memory.ts`；`src/store/sleep.ts`、`long-tasks.ts`；用量写入点与profile测试。

**前置依赖**：T04、T05。

**具体步骤**：

1. 固定PG允许的真实能力：只读system/web、本房间media/memory、虚拟send/activity；默认不装配Alarm、MCP、辞典工具/injector、Sticker、zzz。
2. 同步工具registry、Skills索引、scene definition及dispatch拒绝。新增未知插件默认不进入PG，sideEffect布尔仅保留审计用途。
3. 通用任务服务在创建时验证Host profile；未注册插件不能绕过工具层偷偷创建PG任务。未来图片能力单独授权，completion不得回落Telegram。
4. Agent/Vision用量写`playground` scope；读取独立累计并复用上限；PG不读写全局sleep，也不继承budget bypass。
5. Scheduler recover/due/launch/skip/receipt均按已注册Host范围处理；diagnostic使用带Host的身份，旧TG监控字段保持契约。

**验收标准**：恶意/旧transcript直接调用zzz/MCP/alarm/辞典写被拒；TG sleep、memory、dictionary、tasks、Telegram API调用计数不因PG变化。PG耗用可见并受限，TG预算不被PG账目计入。

**必要测试**：新增建议 `test/playground-policy.test.ts`；既有 `skills.test.ts`、`plugins.test.ts`、`sleep.test.ts`、`token-usage.test.ts`、`mcp.test.ts`、`long-tasks.test.ts`、`task-delivery.test.ts`；覆盖工具发现/直接调用/execute/注入四条路径。

**不在范围**：通用安全策略语言、所有工具Mock、逐次工具审批、网络隔离容器。

**风险与回滚**：漏掉zzz、Vision计量、context injector、receipt就是隔离失败。可先关闭PG注册；不改TG原profile，不重置已有生产预算/休眠。

### T07 — 本地静态图片资产与授权读取

**目标与范围**：输入图片不依赖Telegram，仍复用既有归一化、多模态、Vision与ref约束。

**涉及模块/文件**：`src/capabilities/media/media.ts`、`media-download.ts`、`media-image.ts`；`src/context/context-builder.ts`、`context-refs.ts`；`src/store/schema.ts`、`migrations/`、`store.ts`；新增建议 `src/adapters/local-monolith/playground-assets.ts`。

**前置依赖**：T02、T04、T06。

**具体步骤**：

1. 校验JPEG/PNG/WebP真实内容与大小/像素上限，分配受限本地asset ID，拒绝任意路径/URL/SVG/伪MIME。
2. `MediaSource`按Host和内部media ID选择读取；local读取不能fallback Telegram getFile。
3. 新Message的media行关联资产；input_refs、同群授权、ref TTL和GC使用现有机制。
4. 支持direct images和`read_image`；缓存key包含来源域/内容身份，不能与Telegramfile_unique_id碰撞。
5. 补临时文件、孤儿文件、retention与备份；复用本地资源生命周期，不新建对象存储服务。

**验收标准**：上传图片由对应虚拟用户进入模型，多图顺序正确；文字模型可按ref调用Vision；跨房间/过期ref拒绝；本地资产读取完全不访问Telegram。

**必要测试**：`test/media-image.test.ts`、`media.test.ts`、`context-send.test.ts`；新增建议 `test/playground-media.test.ts`，覆盖过大、坏文件、伪路径、孤儿清理、TTL、备份恢复与零getFile调用。

**不在范围**：普通文件解析、音视频、TGS/视频Sticker仿真、生图Provider改造。

**风险与回滚**：本地路径泄漏、缓存跨Host碰撞、清理仍被引用的资产。关闭上传/读取入口；不删除生产媒体；删除虚拟资产须按其明确owner和retention。

### T08 — 生图 opt-in、回执与真实媒体输出

**目标与范围**：为MVP的媒体输出提供真实可执行路径，默认不产生生图费用；沿用已存在图片核心与任务服务。

**涉及模块/文件**：`src/image/bridge.ts`、`service.ts`；`src/plugins/image/image.ts`、`index.ts`；`src/store/image-delivery.ts`、`long-tasks.ts`；Scheduler receipt admission、Host delivery；`packages/image-service/src/core.ts`、`worker.ts`（仅如需宿主执行范围钩子）。

**前置依赖**：T03、T05、T06、T07。

**具体步骤**：

1. 新room默认image=false；管理员开启时检查现有image配置并记录revision/操作者，不接受临时key或任意Provider URL。
2. `ImageBridge`提交/输入资产/generation actor/receipt全部绑定虚拟Conversation；关闭只阻止新提交，已接受任务继续回虚拟房间。
3. `send kind:image`消费已授权generation，shared delivery记录全部本地资产与caption；相同generation的去重/unknown规则不绕过。
4. completion使用正常Scheduler，Hold只阻止待处理用户输入，不能被误认为取消了已授权生成；receipt的history同样看不到held输入。
5. 检查图片worker启动即恢复/扫描整个queue的行为。增加一个由宿主提供的执行资格过滤钩子时，覆盖recovery、enqueue、claim、config wake和bridge reconcile；图片包不能导入Telegram/PG业务类型。
6. 对PG专属生成资产建立清晰保留策略；当前生产生成原件是备份归档、并不自动继承媒体TTL，不得顺手批量删除。PG清理只触及确认独占且无引用的资产。

**验收标准**：默认调用image_generate拒绝；开启后真实工具→generation→receipt→send→虚拟图片完整连通，失败/部分结果可见；无真实IM输出；standalone模式不恢复/执行不属于启用Host的历史生成任务。

**补充验收（§3.1）**：

- 前置（R01）：开工前在真实装配下确认 T07 验收成立，即房间图片进入模型、`read_image` 可按 ref 调用，且本地资产读取不经 Telegram 客户端；不成立先修。
- R01：同一真实装配下，默认 room 调 `image_generate` 被拒；开启后 generation→receipt→send→虚拟图片连通。
- R02/R03：image 开关翻转时，prompt 文案、Skills 索引、`execute` search/help/call、旧 transcript 直接调用、receipt 调度同时变化；关闭只阻止新提交。
- R04：关闭状态、配置缺失、额度不足等拒绝不创建 generation、long task、资产行或文件。
- R09/R10：PG 生成资产进入备份并能从恢复后的库读取；消息被保留期清理后，generation/receipt 审计仍可查询；多行共享同一文件时，只在最后一个引用消失后删除。
- R13：PG 生图用量记在 playground scope；TG 生图的闸门键、用量与回执行为不变。
- receipt 的取消与有效性检查按 Host 分支，PG 不读取 Telegram chat ID；全局并发额度满时，queued receipt 不让 Scheduler 忙等。

**必要测试**：`test/image-agent.test.ts`、`image-delivery.test.ts`、`image-delivery-runtime.test.ts`、`image-startup.test.ts`、`task-delivery.test.ts`；使用现有image fake provider fixture，新增PG/混合队列断言；如改worker，运行`packages/image-service/test/`中相关既有测试及完整包测试。

**不在范围**：新增图像模型、生成质量Eval、修改TG相册输出、自动重试收费请求、为PG再建图片worker。

**风险与回滚**：意外恢复生产排队任务、关闭开关后遗失receipt、资产共享删除。关闭PGimage新提交，等待已授权任务终态，保留审计；不能靠终止worker假装取消已计费请求。

### T09 — Admin Playground API 与房间审计

**目标与范围**：为UI提供完整受认证入口；HTTP取消/重试不控制已提交的模型运行寿命。

**涉及模块/文件**：`src/ingress/admin/server.ts`、`audit.ts`、`auth.ts`（通常只复用）；新增建议`src/ingress/admin/playground-admin.ts`；`agent-doc/admin-panel.md`、`verification.md`；`apps/admin-next/e2e/server.ts`与fixtures。

**前置依赖**：T05–T08。

**具体步骤**：

1. 按架构方案端点表接入room、participants、messages、Hold、Release、retry、assets、capabilities、invocations；新写路径进入文档白名单。
2. 复用Session/Origin/TypeBox/稳定错误/脱敏；P0 API key所有PG写均403，不回退cookie。
3. 每个嵌套ID验证room membership；GET不调用模型；mutation key先于revision重试判断。
4. timeline按稳定序号分页；响应携带完整状态摘要，支持断线后查询已接纳请求结果。
5. 资产content有认证和类型/大小约束；Provider/工具错误只返回可审计的脱敏详情，不能输出token/local path。
6. E2E服务装配真实CoreRuntime/Scheduler + Faux，补控时/阻塞gate；不只seed几个成功结果。

**验收标准**：未登录401、跨Origin403、API key不能写、跨room404/403；断线后同key取原release；空release零模型调用；失败无发送也能轮询看见。

**补充验收（§3.1）**：

- R07：新端点与既有 memory、audit 写端点都按 room/Host 归属匹配；用另一个 room 或 TG Conversation 的 ID 写、删返回 404/403 且无行变化。
- R08：所有既有 Admin 列表与详情端点在含 PG invocation、消息、发送、资产、记忆的 fixture 上返回 200，且不把房间显示成可管理的 TG 群；E2E `02-lists-filters` 覆盖混合数据。
- R11：同 key 只换文本、asset、reply 或 sender 之一都返回 409；同 key 重放 submit、Release、retry 返回原结果；断线重试不产生第二次模型调用。
- R12：路径与 body 中的 ID 拒绝错 kind 前缀、前导零、负数、超出 int64。
- R04/R06/R10：上传复用 T07 校验并通过 R06 探针；被拒的上传与被拒的提交不留下 asset 行或文件；未挂到消息的上传有明确清理期限，状态可查询。
- 房间的 bot 身份不能作为输入 sender，也不能经 participant 端点被冒用；retry 在同房间已有更晚 Release 时拒绝，失败的 retry 留下可查询的终态，不让原输入永久无法处理。
- 建房写入的通用列取值（如 `chats.type`）记入 `agent-doc/data-layer.md`；既有按类型过滤的查询不因房间而改变 TG 结果。

**必要测试**：新增建议`test/admin-playground.test.ts`、`apps/admin-next/e2e/19-playground.e2e.ts`；重跑`admin.test.ts`、`admin-api-keys.test.ts`、`admin-invocation-media.test.ts`以及E2E `00-auth`、`04-writes`、`05-readonly-security`、`06-trust-boundary`。

**不在范围**：修改已有key scopes、公共匿名聊天、RBAC、SSE/WebSocket。

**风险与回滚**：误把GET当执行、漏Origin、HTTP断线引发重复调用。关闭PG路由注册即可停止新写；保持已接纳任务与审计，不删除房间数据。

### T10 — 共存装配与 Playground-only 生命周期

**目标与范围**：同一产品支持Telegram+PG和不连接Telegram的PG-only；继续一个锁/库/调度器。

**涉及模块/文件**：`src/cli.ts`、`cli-options.ts`；`src/adapters/local-monolith/runtime-host.ts`、`config.ts`；`src/orchestration/runtime.ts`；`src/image/service.ts`、`bridge.ts`；`agent-doc/operations.md`；现有CLI测试/fixture。

**前置依赖**：T06、T08、T09。

**具体步骤**：

1. 增加`serve --playground-only`，复用现有配置结构，不解析Telegramtoken/unusedSecretRef；缺Admin启用时清楚拒绝。
2. 将共同生命周期与可选Host装配分离；PG-only不构造Bot、不同步Sticker、不catch-up、不启动生产MCP。
3. 明确Scheduler启用Host集合，重启恢复和图片worker只处理集合内工作；混合DB的TG状态保持不变。
4. 不依赖bot.start作为唯一长进程等待点；保持SIGINT/SIGTERM、supervisor restart、ServeLock、takeover优雅收尾。
5. 普通serve的Telegram启动/配置/命令保持原行为，PGprofile只在虚拟conversation绑定。
6. 提供合法但无真实Telegram凭据的PG-only示例；写清占位Telegram结构是schema限制，不是虚拟群配置。

**验收标准**：在Telegram网络被deny且无token的临时环境成功启动Admin、Release和图片闭环；两种模式shutdown无悬挂任务/锁；PG-only打开混合fixture不变更TG工作状态。

**补充验收（§3.1）**：

- R01：PG-only 验收用真实 `serve --playground-only` 子进程完成，而不是在测试里拼装 Runtime；Telegram 构造、API、getFile、Sticker、MCP 的计数取自生产装配上的 spy。
- R03：PG-only 下 Scheduler 的 recover/due/launch、图片 worker、long task 与全局 sleep 都不触碰 TG 工作；混合模式下 PG profile 只在虚拟 Conversation 上绑定。
- R10：PG-only 的 `backup` 覆盖全部 PG 文件目录，恢复后可读；`serve` 运行中执行 `backup` 不删除正在写入的上传或生成文件。
- R13：混合模式下 TG 的闸门键、预算、usage scope 与 T00 合同一致。

**必要测试**：扩展`test/runtime-host.test.ts`、`cli-harness.ts`相关CLI测试、`test/image-startup.test.ts`、`operations.test.ts`；新增Host装配spy，Telegram构造/API/文件下载/Sticker/MCP计数均0；ServeLock/takeover既有测试继续通过。

**不在范围**：第二种部署方式、单独PG数据库进程、分布式工作者、全面重写FileConfig。

**风险与回滚**：不应把两个独立Scheduler放在同库；漏扫恢复或worker会有真实副作用。撤回新flag/PG注册恢复普通serve；所有数据库回滚遵守备份规则。

### T11 — Admin 虚拟群聊页面

**目标与范围**：管理员能操作完整MVP，显示真实状态与可用能力。

**涉及模块/文件**：新增建议`apps/admin-next/src/routes/playground.tsx`、`pages/playground.tsx`及必要局部组件；现有`lib/api.ts`、`lib/queries.ts`、`components/layout/app-sidebar.tsx`、breadcrumbs/header、`locales/{en,zh-CN}/`、`routeTree.gen.ts`（由项目生成流程更新）。

**前置依赖**：T09、T10。

**具体步骤**：

1. 房间选择/创建、身份创建/选择、时间线、reply选择、文本与静态图片输入；复用已有UI与错误组件。
2. 默认Hold、pending计数、Release动作；解释Hold不取消queued/running或授权生图。请求使用持久到响应明确前不更换的key。
3. 消息/状态轮询分开处理，分页稳定去重；切room防旧响应污染，失败保留输入草稿。
4. 展示text/image/multipart实际发送、typing、queued/running/终态/错误、用量和安全retry；completed无send显示已结束/未发送，不伪造回复。
5. 生图开关清楚标示真实费用；unsupported媒体显示原因；不展示普通assistant私有文本为群消息。
6. 中英locale、键盘操作、焦点/读屏标签、窄屏布局与reload/deep link。

**验收标准**：只通过页面可完成多用户→Hold→Reply→Release→输出；两房间互不串内容；浏览器刷新恢复room状态；未知结果与重复提交可解释。

**补充验收（§3.1）**：

- R04/R14：被拒或网络失败的提交不显示为已发送，草稿与附件保留；E2E 断言服务端返回的错误码与页面文案，不只断言 toast 出现。
- R06/R05：超限、截断、动画图片的拒绝原因来自服务端，页面不以客户端预检代替服务端校验；单张超限图片同样被拒。
- R08/R12：页面只使用 API DTO 中的 opaque ref 和展示字段，不解析或显示内部数字 ID、本地文件路径。
- R11：同一草稿的重试复用 request key，修改内容后换新 key；两个标签页不共享 key；E2E 覆盖响应丢失后重试。

**必要测试**：扩展新增`19-playground`E2E的真实后端场景；跑`pnpm run admin:build`、`pnpm run admin:test:e2e 19-playground`及`01-routes`、`04-writes`、`06-trust-boundary`；locale/type检查必须通过。

**不在范围**：聊天编辑器插件、批量粘贴解析、聊天主题皮肤、streaming私有思考、移动App。

**风险与回滚**：乐观UI把失败误显示成功、多标签复用错误key、切群请求竞态。关闭导航/路由与PGAPI写入口，数据库和后台已接纳工作保留。

### T12 — MVP 全链路验收与交付

**目标与范围**：完成下节矩阵，证明既有Telegram行为与PG隔离；交付使用说明，不添加新功能。

**涉及模块/文件**：上述新增测试；`test/fixtures/admin-seed.ts`、`apps/admin-next/e2e/`；`agent-doc/architecture.md`、`telegram-agent-flow.md`、`data-layer.md`、`admin-panel.md`、`operations.md`、`verification.md`；用户指南实际目标按`apps/docs/README.md`确定。

**前置依赖**：T00–T11。

**具体步骤**：

1. 完整运行Vitest/check/lint/Admin E2E，核对TG合同无变化；文档新增指南运行docs build/verify。
2. 执行持久化/重启/并发/失败/retention混合Host矩阵，不仅断言UI文本。
3. 在隔离数据目录和授权的真实Provider下执行一次文本、一次静态图片理解、一次opt-in生成图片；Telegram网络deny。
4. 使用测试TG chat做原行为人工验收（需要项目维护者提供其测试环境）；无法执行时明确记录，不拿Faux证明真实外部连接。
5. 更新当前主题文档与用户指南；历史规划文件只追加交付指针，不将旧调查内容当当前事实重写。

**验收标准**：所有自动化门通过；人工项有证据或明确限制；PR说明包含数据库/配置变化、费用和恢复行为；没有任何不明来源真实IM发送。

**必要测试**：完整`pnpm test`、`pnpm run check`、`pnpm run lint`、`git diff --check`、`pnpm run admin:build`、完整`pnpm run admin:test:e2e`；文档站有改动时`pnpm run docs:build`、`pnpm run docs:verify`。

**不在范围**：性能benchmark体系、完整Eval平台、真实第二IM。

**风险与回滚**：合并前遗漏迁移/恢复最难事后修复。上线可先关闭PG写入/生图；保留所有账本，必要时停机恢复备份，不以删除锁/强杀未知PID操作。

## 5. P1：体验完善与基础 Eval

### E01 — 可选 Telegram 调度仿真 profile

**目标与范围**：提供与Telegram固定window、round后延时、idle grace、send barrier/attach相近的显式模式，保留P0 deterministic默认。

**模块/文件**：`src/ingress/playground.ts`（T05新增）、`invocation-queue.ts`、`scheduler.ts`、`conversation-runtime.ts`、`agent-runtime.ts`、PG页面与设置API。

**依赖**：T12。

**步骤**：定义profile→复用既有collecting/attach→Hold只阻挡尚未admitted输入→审计每次实际策略→UI显示release与invocation多对一关系。

**验收**：同一脚本在两profile的不同结果可以预测；held数据仍不进入barrier/history；TG自身行为不变。

**测试**：复用`test/context-hot-inject.test.ts`、`scheduler.test.ts`的Faux gate；新增PGpacing差异矩阵和E2E设置持久化。

**不在范围**：虚拟时钟、重写scheduler、默认改变所有房间策略。

**风险/回滚**：多个batch同一Invocation破坏旧UI假设；profile变更仅在无active work时允许，撤销后已有运行按固定profile收尾。

### E02 — 场景背景 seed、导出、复制和重建

**目标与范围**：复用输入/输出证据做可重复的单场景实验；不是评分框架。

**模块/文件**：T05的PGstore/ingress、T09API、PG页面、本地assets；新增建议`src/ingress/admin/playground-scenes.ts`。

**依赖**：T12。

**步骤**：定义版本化场景文件（actors、顺序、reply、资产manifest、release边界、模型配置指纹）→显式background与new区分→导出/校验→复制到新room并重映射所有ID/ref→重建时不复制production私有Context或旧capability。

**验收**：同一文件两次导入得到独立房间，文本/顺序/引用等价；background永不单独形成任务；缺资产/超限/未知版本明确拒绝。模型输出不承诺确定性。

**测试**：新增round-trip、跨room remap、恶意输入和缺媒体fixture；E2E导出/导入；canonical/ref归属断言。

**不在范围**：自动生成测试数据、私有推理回放、批量运行、自动评分。

**风险/回滚**：导出包含敏感聊天/Prompt；管理员主动导出，保留manifest和范围。删除新入口即可回滚，已有场景文件用版本标识处理，不变更旧room。

### E03 — 逐项开放额外只读能力

**目标与范围**：按实际需要允许明确的只读MCP、global-only辞典或本地缓存Sticker，仍默认拒绝未知工具。

**模块/文件**：PGprofile、`src/capabilities/mcp.ts`、`stickers.ts`、`src/plugins/dictionary/`、PGcapabilityAPI/UI。

**依赖**：T12。

**步骤**：逐项列明网络/费用/共享数据影响→管理员显式allowlist→只装配准许executor/injector→Sticker只接受本地授权资产，缺缓存拒绝→检查配置变化不扩大既有run权限。

**验收**：读与写明确分离；同名新MCP工具不自动获权；本地Sticker发送不调用Telegram；全部dispatch可审计。

**测试**：既有`mcp.test.ts`、`dictionary.test.ts`、`stickers.test.ts`加profile对照；故意标错annotation/read_only的拒绝测试；API/E2E授权边界。

**不在范围**：开放外部写MCP、Alarm、通用工具沙盒、克隆全生产工具权限。

**风险/回滚**：读取也可能联网/计费，远端声明不能作授权。撤销该能力的新run装配；运行中的权限按快照收尾或显式取消。

### E04 — 单场景程序化 Eval 驱动

**目标与范围**：外部测试程序提交一个场景、Release、等待终态、导出结构化证据；复用真实Scheduler。

**模块/文件**：PGscenes/API；`src/ingress/admin/api-keys.ts`与`server.ts`权限边界；`packages/cli/src/`现有客户端入口（具体文件实施时定位）；新增建议单场景CLI命令和fixture。

**依赖**：E02。

**步骤**：独立PG-only token scope→单场景create/import/release/poll/export→请求幂等→超时只停止等待、不默认重跑→结构化输出messages、dispatch、status、usage、omission和config指纹。

**验收**：客户端可在断线后恢复等待；token无法操作真实chat或现有管理写端点；结果保留原Invocation/Release IDs。

**测试**：APIkey权限矩阵、CLI HTTP fixture、单场景end-to-end、取消/超时/重复key；全部复用P0调度断言。

**不在范围**：批量评分、模型排行榜、并发压测、自动场景生成。

**风险/回滚**：错误scope把程序化测试变生产管理权；默认不授PG写，撤销专用scope/token即可禁用，保留已提交运行。

### E05 — 独立精简配置

**目标与范围**：PG-only配置可完全省略Telegram节，消除P0结构占位；旧配置与普通serve不变。

**模块/文件**：`src/platform/config.ts`、`runtime-config.ts`、`src/adapters/local-monolith/config.ts`、`runtime-host.ts`、`cli-options.ts`、配置参考生成器/示例与用户指南。

**依赖**：T10、T12。

**步骤**：定义显式启动profile与配置校验边界→TG装配要求Telegram配置，PG不要求→所有共享默认来自agent/host policy→更新示例和配置错误→核对reload语义。

**验收**：完全无Telegram字段可启动PG；旧JSONChash/默认行为按明确迁移合同处理，不静默改变Telegram配置；check-config可报告选定模式的缺项。

**测试**：`test/config-boundary.test.ts`、`docs-examples.test.ts`、`config-reload.test.ts`与CLI/PG-only启动测试。

**不在范围**：通用多平台配置DSL、远程secret服务、改写configure全部流程。

**风险/回滚**：将required变optional使旧分支运行到一半才崩；入口校验阻断。旧配置一直有效，撤回新增精简格式时需说明已采用它的部署恢复P0格式。

## 6. P2：后续跨 IM 与高级 Eval

### X01 — 针对一个真实候选平台验证 Host 缺口

**目标与范围**：由维护者另行指定QQ/Discord/飞书等一个平台，用真实事件样本评估边界；本任务只做契约spike，不默认实现第二生产Adapter。

**模块/文件**：`src/platform/im-host.ts`、Host实现、Context投影、media source；新增该平台contract fixtures与设计记录。

**依赖**：T12；明确平台和可用事件样本。

**步骤**：采集ID/用户/频道/Reply/附件/activity/error差异→映射最小模型→标注unsupported→只扩展两个既有Host也能解释的契约→另列生产接入Epic。

**验收**：不通过改名Telegram类型伪装支持；能力缺失可表达，身份/授权不碰撞；TG/PG合同全部通过。

**测试**：离线事件contract、opaque/复合ID、无thread/typing、未知结果fixture；真实连接只在新平台任务授权后验收。

**不在范围**：本次上线第二IM、万能Adapter SDK、所有平台能力并集。

**风险/回滚**：样本不足导致错误泛化；spike保留为独立文档/测试，未证明的接口扩展不进核心。

### X02 — 高级 Eval 编排与评分

**目标与范围**：在E04证据接口上另行设计批量执行、比较、评分与人工复核。

**模块/文件**：E04客户端和PGscenes/API；如确需新模块，先在独立Eval设计中定义目录，当前不虚构现有framework。

**依赖**：E04；明确数据集、评分准则、成本预算和运行规模。

**步骤**：先定义评价与失败含义→小批场景执行→收集可重建配置与证据→引入可选judge及人工校准→再决定批量调度。

**验收**：失败/无输出/拒绝副作用不会被算成成功；模型judge有不确定性标记；成本和并发有上限；结果可定位原始Invocation。

**测试**：固定输出评分fixture、失败分母、重试去重、预算和中断恢复；模型judge质量由人工标注集验证。

**不在范围**：自动扩充任务为无限规模Eval服务、自动生成训练数据、替换生产Scheduler。

**风险/回滚**：评分偏差和费用失控；可停批量派发，已接纳单场景仍按E04保留证据。

### X03 — 虚拟时钟和延迟任务实验

**目标与范围**：在完全虚拟房间中测试Alarm、TTL、receipt与重启，不让推进测试时钟影响生产。

**模块/文件**：`src/store/long-tasks.ts`、`sleep.ts`、`context-refs.ts`、`src/orchestration/scheduler.ts`及PGprofile；PGprogrammatic driver。

**依赖**：E01、E04。

**步骤**：区分wall clock/deadline与场景clock→只为需要模拟的业务时间注入时钟→虚拟任务保留Host scope→推进/暂停显式操作→记录每次时间事件。

**验收**：PG时钟推进不唤醒TG任务、不改变生产TTL/预算日；重复advance不重复receipt；真实Provider超时继续用实际wall clock。

**测试**：分域时间fixture、TTL/Alarm/receipt、重启重放、交叉Host零影响；既有时间测试不可全局mock后掩盖真实行为。

**不在范围**：系统时间修改、通用distributed clock、生产Alarm新语义。

**风险/回滚**：两种时间混用导致过期和付费超时失效；profile隔离可关闭，保留时间事件和任务终态，不自动迁回真实时间执行。

## 7. 测试与验收矩阵

自动测试必须穿过真实Store、Scheduler和Runtime，Provider/Telegram transport可用Faux/spy。只测试API返回文案、直接调用`runtime.run`或直接插入success行都不能证明调度合同。

| 编号 | 场景 | 必须断言的证据 | 自动化 / 手工 |
| --- | --- | --- | --- |
| V01 | Telegram原行为 | allowlist/topic、edit冻结、bot消息、participation、startup、barrier、send_reply、reply去重、typing、unknown和Context GC合同不变 | 既有Vitest + TG测试群人工消息 |
| V02 | 多用户/同名用户 | Sender身份不同；Provider输入具有正确可见ref/name/order；caller归属正确 | PG真实Scheduler + Faux；页面切身份 |
| V03 | Hold期间 | 0个由pending产生的Bucket/Invocation/model call；已有运行发送时barrier也看不到pending | gate固定已有run阶段；检查快照/canonical/provider请求 |
| V04 | Release顺序与Reply | input seq → bucket sequence → invocation sequence；reply目标/快照/ref一致；through_seq之后未泄漏 | 相同时间戳、多客户端、正向/跨群reply拒绝 |
| V05 | Release时机与合批 | N pending一个queuedInvocation；无window等待，但running需受并发约束；空release零调用 | 真实Scheduler并发gate；UI状态 |
| V06 | 运行中再次Hold/Release | 已released继续，新pending隔离；第二release排队不attach；最多一个同群running | 查询`invocation_buckets`、active、canonical顺序 |
| V07 | 幂等 | 同key同body相同结果；不同body409；不同key重叠范围不重复认领 | 并发HTTP、commit后断线、response丢失、唯一约束 |
| V08 | 调度/模型失败 | 事务失败pending仍在；终止有状态；无自动重复模型；retry守卫拒绝已注入/有请求/side effect | 失败注入、重启临时DB、冻结快照比较 |
| V09 | 退出与重启 | pending保留；queued年龄规则明确；running→aborted/unknown；disabled Host状态不变 | 实际子进程重启；不依赖全局测试时钟 |
| V10 | 大批输入 | 超限整体拒绝/blocked，不默丢较早new；错误里能定位release | 小context Faux，断言模型未收到部分批次、完整冻结输入仍在 |
| V11 | 输出仅当前虚拟群 | text/image/multipart顺序，普通assistant不显示；成功发送审计与Message一致 | 两room + TG spy；局部失败与delivery key重试 |
| V12 | 零Telegram网络 | getMe/getUpdates/sendMessage/sendSticker/sendPhoto/getFile等均0；不构造TGonly后台服务 | transport canary、受控deny网络；PG-only真实Provider人工 |
| V13 | 副作用隔离 | 默认Alarm/MCP/辞典写/zzz无变化；memory仅本room；未知工具拒绝；PG预算独立 | 对比运行前后生产状态，直接/execute/旧Context恶意调用 |
| V14 | 媒体与生图 | direct image顺序、read_image refs；opt-in前零请求；opt-in后receipt和输出只回PG；关闭后不接受新任务 | fake image provider全链路；真实图片Provider一次人工 |
| V15 | Admin边界 | auth/Origin/key scope、ID归属、upload限制、脱敏、XSS/CSP；GET不执行 | HTTP+浏览器E2E；错误响应及网络请求断言 |
| V16 | UI恢复与可用性 | 切room无串内容；reload恢复；失败无消息也刷新；多语言/键盘/窄屏 | `19-playground` + existing routes/writes/trust E2E |
| V17 | 升级/保留/备份 | 旧TG行/ID/审计/ref不变；PGpending过期可解释；local资产可恢复；不删真实生成归档 | 空库/旧fixture升级、integrity/FK检查、临时备份恢复 |

### 必须保留的人工验收步骤

1. 在隔离数据目录、无Telegram凭据且Telegram目标网络deny的环境，启动PG-only；确认Admin可登录，后台无TG请求。
2. 新建A/B群，A内建小甲/小乙（再建一个同名身份），Hold输入三条，第二条reply第一条。等超过Telegram配置window，确认没有Invocation。
3. Release，观察queued→running→终态。Provider实际输入检查三条的顺序、身份与Reply；允许模型沉默，用明确“请回复”场景核验send结果。
4. 让一轮慢操作在运行时再开启Hold、输入、Release；确认新运行串行，先前输出正常，B群不出现A的内容。
5. 上传静态图片并询问内容；开启明确生图权限后请求一张图，核对generation/receipt/send/资产；默认关闭和再次关闭后的新请求均不产生生成调用。
6. 注入Provider失败、断网和重启；页面必须保留输入/终态/已有输出；重复点击Release或请求同key不能再产生费用。unknown或已注入的整轮不能一键盲重试。
7. 在项目维护者授权的测试Telegram群验证文本、Reply、Topic、编辑、Sticker、图片、pause与startup；与T00合同对照。没有可用真实环境时在PR逐项标“未执行”，不写“全部通过”。

Faux证明状态机与调用参数，不能证明真实模型一定发言/理解图片、Telegram实际API可达、真实Provider计费或图像质量。人工验收不使用生产群或生产数据库作为测试夹具。

## 8. 本次规划交付的验证记录

当前仅有规划文档和索引更新。已执行`pnpm run check`、`pnpm run lint`通过；8个相关测试文件、138项测试通过，命令详见调查报告。没有实现或运行本Epic的拟议新测试/API/界面，没有创建PR或提交运行代码。

最终实施交接时应把“已有基线通过”与“新增功能验收通过”分开记录。优先遵循本文件Critical Path，P1/P2均可在MVP交付后独立规划，不允许借跨IM或Eval目标扩成一次大规模重构。

## 9. 交付指针（T12 验收后追加）

**P0 已全部交付（T00–T12）**，实现事实以当前源码与主题文档为准，本节只做导航：

- 任务交接与不变量对照：`agent-doc/devlogs/20261019-bot-playground-t08-t11.md`（T08–T11 与 §3.1 R01–R14 逐条证据）与 `agent-doc/devlogs/20261019-bot-playground-t12-acceptance.md`（T12 全链路验收记录）。
- 当前行为：`agent-doc/data-layer.md`（宿主中立 schema、`rooms`/`room_participants`、`host_sends`、房间资产）、`agent-doc/admin-panel.md`（`/api/playground` 端点表）、`agent-doc/operations.md`（`--playground-only` 模式）、`agent-doc/telegram-agent-flow.md`（宿主绑定 Context、图片输出）、`agent-doc/verification.md`（`20-playground` E2E）。
- 用户指南：`apps/docs/content/docs/guides/playground.md`。
- T12 自动化门全绿（`pnpm test` 1532 项、`pnpm run check`/`lint`、完整 `admin:test:e2e` 172 项、`docs:build`/`docs:verify`）；**人工验收项中「授权真实 Provider 的隔离环境试跑」与「真实 Telegram 测试群回归」尚未执行**，需要维护者环境，状态见 T12 devlog。
- P1（E01–E05）与 P2（X01–X03）未开始，仍按本文档依赖关系独立规划。
