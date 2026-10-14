# 宿主解耦与 Local Monolith Adapter 设计

## 1. 目标与实施顺序

先拆开业务规则与部署宿主的耦合，交付一个完整的 **Local Monolith Adapter**，让现有单机部署成为共享运行时的第一个生产实现；之后再验证 Cloudflare Workers、Durable Objects（DO）、Alarms 与 Containers 的组合。

首期交付物是通过现有 CLI、配置和数据库继续运行的单机应用。拆分应改善依赖方向、测试与模块所有权，不以部署 Cloudflare、模拟分布式系统或增加新功能作为验收条件。

设计决策：

- 共享业务核心保留参与规则、Bucket/Invocation 状态转换、Context、工具授权、发送审计与任务回执语义。
- Local Monolith Adapter 负责 Node 进程、SQLite 连接、文件配置、计时器、原生能力与服务装配。
- 业务执行与事务存储保持同址：单机在一个 Node 进程内，未来云端优先在 Chat DO 内。
- Cloudflare 容器优先承接媒体转换、stdio MCP 等原生能力；会话执行、授权和业务状态由 DO 拥有。
- 先在现有模块中建立真实边界，再决定独立包与目录迁移；不先把整个 `src/` 改名为 `base`。

这里的 adapter 是**部署宿主适配器**。Telegram 仍是现有产品的唯一 IM 接入；首期不实现其他 IM、不重新设计通用消息协议，也不为了云端改变单机运维方式。

## 2. 当前耦合与可复用基础

| 当前入口 | 耦合或已有边界 | 拆分用途 |
| --- | --- | --- |
| [application.ts](../../src/application.ts) | 进程启停、文件配置、连接创建与业务装配集中 | 分离宿主资源生命周期与共享运行时装配 |
| [agent-runtime.ts](../../src/orchestration/agent-runtime.ts) | 直接依赖 `SqliteStore`，创建 ContextStore/Refs/Builder，并执行模型与工具循环 | 保留业务规则，移除对具体宿主连接与资源加载的依赖 |
| [database.ts](../../src/store/database.ts) | 同步 Drizzle、better-sqlite3、文件路径、迁移与备份在同一模块 | 区分业务事务访问与连接/文件运维 |
| [scheduler.ts](../../src/orchestration/scheduler.ts)、[conversation-runtime.ts](../../src/orchestration/conversation-runtime.ts) | 调度准入、节拍与内存 Map、timer、等待回调交织 | 分离调度决策与唤醒驱动，保持运行期状态唯一 |
| [config.ts](../../src/platform/config.ts)、[runtime-config.ts](../../src/platform/runtime-config.ts) | 配置校验混合文件加载；已有按代发布的配置与模型快照 | 共享有效配置与快照语义，文件来源交给宿主 |
| [send-tool.ts](../../src/capabilities/send-tool.ts) | 已有 `TelegramSendApi`；授权、去重与发送账本仍依赖具体 Store | 复用传输接口，保留完整业务事务与未知结果语义 |
| [plugin.ts](../../src/plugins/plugin.ts)、[context-injector.ts](../../src/context/context-injector.ts) | 插件和注入器可直接取得 ORM；已有 tasks/audit/image 服务 | 按实际插件需要收窄数据访问，分离数据准备与纯渲染 |
| [image/service.ts](../../src/image/service.ts)、[image-service](../../packages/image-service/src/core.ts) | 图片域有 Provider 边界，但仍借主库连接、使用文件资产和本地 worker | 明确任务、资产、执行与关闭的所有权 |

[Context GC 规划](../../src/context/context-gc.ts)、[Context 编解码](../../src/context/context-codec.ts)、Prompt 模板和协议文本具有较高复用价值。纯 TypeScript 逻辑仍须检查运行依赖；不能仅凭没有文件 I/O 就承诺 Workers 兼容。

## 3. 首期结构：共享运行时与本地宿主

```text
现有 CLI / Telegram long polling / Admin HTTP
                      |
             Local Monolith Adapter
          资源创建、注入、启动、关闭
                      |
                 共享运行时
       入库 -> Bucket/Invocation -> Agent -> Tools
           Context / refs / 任务 / 审计 / 策略
                      |
              按职责划分的依赖边界
                      |
       本地 SQLite + 文件资产 + Node 原生能力
```

共享部分分为两种，不必全部变成纯函数：

