# Decisions 入场闸门实施计划

没有对应 PRD。本文是 AI 直出的实施契约，来源是 2026-11-10 至 2026-11-12 与用户的讨论和六轮离线评估；用户在讨论中确认的内容见[已确认](#已确认)，其余未经逐条审核，其中需要用户拍板的集中在[待用户确认](#待用户确认)。判断现状仍以源码为准，文中的文件路径与行为描述取自写作时的 `develop`，动手前请核对。

评估的方法、数据与全部数字见 [`agent-doc/investigations/2026-11-11-decisions-api-gate-eval.md`](../investigations/2026-11-11-decisions-api-gate-eval.md)，本文只引用结论。

## 目标

让 bot 在群聊里少插话。在 Bucket 到期、即将创建或 attach Invocation 之前，用一个决策模型（默认 `typesafe/jev-1.14`）判断这批消息值不值得交给主模型；不值得的批次直接关闭，不启动 Invocation。

这是人格 prompt 之后的最后一道阀门，不替代 prompt：发不发言、说什么仍由主模型决定，闸门只负责不把明显不需要回应的批次交给它。

## 为什么这样做

- 用户认可 `deepseek/deepseek-v4-flash-0731` 在线上的发言分寸。以它在群里的实际发言为标签，`jev-1.14` 用一句是非题预测「这批它会不会回」的 AUC 是 0.933。
- 阈值取 0.57 时，在留出数据上丢掉范本会回的 3/71，拦掉范本沉默的 82/129。把同一阈值用在其他主模型实际发出的 54 条回复上，拦掉 14 条，其中没有用户标注为「该回」的。
- 决策请求 p50 约 0.7 秒、p90 约 0.8 秒，评估时一次请求带 7 个问题，每千次约 $0.10；上线只带 1 个问题，会更低。400 次调用零报错。
- 「继续积攒」没有可用信号：六轮里它的 AUC 都在 0.5 附近，所以闸门只有「送入」和「抛弃」两个结果。

## 已确认

1. 目标是让 bot 少插话，决策模型作为最后一道阀门，人格 prompt 不动。
2. 范本是 `deepseek/deepseek-v4-flash-0731` 发到群里的 `send` 行为。
3. 下列四种情况不走决策模型，直接按现有流程处理（2026-11-12 确认）：
   - 有人 @ bot；
   - 命中配置的触发关键词；
   - 回复 bot 之前发的消息；
   - 长程任务的完成回执注入。
4. 用户可以覆盖默认的提问文本（2026-11-12 确认），并配置传入的历史条数和批内条数。

## 行为契约

### 何时经过闸门

一个到期的 Bucket 只有同时满足下列条件才经过闸门，否则行为与现在完全一致：

- 所在 Chat 解析后的 `decision_gate.enabled` 为 `true`。
- Chat 的 `host_kind` 是 `telegram`，且不是私聊。Playground 房间不经过闸门。
- Bucket 的 `kind` 是 `realtime`。`startup_catch_up` 批次不经过闸门，`src/orchestration/invocation-queue/catch-up.ts` 不改。
- 批内没有直接触发：@ bot、回复 bot 的消息、命中触发关键词，三者任一出现在批内任意一条消息上，整批直接送入。判定复用 `ProactiveReplyGate` 现有的批内直接触发检查（`src/orchestration/proactive-reply.ts` 的 `#directTriggerKind` 与 `sqlDirectMessages`），抽成两处共用的函数，不写第二份。
- 现有闸门全部通过：Chat 未暂停、仍在配置里、Agent 三元组完整、未在睡眠。这些闸门拦下的批次不发决策请求。

长程任务的完成回执不经过闸门。它走的是另一条路径：`src/orchestration/invocation-queue/receipts.ts` 自己建 Bucket 并直接入队或排队注入，不经过 `processDueBuckets`。这个文件不改；注意它建的 Bucket 的 `kind` 也是 `realtime`，所以不能只靠 `kind` 来判断是否经过闸门，要靠接入点只在 `due.ts`。测试要有一条断言：闸门处于 `enforce` 且决策服务会返回「抛弃」时，回执照常产生 Invocation 或注入，且没有发出决策请求。

闸门同时作用于「新开 Invocation」（`queueCollectingBucket`）与「attach 到运行中的 Invocation」（`attachDueBucket`）两条路径，与 `proactiveAllows` 的覆盖面相同。send 屏障（`holdForNewMessages`）自己取走 `collecting` Bucket 的路径不经过闸门，保持现状。

### 与主动回复概率的关系

某个 Chat 的闸门处于 `enforce` 模式时，该 Chat 不再做主动回复抽样，`proactiveAllows` 视为放行且不动保底计数。理由是两者叠加时，抽中后又被闸门抛弃会白白清零保底计数。`shadow` 模式不影响抽样。这一条待用户确认。

### 两种模式

| 模式 | 决策请求 | 对 Bucket 的影响 |
| --- | --- | --- |
| `shadow` | 异步发出，只记录结果 | 无。Bucket 立刻按现有路径继续，不等待结果 |
| `enforce` | 发出并等待结果 | 结果为「抛弃」时关闭 Bucket；其余情况送入 |

默认 `shadow`。`shadow` 模式下闸门不得改变任何调度时序，测试要断言这一点。

### 判定

- 请求只带一个 `noul` 问题，取返回的 P(yes)。
- `P(yes) >= threshold` 送入，否则抛弃。
- **一切异常都送入**：超时、网络错误、非 2xx、响应形状不合法、模型返回 `refusal`、配置了闸门但没有可用的 API key。不重试。
- 抛弃的 Bucket 置为 `skipped_budget`，`error_code = 'decision_gate_dropped'`，用现有的 `markBucketSkipped`。消息、Revision 与 `bucket_messages` 全部保留，后续仍作为 history 进入 Context，与主动回复未命中一致。

### 请求内容

端点 `POST {base_url}/decisions`，`base_url` 默认 `https://openrouter.ai/api/alpha`。请求体：

```json
{
  "model": "typesafe/jev-1.14",
  "state": {
    "bot": { "name": "塑料碗", "username": "TcdwLobsterBot" },
    "history": [{ "from": "发送者显示名", "text": "正文", "reply_to": "被回复者: 被回复正文前 80 字" }],
    "pending": [{ "from": "发送者显示名", "text": "正文" }]
  },
  "questions": { "gate": { "type": "noul", "instructions": "…" } }
}
```

渲染规则，评估时就是这样喂的，改动会让阈值失效：

- `history`：该 Conversation 中早于本批第一条消息的最近 `history_messages` 条可见消息，按时间正序，不含本批消息。
- `pending`：本批最后 `pending_messages` 条可见消息的当前 Revision，按 `sequence_no` 正序。
- `from`：bot 自己的消息写作 `<bot 显示名> [bot]`，其余用发送者显示名。
- `text`：取 `text`，没有则取 `caption`，截到 500 字符。`kind` 不是 `text` 时在前面加 `[kind]`，例如 `[photo] 配文`、`[sticker]`。不传图片。
- `reply_to`：仅当消息带回复快照时出现；被回复者是 bot 时写作 `<bot 显示名> [bot]`。
- 默认 `instructions`：

  > A group chat has an AI member named {{ bot.name }} (@{{ bot.username }}), described in `bot` and shown as `{{ bot.name }} [bot]`. `pending` holds the new messages since the bot last looked; `history` holds earlier messages. Would the bot, behaving like a friendly regular member, send a reply after reading `pending`?

  配置里的 `instructions` 整段替换它，支持同样的两个占位符，全局与单个 Chat 都可以覆盖。覆盖后的文本必须仍是一个是非题，且「是」表示应当送入，因为判定固定为 `P(yes) >= threshold`；这一点写进字段说明。换了提问以后 0.57 这个阈值不再有依据，文档里要提醒先用 `shadow` 重新观察。占位符替换看一下 `src/platform/prompt-template.ts` 能否复用。

消息内容是不可信数据，只放在 `state` 里，不拼进 `instructions`。

## 调度实现

难点：`processDueBuckets`（`src/orchestration/invocation-queue/due.ts`）整体是一个同步 SQLite 事务，决策是约 1 秒的异步 HTTP。不要把事务改成异步，也不要在事务里发请求。按两段做：

**第一段，事务内。** 到期 Bucket 通过现有闸门、确定需要决策后：

1. 记下批次指纹：当前最大的 `bucket_messages.sequence_no`。
2. 写一行 `bucket_decisions`（`state = 'pending'`），并在事务内读出构造请求所需的消息。
3. `enforce` 模式：把 `deadline_at` 推到 `now + timeout_ms + 500ms`（只往后推，写法参照同文件的 `deferBucket`），Bucket 保持 `collecting`，本轮不入队也不 attach。把 Bucket 记入内存里的「决策中」集合。
4. `shadow` 模式：不改 Bucket，继续走现有的入队或 attach。
5. 事务提交后发请求。

推 `deadline_at` 是为了让 `nextDelayMilliseconds`（`src/orchestration/scheduler/loop.ts`）不在一个已过期的 deadline 上空转，同时保证进程崩溃后这批消息会在几秒后被正常重新处理。决策期间到达的消息照常追加进同一个 `collecting` Bucket。

**第二段，请求返回后，新事务内。** 仅 `enforce` 模式有后续动作：

1. 更新 `bucket_decisions` 行的结果字段。
2. 重读 Bucket。如果它已经不是 `collecting`（被 send 屏障取走、Chat 被暂停后过期、Chat 被删除等），把该行标成 `stale`，结束。
3. 结果为**送入**：把 Bucket 记入内存里的「已放行」集合，把 `deadline_at` 设为 `now`，然后唤醒 Scheduler。下一轮 `processDueBuckets` 看到已放行标记就跳过闸门，走完整的现有路径。这样运行中轮次的推迟、attach、暂停与睡眠检查都不需要复制一份。
4. 结果为**抛弃**：如果最大 `sequence_no` 与第一段记下的指纹相同，调用 `markBucketSkipped`。如果不同，说明决策期间来了新消息，这个结论已经过期：把该行标成 `stale`，把 `deadline_at` 设为 `now` 并唤醒 Scheduler 重新决策。同一个 Bucket 最多重新决策 2 次，之后按送入处理。
5. 从「决策中」集合移除。

实现要点：

- 「决策中」与「已放行」是进程内状态，放在 `InvocationQueueDeps` 能访问到的闸门对象里，与 `ProactiveReplyGate` 的装配方式一致（`src/orchestration/invocation-queue/index.ts` 的构造函数）。进程重启后丢失是可以接受的：Bucket 会被重新决策一次。
- 「已放行」的 Bucket 之后可能因为运行中的轮次被 `deferBucket` 再推一个窗口并继续攒消息，放行标记保持有效，不重新决策。Bucket 离开 `collecting` 时清掉标记，避免集合无限增长。
- 到期查询要跳过「决策中」的 Bucket，防止 deadline 被别的路径改早后重复发请求。
- 唤醒 Scheduler：`BucketScheduler` 已有 `wake()`，`LongTaskService` 的构造参数是现成的回调注入范例（`src/ingress/admin/routes/index.ts` 里的 `() => scheduler?.wake()`）。
- 同一时刻每个 Bucket 至多一个在途请求。全局在途请求数设一个小上限（建议 4），超出时该 Bucket 按送入处理并记录 `error_code = 'concurrency_limit'`，不排队。
- 进程停止时在途请求用 `AbortSignal` 取消，不阻塞 `stop()`。

## 配置

全局段 `telegram.decision_gate` 与每个 Chat 的 `telegram.chats[].decision_gate`，逐字段继承，写法照抄 `proactive_reply`（`ProactiveReplySchema` 在 `src/platform/config/schema-sections.ts`，解析在 `src/platform/proactive-reply.ts`，私聊不允许配置的校验在 `src/platform/config/semantics.ts`）。

| 字段 | 类型 | 默认 | 层级 | 说明 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `false` | 全局、Chat | 关闭时零影响 |
| `mode` | `'shadow'` \| `'enforce'` | `'shadow'` | 全局、Chat | |
| `threshold` | number，0–1 | `0.57` | 全局、Chat | 与模型绑定，换模型必须重定 |
| `history_messages` | integer，0–50 | `10` | 全局、Chat | |
| `pending_messages` | integer，1–50 | `10` | 全局、Chat | |
| `instructions` | string | 见上文默认提问 | 全局、Chat | |
| `model` | string | `'typesafe/jev-1.14'` | 仅全局 | |
| `base_url` | string | `'https://openrouter.ai/api/alpha'` | 仅全局 | 必须 HTTPS，不带凭据 |
| `api_key` | SecretRef | 无 | 仅全局 | 不接受明文 |
| `timeout_ms` | integer，500–10000 | `3000` | 仅全局 | |

- `enabled` 为 `true` 但没有 `api_key` 时，`check-config` 报错。
- 所有字段热更新：在 `src/platform/config/diff-merge.ts` 里仿照 `HOT_PROACTIVE_REPLY_PATHS` 加路径，闸门每次决策读取当前已发布的配置。`api_key` 的 SecretRef 怎么在热更新后重新解析，先看现有可热更新的密钥是怎么做的（搜索配置的 `api_key` 是一个起点），沿用同一做法；如果现有机制做不到热更新，就把 `api_key`、`base_url`、`model` 归为需要重启，并在文档里写明。
- `ConfigSchema` 的改动会进入生成文档，需要跑 `docs:build` 与 `docs:verify`，见下文验证。

## 数据与审计

新迁移 `054_bucket_decisions.sql`，同步 `src/store/schema/`。表 `bucket_decisions`：

| 列 | 说明 |
| --- | --- |
| `id` | 主键 |
| `bucket_id` | 外键到 `buckets`，级联删除 |
| `conversation_id` | 外键到 `conversations`，级联删除 |
| `mode` | `shadow` 或 `enforce` |
| `model` | 请求用的模型 id |
| `state` | `pending`、`success`、`error`、`stale` |
| `outcome` | `enter`、`drop`，未得出时为 null |
| `applied` | 这次结果是否真的决定了 Bucket 的去向 |
| `probability`、`threshold` | P(yes) 与当时的阈值 |
| `history_count`、`pending_count` | 实际送出的条数 |
| `input_tokens`、`cost`、`duration_ms` | 来自响应的 `usage` 与本地计时 |
| `error_code`、`error_detail` | 稳定错误码与经 `SecretStore.redact` 处理的详情 |
| `created_at`、`finished_at` | |

- 不复用 `model_calls`：它的 `role` 有 CHECK 约束，而且被抛弃的 Bucket 没有 Invocation 可挂。
- 不存请求体。消息原文已经在库里，按 `bucket_id` 可以重建。
- 进程启动时把残留的 `pending` 行标成 `error`、`error_code = 'interrupted'`。
- 保留期与其他审计数据一致，按 `retention.online_days` 清理；找到现有的清理入口加进去，并更新 `agent-doc/data-layer.md`。
- 每次决策另打一行结构化日志，事件名 `agent_decision_gate`，字段参照 `agent_proactive_reply_sampled`，不含消息正文。
- 决策的 token 不计入 `daily_budget`。

查看入口：

- `scripts/audit.ts` 在展示 Bucket 或排查「为什么不回复」时显示该 Bucket 的决策行。
- Admin API 增加一个只读端点，按 Chat 与时间倒序列出决策行（带 `bucket_id`、`outcome`、`probability`、`applied`、`mode`），并在 `packages/admin-surface` 登记，使 `surowan-utils` 与 MCP 可读。这是评审影子数据的唯一手段，属于本期范围。审计 API 只读，过滤参数走白名单与绑定参数。
- Admin Panel 前端页面不在本期范围。

## 模块落点

| 位置 | 内容 |
| --- | --- |
| `src/platform/decisions.ts` | Decisions API 的薄客户端：构造请求、超时、TypeBox 校验响应、错误归类。无业务依赖。HTTP 禁止重定向 |
| `src/platform/decision-gate.ts` | 配置解析与默认值，对应 `src/platform/proactive-reply.ts` |
| `src/orchestration/decision-gate.ts` | 闸门本体：进程内状态、请求内容的组装、两段流程，对应 `src/orchestration/proactive-reply.ts` |
| `src/orchestration/invocation-queue/due.ts` | 在两条路径上接入闸门 |
| `src/store/migrations/054_bucket_decisions.sql`、`src/store/schema/` | 新表 |

如果闸门相关文件超过两个同前缀平铺文件，按仓库的目录规则收进 `decision-gate/`。不新增第二套 Provider 约定：Decisions API 不是 chat completions，不进 Provider 注册表，但密钥、脱敏与超时沿用现有模块。

## 可能的失败方式

写代码之前先对照这张表，测试要覆盖每一行：

| 情形 | 期望 |
| --- | --- |
| 请求超时、连接被重置、DNS 失败 | 送入，`state = 'error'` |
| HTTP 401、402、429、5xx | 送入，记录状态码 |
| 响应不是合法 JSON，或缺少 `answers.gate.noul` | 送入 |
| 模型对问题返回 `refusal` | 送入 |
| 决策期间 Bucket 收到新消息，结果是抛弃 | 不抛弃，重新决策，最多 2 次，之后送入 |
| 决策期间 Bucket 收到新消息，结果是送入 | 带着全部消息送入 |
| 决策期间 Bucket 被 send 屏障取走 | 结果标 `stale`，不动 Bucket |
| 决策期间 Chat 被暂停或从配置中移除 | 结果标 `stale` 或由下一轮现有闸门处理，不产生 Invocation |
| 决策期间配置把闸门关掉或切到 `shadow` | 已发出的请求返回后不得抛弃 Bucket |
| 决策期间进程退出 | 重启后 Bucket 仍是 `collecting`，被重新处理；残留 `pending` 行被标记 |
| 已放行的 Bucket 因轮次进行中被推迟 | 不重新决策，轮次结束后送入 |
| 批内有 @、回复 bot 或关键词 | 不发请求，直接送入 |
| 长程任务完成回执到期 | 不发请求，回执路径行为不变 |
| 配置了自定义 `instructions` | 请求里用的是覆盖后的文本，占位符已替换；Chat 级覆盖优先于全局 |
| `shadow` 模式 | Bucket 的状态转换与时序同未开启时一致，只多出决策行 |
| 闸门关闭 | 不发请求，不写决策行，现有测试全部不变 |
| 在途请求达到上限 | 送入，记录 `concurrency_limit` |
| 错误信息里带有密钥 | 落库与日志前已脱敏 |

## 验证

按 AGENTS.md 的测试规则，这些属于隔离测试，写在 vitest，放 `test/decision-gate/`。Decisions API 用本地 HTTP fixture 或注入的 fetch 替身，不连真实服务；调度走真实的 `BucketScheduler` 与 `InvocationQueueService`，参考 `test/proactive/` 与 `test/context/hot-inject-send-barrier.test.ts` 的搭法。

- 断言落盘状态，不只断言返回值：`buckets.state` 与 `error_code`、`bucket_decisions` 各列、是否产生了 `invocations` 行、`invocation_buckets` 的 attach 行。
- 时间只用一种基准，全部从当前时钟推导或全部用注入的时钟，不写死承担「未来」语义的绝对时间。
- 配置：继承、默认值、私聊拒绝、缺 `api_key` 报错、热更新分类。
- 交付前运行：受影响测试、完整 `pnpm test`、`pnpm run check`、`pnpm run lint`、`git diff --check`；因为改了 `ConfigSchema`，再跑 `pnpm run docs:build` 与 `pnpm run docs:verify`（`DOCS_BASE_PATH=/` 与 `/surowan/` 各一遍），构建后 `git status --porcelain` 应为空；加了 Admin API 端点，跑 `pnpm run admin:test:e2e` 的受影响套件。
- 真实 Decisions API 的连通性不在自动测试里。`doctor` 是否增加一项探测由实现者判断：加的话必须是只在闸门开启时执行的一次最小请求。

文档同步：`agent-doc/configuration.md`（字段与热更新）、`agent-doc/telegram-agent-flow.md`（Bucket 到期流程与新的跳过原因）、`agent-doc/data-layer.md`（新表与保留）、`agent-doc/admin-panel.md`（新端点）、`agent-doc/verification.md`（真实环境对照项），以及 AGENTS.md 的项目目标列表。

## 不做

- 「继续积攒」这个结果，以及任何基于模型的延长收集窗口。
- 发送前对草稿再判一次。评估显示没有收益。
- 把图片传给决策模型。
- 用 chat completions 模型做闸门。
- Admin Panel 的配置表单与决策列表页面。
- 重放时模拟闸门：重放直接从冻结快照开始，不经过闸门。
- 根据影子数据自动调阈值。

## 上线顺序

1. 合入后默认关闭，现有部署无变化。
2. 在一个群上开 `shadow`，跑大约一周。
3. 用只读端点导出决策行，对照这段时间 bot 的实际发言，核对 0.57 这个阈值是否仍然合适。
4. 用户决定是否切到 `enforce`。

## 待用户确认

1. `enforce` 模式下该 Chat 停用主动回复抽样，而不是两者叠加。
2. 默认模型用 `typesafe/jev-1.14`。`perplexity/pplx-decider-flash-v1.2` 在评估里略好且便宜约 6 倍，但早先在 4 路并发下出现过 429。
3. 决策的 token 与花费不计入 `daily_budget`。
4. Admin Panel 页面留到下一期。

## 工作方式

- 开发流程按 `surowan-dev-create-feature` skill：从最新的 `origin/develop` 建 worktree，分支建议 `feature/decision-gate`，完成后验证、提交、写 devlog、push、开 PR。
- 提交信息用简短英文祈使句。PR 说明列出行为变化、数据库与配置影响、验证证据，以及真实环境里还没做的检查。
- 实现中发现本文与源码不符时以源码为准，并在 PR 说明里写出偏离的地方和原因。遇到[待用户确认](#待用户确认)之外的产品决策，停下来问用户，不要自行决定。
- 不读取 `key.json`，不在任何输出里打印密钥。
