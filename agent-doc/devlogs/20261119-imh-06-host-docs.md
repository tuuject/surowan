# Surowan - 20261119 IMH-06：多 IM Host 铺路的文档收尾与计划归档

## 背景

这是 `agent-doc/design/archived/20261117 多 IM Host 铺路实施计划.md` 的最后一个工作包 IMH-06。IMH-01 至 IMH-05 已分别在 #111～#116 合并：

- Topic id 改为 bigint，`host_kind` 严格解析；
- 迁移 064 让存储标识与 Host 无关；
- Host 特征表；
- 配置投影与 chatId 拆分；
- 入站契约与中性入库路径。

代码落地之后，主题文档还停在旧状态：

- `architecture.md` 没有特征表、配置投影、入站契约和边界测试；
- `data-layer.md` 仍按 `telegram_message_id` / `local_sequence_no` 描述消息编号；
- `telegram-agent-flow.md` 仍引用已删除的 `src/startup-catch-up.ts` 和 `telegram-ingestion/buckets.ts`；
- `verification.md` 没有收录新增的测试；
- `agent-doc/README.md` 的历史索引里，20260928「Core 与 Telegram Adapter 分离 Epic」仍写着「规划完成，未实施」，与事实不符（计划「已确认」第 3 条）。

计划的「完成条件」还要求把「新增一个 Host 所需的 core 改动」写成固定清单，放进 `architecture.md`。

本次改动由 Devin（`swe-2-high`，thought_level `max`，T3 子线程「IMH-06: agent docs, index and plan archival」）完成初稿。主会话逐段对照源码核对，并直接修正了 4 处事实偏差。

## 主要变更

### 1. architecture.md

- 「Runtime 与宿主边界」一节新增 IM Host 解耦说明，共五层：
  - 身份：`HOST_KINDS`、`parseHostKind` / `isHostKind`、bigint Topic；
  - 特征表；
  - 配置投影；
  - 入库契约：Telegram 边缘与 `src/ingress/intake/` 的职责划分、`MessageCues`、原始片段读取器；
  - 投递策略。
- 写明三条边界测试各自约束什么。允许清单以测试文件为准，文档里不抄一份。
- 新增「新增一个 Host 的固定清单」小节，共 13 项。这份清单是从代码里所有 `Record<HostKind, …>`、穷举 `switch` 和 `unreachableHostKind` 的位置逐一归纳出来的，比计划原文的 5 项多，具体包括：
  - `wireChatId` 的分派；
  - warning catalog 的连接告警码；
  - 快照渲染与校验；
  - 媒体下载器注册；
  - `serve.ts` 与 AgentRuntime 的 `hosts` 表；
  - 插件的挂载声明；
  - 冻结面（Admin 字段、`snapshotFormat`、wording）不动。
- 主数据流图拆成「Telegram 边缘 → InboundIntake」两段，模块表的 ingress 一行同步更新；删掉了对已不存在的 `src/startup-catch-up.ts` 的引用。

### 2. 其余主题文档

- `data-layer.md`：
  - 新增迁移 064 一段：改了哪些列、`message_no` 如何合并、去掉了 CHECK 与 DEFAULT、唯一键怎么定、`@rebuild-tables`，以及回滚限制。
  - `host_kind` 的合法性写成应用层职责，按原生 id 反查要经 `src/store/host-scope.ts`。
  - 房间消息的编号改为 `message_no`，062 索引的列名同步更新。
- `telegram-agent-flow.md`：
  - 「接收边界」写明边缘与中性 intake 各自负责什么。
  - 写明 `/ask` 的两种口径：实时消息看 update 种类，存储片段看 `edit_date`。
  - 补上 catch-up 的新位置；`buckets.ts` 的路径改为 `src/ingress/intake/`。
  - 内部表名一律写作 `host_sends`，cutoff 列写作 `message_no`。