- **领域规则与数据**：状态和配置契约、Prompt/消息渲染、GC 规划、授权与参与判断，不创建宿主资源。
- **业务用例**：入库、启动 Invocation、执行 Agent、发送、完成任务、清理 Context；通过注入的依赖执行 I/O，组织事务与审计。

Local Monolith Adapter 是完整宿主装配，不是一个包住现有 `serve()` 的转发类。资源所有权须真正从业务模块移出；业务模块不反向导入本地宿主实现。

可以保留现有 `orchestration/`、`context/`、`capabilities/`、`store/` 分层，按调用链逐步移动宿主代码。仅在出现真实实现后建立例如 `adapters/local-monolith/` 的目录；具体文件名不作为架构验收条件。

### 3.1 本地宿主保留的运行形态

- 一个 Node 进程、一份主 SQLite，图片域继续按当前约定复用连接；不按 Chat 拆本地数据库。
- 保留现有 CLI、配置格式、SecretRef、long polling、Admin 地址和 Docker 使用方式。
- 保留 `ServeLock`、启动追赶、恢复顺序、优雅关闭、数据库迁移和备份职责。
- 调用进程内函数与现有受限子进程；不引入内部 HTTP/RPC、actor mailbox 或消息序列化来模拟 DO。
- 数据库操作继续同步；真正的网络、文件与外部计算边界按需要异步。
- 每个被迁移的调用链只保留一个实现，完成切换后删除旧路径和临时兼容入口。

### 3.2 应抽出的最小边界

| 边界 | 共享运行时掌握的内容 | Local Monolith Adapter 提供的实现 |
| --- | --- | --- |
| 事务型业务存储 | Context、Invocation、任务、发送等完整状态转换 | 本地同步 SQLite/Drizzle 访问、事务、连接和迁移 |
| 唤醒与执行驱动 | 哪些工作到期、能否运行、下次截止时间 | timer、wake 通知、执行跟踪、停止与等待 |
| Telegram/模型传输 | 授权、预算、工具选择、结果分类和审计 | 复用 grammY/Pi 适配与现有网络能力 |
| 资产与原生能力 | 媒体授权、输入输出契约、任务状态和结果验收 | 本地文件、Sharp、FFmpeg/Lottie、固定 stdio MCP |
| 配置与只读资源 | 已验证配置、快照、Prompt/Skill 索引与内容 | JSONC/Secret 解析、文件更新、资源目录加载 |

接口沿业务需要逐项建立，不定义全能 `Platform`、万能 `execute` 或每表一个通用 Repository。优先复用 `TelegramSendApi`、`ImageProviderAdapter`、现有任务 scope 与配置快照。

## 4. 关键边界的具体约束

### 4.1 存储与事务

业务存储可以保留 SQLite 和共享查询实现，不承诺兼容任意数据库。首期移除核心对 native connection、数据库路径、PRAGMA、文件备份和具体驱动返回类型的直接依赖；不把每次 SQL 查询改成异步远程接口。

以完整业务状态转换收敛边界，例如 Context append/advanceHead、Bucket 冻结与 attach、发送尝试准备与结算、任务终态与回执创建。这些名称表示操作粒度，不是预先冻结的 API。

以下组合必须继续原子提交：

- Update 去重/审计与对应消息、Revision 入库。
- Bucket 状态变化与 Invocation 消息快照；Invocation 启动与配置 hash。
- Context 消息追加与序号推进；GC 的持久状态与引用撤销。
- 任务终态与唯一回执创建，按既有通知/取消规则置为 `pending` 或 `suppressed`。
- 发送前的去重/限额检查、pending 账本和副作用开始标记。

事务回调只在同址存储实现内部使用，不能成为未来跨网络协议。网络发送与数据库结算保持分段，不能用一个接口名字暗示跨系统原子性。

DO SQLite 的同步 Drizzle 驱动提供未来适配方向，但 bigint 编码、事务和执行结果、迁移与 SQL 限制需另行验证。首期不提前改 ID 或数据库格式来迎合未经验证的云端方案。

### 4.2 调度与恢复

共享调度用例负责到期判定、任务完成与回执处理、Chat 串行、全局准入、Bucket deadline 和 attach 决策。宿主驱动只负责何时调用这些用例、唤醒等待和停止执行。

本地仍由一个驱动协调现有调度；不同时保留旧 Scheduler 与新宿主各自决策。Conversation 的 `closing`、轮次、待注入批次和 Agent 缓存继续由唯一运行期所有者维护，不能分别复制到 core 与 adapter。

首期保留现有重启恢复：终止旧 running Invocation，按已有规则处理 queued/collecting、claimed receipt 和 `outcome_unknown`。可从持久步骤恢复的 Agent 状态机属于后续 Cloudflare 工作，不与此次等价重构混合。

### 4.3 配置、插件与能力

核心消费已验证且固定版本的有效配置，不依赖配置文件所在目录。宿主负责读取、校验候选、解析 Secret、准备 Provider 连接并按既有快照规则发布；不新增第二套 Provider 注册与热更新约定。

插件先复用 tasks/audit/image 等现有窄服务，再按辞典等实际需求补充查询和命令。注入器的数据准备与文本渲染分离，纯渲染不再任意查询整库。无需在首期建设第三方插件平台或泛型插件数据库。

`read` 仍只读 System Skills；资源来自文件目录还是构建产物属于宿主。`execute` 仍只分发已注册能力，不成为调用任意 Node 函数或容器命令的通道。

### 4.4 图片服务与 Admin

首期保留图片域现有持久任务、本地 worker 和主库连接共享方式，通过宿主装配明确启动、完成通知、取消、资产读取和关闭。不得为了抽接口再建立一份图片任务事实源或重试队列。

资产契约逐步使用资产身份、元数据与字节/流；本地路径只属于本地实现。异步对象存储的要求在资产边界处理，不传播成所有数据库 getter 都返回 Promise。

Admin 前端与 API 契约继续复用；本地审计保留现有 SQL 聚合。认证、配置写入、API key 和管理控制复用既有校验与审计，不因宿主拆分扩大写端点白名单。

## 5. 首期必须保持的行为

当前行为细节以 [架构](../architecture.md)、[Telegram 流程](../telegram-agent-flow.md)、[数据层](../data-layer.md) 与测试为核对入口。重构验收至少覆盖：

1. Context、Bucket、媒体与 Reply capability 按 Conversation 隔离；同 Chat 的 Invocation 串行，不把其他 Topic 批次 attach 到当前运行。
2. 全局并发、睡眠、预算、参与闸门、Bucket 节拍和 send barrier 的作用域与时机保持。
3. Invocation/attach 输入使用冻结 Revision；`steer` 入队不等于已经持久注入；未消费的附加批次按既有规则重新排队。
4. Canonical Context 只有一个写者，Pi transcript 为缓存；运行期共享 header，GC 同步维护 `head_seq`、loop context、Agent messages 与 refs。
5. 模型普通文本保持私有；模型驱动的发送仍经过同一 send 管线，`send_reply` 不另开发送通道。
6. 发送意图先落账，再调用 Telegram，再结算；未知结果保留为 `outcome_unknown`，不得盲目重试或宣称 exactly-once。
7. 配置发布保持完整 generation，每次 Invocation 固定快照；明确允许实时读取的控制状态仍按原规则处理。
8. 启动追赶、取消、重启恢复、任务回执、图片恢复与关闭顺序保持；不把旧运行自动续跑作为新增保证。
9. 外部数据始终不可信；引用授权、TTL/GC 撤销、MCP allowlist、超时、大小限制、Secret 脱敏和 Admin Origin 校验保持。

现有预算的请求前检查/请求后计费，以及外部发送与本地记账之间的不确定窗口，不因接口拆分自动获得更强保证。发现需修复的行为另列变更与测试，不夹带进等价重构。

## 6. 实施里程碑与验收

| 阶段 | 工作 | 完成标准 |
| --- | --- | --- |
| M1：识别并提取宿主依赖 | 分离配置校验/文件加载、业务存储/连接运维；明确资源所有者，提纯已有规则 | 依赖方向清楚，业务模块不再自行创建已迁出的进程级资源；现有入口仍可运行 |
| M2：落地 Local Monolith Adapter | 由本地宿主注入存储、传输、资源和原生能力；迁移一条完整的入库到发送链路，再覆盖其调用方与插件 | 原 CLI 进入新装配路径；真实本地 SQLite 上验证 Context、发送账本、配置与任务契约；旧路径删除 |
| M3：分离调度驱动并收口 | 提取共享调度决策，本地驱动负责唤醒/关闭；接通图片服务与 Admin，完成全量回归 | 一个调度决策来源、一个 Context 写者；既有部署方式与恢复行为保持，完成真实单机验收 |
| 后续：Cloudflare 纵向原型 | 验证 SDK/校验库、DO SQLite，再接文本会话、一个原生任务与资产 | 用真实平台证据决定适配细节，不以本地单体通过推定云端可用 |