- `configuration.md`：
  - 新增「配置投影」一节：访问器清单、边界测试、`internalChatId` 与 `hostChatId` 两种 id；配置文件格式不变。
- `verification.md`：测试命令清单加一行；测试索引新增 15 行，覆盖 IMH-01～05 新增的测试文件。
- `AGENTS.md`：
  - Project Structure 补上 `intake/`、`playground.ts`、`send/`。
  - Architecture Overview 加一段 Host 边界总述，链接到固定清单。
  - Security Invariants 加一条：Host 差异只能出现在各 Host 自己的边界文件里。

冻结的对外名称都没有改：Admin HTTP 字段（`telegram_chat_id`、`telegram_message_id`、`room_seq`、`telegram_sends[]`）、结构化日志字段、`send_reply` 结果文本、`telegram_startup_catch_up` 键、`telegram_updates` 表、`plasticwan.*`。

### 3. 历史索引与归档

- 20260928 Epic 一行改为：已实现，主体经 20261014 宿主解耦与本计划陆续落地；「不实施其他 IM Adapter」的结论不变。
- 计划用 `git mv` 移到 `agent-doc/design/archived/`，内容不变。索引新增一行，写明状态：已实现；「推迟到 Discord 接入时」所列各项没有做；真实 Telegram 验收待用户执行。

### 4. 主会话修正的事实偏差

| 位置 | 初稿 | 实际 |
| --- | --- | --- |
| `data-layer.md` 迁移 064 段 | `local_reply_to_message_id` 也改了名 | 这一列保持原名；改名的只有 cutoff、attention、`host_sends` 三列 |
| `data-layer.md` 迁移 064 段 | 唯一约束「一律」以 `host_kind` 开头 | 只有 `chats`、`senders` 是这样；`messages` 的唯一键是 `(chat_id, message_no)` |
| `data-layer.md` 的 `host_kind` 段、`AGENTS.md` 的 Security Invariants | `message_no` 也算原生 id，要经 host-scope 限定 Host | `message_no` 只在内部 `chat_id` 内唯一，按它查询必须同时带内部 Chat ID |
| `configuration.md` 配置投影访问器清单 | 列入了 `wireChatId` | 它是 `identity.ts` 的私有函数，不属于配置投影；改为说明 `identityConversation` 按同一规则选线上 id |

## 验证

```bash
git diff --cached --check
# 无输出
pnpm run lint
# 通过
pnpm test test/file-token-limit.test.ts
# 4 passed
node <scratchpad>/check-links.mjs AGENTS.md agent-doc/{README,architecture,configuration,data-layer,telegram-agent-flow,verification}.md
# 检查改动文档里的相对链接：只报出 telegram-agent-flow.md 里两处原有的 `[…](url)` 示例文字，它们不是链接
```

这次没有 AI review：ocr 默认跳过 Markdown，0 个文件进入审阅；由主会话逐段对照源码核对。文档只描述行为，没有改代码，所以没跑全量测试和 e2e。`apps/docs/` 没有动，不需要 `docs:build`。

子 agent 核对时还报告了两处命名残留，判断为有意保留：

- `store/participation.ts` 与 `capabilities/send/publish.ts` 的日志仍用 `telegram_message_id` 作键名，这是计划 D5 冻结的结构化日志字段名。
- `scene/render.ts` 仍读快照的 `telegram_date` 键，这是冻结快照格式。

未执行：真实 Telegram 验收，需要用户执行。各包的 devlog 与 PR 都列了建议清单，汇总如下：

- 私聊、群、Forum Topic 的收发、回复、编辑；
- 活跃时段外的三种触发、`/ask`；
- `/pause` 期间重启后的补偿；
- Sticker 与图片；
- 一次 Alarm 回执；
- 已迁移超级群的配置；
- 升级前后 Admin 的消息、Invocation、Context、群聊记忆页面。

## 提交

```txt
a6c1f75c Document the multi-IM host boundaries and archive the plan
```