每个阶段按完整调用链切换，避免长期存在新旧实现。接口由正在迁移的调用方确定，不为尚未实施的云端阶段提交空 adapter、占位类或第二套测试存储。

验证要求：

- 沿用 [验证文档](../verification.md) 中受影响的行为测试，跨模块改造运行完整 `pnpm test`、`pnpm run check` 与 `pnpm run lint`，并通过 `git diff --check`。
- 存储/Context 验证检查真实落盘状态和审计；覆盖事务回滚、bigint、GC、引用撤销与缓存重建，不只断言 mock 调用次数。
- 调度验证覆盖跨 Chat 并发、同 Chat 多 Topic 串行、热注入与关闭交错、任务回执、暂停和睡眠。
- 发送与恢复验证覆盖 pending/成功/失败/未知结果、重复回复保护、取消与进程重启，确认不引入重复副作用。
- 媒体/图片/MCP 与配置验证覆盖实际受影响的原生链路、任务恢复、资源关闭、热更新快照和错误脱敏。
- 涉及 Admin 前端或端点时运行受影响的浏览器 E2E；本地发布验收仍按运行文档使用监督器并验证 `serve_started`、真实消息与审计。
- 共享边界只补必要的行为契约测试，不为目录移动或接口转发编写镜像测试。源码或用户可见行为实际变化后再同步当前主题文档与用户指南。

## 7. 后续 Cloudflare 职责划分

```text
Webhook / Admin -> Worker -> Chat DO（会话执行 + DO SQLite）
                               |              |
                         Bot Control DO       +-> 审计查询库
                               |
Chat DO -> Executor DO -> Native Container -> R2
```

| 组件 | 目标职责 |
| --- | --- |
| Worker | Webhook 校验、路由、Admin HTTP 与静态页面；可靠接收入库/入队后返回成功 |
| Chat DO | 一个 Chat 内的各 Topic Context、去重、Bucket/Invocation、Agent 循环、授权、发送账本、任务和 Alarm 唤醒 |
| Bot Control DO | 全局配置版本、睡眠、并发与预算协调；具体跨对象协议在云端阶段验证 |
| Executor DO | 容器的路由、生命周期与计算容量；可由少量执行器服务多个 Chat |
| Native Container | Sharp/FFmpeg/Lottie、固定 stdio MCP、必要的 Node Provider/网络适配；本地磁盘仅作临时空间 |
| R2 / 审计查询库 | 资产与大报文；跨 Chat 列表、搜索和统计，避免每次 Admin 查询遍历全部 DO |

Chat DO 与管理容器的 Executor DO 是不同角色，不要求每个 Topic 或 Chat 配一个常驻容器。单机实现对应的调用仍在同一进程内，不复制此网络拓扑。

云端任务采用“DO 持久记录任务/尝试 → 容器执行 → 保存资产并回传结果 → DO 校验当前尝试并提交终态/回执”的流程。过期尝试不能写入当前业务状态，取消不等于上游已停止或未计费；生成与发送的未知结果仍不得盲目重试。

图片域改为云端执行时再调整其存储与 worker：同一生成任务不能同时由容器内 SQLite 和 DO 各自作为事实源。全局审计投影需要幂等事件、补投与可观察的延迟，其失败不能撤销已经成功的会话提交。

### 7.1 云端阶段才实现的机制

- Webhook 并发/乱序、Chat ID 迁移路由、DO 分片与跨对象全局协调。
- Alarm 重入、持久执行步骤、故障后续跑与安全轮次边界；DO 内长活 Invocation 不能假定一次 handler 永远存活。
- 跨节点取消、运行/尝试所有权、旧执行器失效与必要的租约机制。
- R2 资产、跨存储审计投影、云端备份与一致恢复、滚动部署兼容。
- Provider/Pi/TypeBox 的 Workers 打包与执行兼容，DO SQL 精度和事务差异、媒体内存与容器冷启动。

Cloudflare 优先让 Agent 循环贴近 DO 存储。若某个 Provider 必须运行在 Node，可先外置单次模型传输；只有实测证明整个 Agent 循环难以迁移，才评估容器执行会话步骤，并为快照、提交、热注入和副作用设计完整协议。不得把每条 SQL 远程代理到 DO 充当同步本地数据库。

平台能力与限额在实施时重新核验，参考：[DO 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[DO 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)、[容器生命周期与磁盘](https://developers.cloudflare.com/containers/concepts/architecture/)。
