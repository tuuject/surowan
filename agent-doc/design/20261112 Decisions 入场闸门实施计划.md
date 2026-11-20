# Decisions 入场闸门实施计划

没有对应 PRD。本文是 AI 直出的实施契约，来源是 2026-11-10 至 2026-11-12 与用户的讨论和六轮离线评估；用户在讨论中确认的内容见[已确认](#已确认)，其余未经逐条审核，其中需要用户拍板的集中在[待用户确认](#待用户确认)。判断现状仍以源码为准，文中的文件路径与行为描述取自写作时的 `develop`，动手前请核对。

2026-11-20 对照 `develop`（`a02ba230`）复核并修订了一次，起因是 keychain、多 Host 边界与 `/ask` 在本文写成之后合入。修订内容与用户当日的确认见[已确认](#已确认)第 5、6 条。

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
5. Admin Panel 的配置表单属于本期范围（2026-11-20 确认），见 [Admin Panel 表单](#admin-panel-表单)。
6. 2026-11-20 复核得出的修订（同日确认）：密钥每次决策解析并计入超时预算；`doctor` 探测必做；闸门配置经 Host 投影读取，不写宿主字面量；`/ask` 计入直接触发；迁移编号顺延到 `066`；bot 显示名取自连接身份。

## 行为契约

### 何时经过闸门

一个到期的 Bucket 只有同时满足下列条件才经过闸门，否则行为与现在完全一致：

- 所在 Chat 解析后的 `decision_gate.enabled` 为 `true`。
- Chat 所属 Host 的投影里有 `decision_gate`，且不是私聊。做法是在 `HostIntakeSettings`（`src/platform/config/projection.ts` 的 `hostIntakeSettings`）加一个 `decision_gate` 字段：Telegram 返回 `config.telegram.decision_gate`，Playground 返回 `undefined`，与 `proactive_reply` 同写法，Playground 房间因此不经过闸门。core 里不写 `'telegram'` 字面量分支，也不直接读 `config.telegram`，两者都会被边界测试拒绝（`test/im/host-literals.test.ts`、`test/config/host-projection-boundary.test.ts`）。
- Bucket 的 `kind` 是 `realtime`。`startup_catch_up` 批次不经过闸门，`src/orchestration/invocation-queue/catch-up.ts` 不改；运行中的补偿拉取（`finishRuntimeCatchUpQueue`）建的也是这种批次，同样不经过。
- 批内没有直接触发：`/ask`、@ bot、回复 bot 的消息、命中触发关键词，任一出现在批内任意一条消息上，整批直接送入。判定复用 `ProactiveReplyGate` 现有的批内直接触发检查（`src/orchestration/proactive-reply.ts` 的 `#directTriggerKind` 与 `sqlDirectMessages`，其中已经包含 `ask`），抽成两处共用的函数，不写第二份。`participation.ask_only` 为 true 的 Chat 只有 `/ask` 能开 Bucket，所以它的批次全部是直接触发，闸门不会发请求。
- 现有闸门全部通过：Chat 未暂停、仍在配置里、Agent 三元组完整、未在睡眠。这些闸门拦下的批次不发决策请求。

长程任务的完成回执不经过闸门。它走的是另一条路径：`src/orchestration/invocation-queue/receipts.ts` 自己建 Bucket 并直接入队或排队注入，不经过 `processDueBuckets`。这个文件不改；注意它建的 Bucket 的 `kind` 也是 `realtime`，所以不能只靠 `kind` 来判断是否经过闸门，要靠接入点只在 `due.ts`。测试要有一条断言：闸门处于 `enforce` 且决策服务会返回「抛弃」时，回执照常产生 Invocation 或注入，且没有发出决策请求。

另有两条路径同样自己建 `realtime` Bucket 并绕过 `processDueBuckets`，都不经过闸门，也都不改：管理员定义的循环闹钟（到期后物化成任务，走上面的回执管线），以及从面板恢复失败的 Invocation（`src/orchestration/invocation-queue/resume.ts`，Bucket 直接以 `queued` 建出）。测试对这两条各补一条与回执相同的断言。

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
- **一切异常都送入**：超时、网络错误、非 2xx、响应形状不合法、模型返回 `refusal`、密钥解析不出来（引用的 keychain 条目不存在、环境变量未设置、`command` 失败或超时，`error_code = 'secret_unresolved'`）。不重试。
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
- `bot.name` 与 `bot.username`：取自连接身份（`src/adapters/local-monolith/telegram/instance.ts` 的 `TelegramConnectionIdentity`，已有 `displayName` 与 `username`）。这两个 getter 读的是建立连接时 `getMe` 存在内存里的结果，不调用 Telegram API。闸门持有这个身份对象，每次决策时读它，不要在构造时把名字拷贝成字符串存起来：`telegram.token` 可以热换，连接管理器会换掉内存里的身份，拷贝会停在旧名字上。现在传给 `ProactiveReplyGate` 的 `BotIdentity`（`src/platform/im-host/cues.ts`）只有 `id` 与 `username`，显示名要另外传进闸门。
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
5. 事务提交后解析密钥并发请求，两步共用同一个 `timeout_ms` 预算，见[密钥](#密钥)。

推 `deadline_at` 是为了让 `nextDelayMilliseconds`（`src/orchestration/scheduler/loop.ts`）不在一个已过期的 deadline 上空转，同时保证进程崩溃后这批消息会在几秒后被正常重新处理。决策期间到达的消息照常追加进同一个 `collecting` Bucket。`nextDelayMilliseconds` 不认识「决策中」集合，所以第 5 步的总耗时必须被 `timeout_ms` 封顶：一旦超出，推后的 deadline 过期而 Bucket 仍被到期查询跳过，Scheduler 就会空转到请求返回。

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

全局段 `telegram.decision_gate` 与每个 Chat 的 `telegram.chats[].decision_gate`，逐字段继承，写法照抄 `proactive_reply`（`ProactiveReplySchema` 在 `src/platform/config/schema-sections.ts`，解析在 `src/platform/proactive-reply.ts`，私聊不允许配置的校验在 `src/platform/config/semantics.ts`）。运行时代码只经 `hostIntakeSettings(config, hostKind).decision_gate` 与解析出的 Chat 条目读取，见[何时经过闸门](#何时经过闸门)。

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
| `api_key` | SecretRef | 无 | 仅全局 | `{ "jar": "<条目名>" }`、`env` 或 `command`；不接受明文 |
| `timeout_ms` | integer，500–10000 | `3000` | 仅全局 | 密钥解析与 HTTP 请求的总预算 |

- `enabled` 为 `true` 但没有 `api_key` 时，`check-config` 报错。它只查字段在不在，不解析引用。
- 所有字段热更新，包括 `api_key`、`base_url` 与 `model`：在 `src/platform/config/diff-merge.ts` 里仿照 `HOT_PROACTIVE_REPLY_PATHS` 加 `HOT_DECISION_GATE_PATHS`，闸门每次决策读取当前已发布的配置。
- `ConfigSchema` 的改动会进入生成文档，需要跑 `docs:build` 与 `docs:verify`，见下文验证。

### 密钥

`api_key` 用 keychain（`src/platform/keychain.ts`，面板里叫「密钥」）。条目有稳定的名字，可以多处共用、原地轮换。

- **写法。** `{ "jar": "<条目名>" }`。默认 `base_url` 是 OpenRouter，已经配了 OpenRouter Provider 的部署可以直接引用同一个条目，不必再存一份。
- **每次决策解析。** 发请求前调用 `SecretStore.resolve`，做法与联网搜索相同（`src/plugins/web-search/request.ts` 的 `buildRequest`）。对 keychain 条目，`resolve` 每次都重读本地的 `key.json`，不走网络，所以面板里轮换条目、手工改文件、改引用指向都在下一次决策生效。不需要像 Provider 那样记摘要，也不需要在 `src/adapters/local-monolith/config/reload-apply.ts` 里登记。
- **计入超时。** `command` 引用最长运行 5 秒，且 `resolveCommand`（`src/platform/secrets.ts`）不接受 `AbortSignal`。解析要和 HTTP 请求一起放进同一个 `timeout_ms` 计时：到点即按送入处理，`error_code = 'secret_unresolved'`，不等子进程，它会被自己的计时器结束。
- **使用处自动识别。** keychain 的使用处与孤儿判断是对配置做结构化遍历（`collectSecretReferences`），新字段不用登记；被这里引用的条目不会被当成孤儿清理。
- **脱敏。** `resolve` 过的值自动进入 `SecretStore.redact` 的已知值集合，`error_detail` 与日志照常经它处理。
- **引用悬空不会报错。** 条目不存在只在运行时暴露，而闸门的规则是异常一律送入，于是闸门会静默失效，只留下 `secret_unresolved` 的决策行。所以 `doctor` 的探测是必做项，见[验证](#验证)。

## 数据与审计

新迁移 `066_bucket_decisions.sql`（写作时最新的是 `065_image_asset_metadata.sql`，动手前再核对一次编号），同步 `src/store/schema/`。表 `bucket_decisions`：

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
- 保留期与其他审计数据一致，按 `retention.online_days` 清理。不需要另加清理语句：`src/store/store.ts` 的保留期清理已经按这个窗口删除结束状态的 `buckets`，决策行靠外键级联一起删。测试断言这一点，并更新 `agent-doc/data-layer.md`。
- 每次决策另打一行结构化日志，事件名 `agent_decision_gate`，字段参照 `agent_proactive_reply_sampled`，不含消息正文。
- 决策的 token 不计入 `daily_budget`。

查看入口：

- `scripts/audit.ts` 在展示 Bucket 或排查「为什么不回复」时显示该 Bucket 的决策行。
- Admin API 增加一个只读端点，按 Chat 与时间倒序列出决策行（带 `bucket_id`、`outcome`、`probability`、`applied`、`mode`），并在 `packages/admin-surface` 登记，使 `surowan-utils` 与 MCP 可读。这是评审影子数据的唯一手段，属于本期范围。审计 API 只读，过滤参数走白名单与绑定参数。
- `GET /config/view` 的显式投影（`src/ingress/admin/config-inspection.ts`）加上闸门的非密钥字段，与 `proactive_reply` 并列；`api_key` 与 `base_url` 不进这个投影。
- 决策行的列表页面不在本期范围，配置表单在，见下一节。

## Admin Panel 表单

本期范围（2026-11-20 确认）。`configure` 向导已经停止扩展，新的配置入口只做在面板里。下面的端点形状与页面位置是实施默认，未经用户逐条确认，列在[待用户确认](#待用户确认)。

### 端点

| 端点 | 行为 |
| --- | --- |
| `GET /decision-gate` | `{ revision, saved, active, key_configured, key_source? }`。`saved` 是磁盘文件的值，`active` 是运行中配置的值，缺省字段报告实际使用的默认值，写法同 `GET /harness`。`key_source` 只返回给面板会话 |
| `PUT /decision-gate` | 全局段的字段补丁：省略的字段保留，`null` 从文件删除该字段。`api_key` 是 `SecretInput`，`null` 删除引用。带 revision 的 `If-Match`，热应用 |
| `PUT /chats/:id/decision-gate` | 该 Chat 的覆盖，只接受六个可覆盖字段，同样是补丁语义；全部删空时移除整个 `decision_gate` 对象。私聊 400，未知 Chat 404 |

- 全局端点不并入 `PUT /harness`：那个端点的值只有数字、布尔、枚举、`null` 与字符串列表五种，放不下自由文本的 `instructions`、`base_url`，更放不下密钥。Chat 端点不沿用 `proactive-reply` 的 `{ mode: 'inherit' | 'off' | 'custom' }`，因为闸门自己有一个叫 `mode` 的字段，改用 `PUT /chats/:id/participation` 那种逐字段补丁。
- 三个端点都登记到 `packages/admin-surface/src/specs/`（`revision: 'config'`），于是进入 `surowan-utils` 与反向 MCP Server，按 API key 的 `read_all` / `write_all` 权限执行。两个写端点校验 `Origin`，并加进 `agent-doc/admin-panel.md` 的写端点白名单。
- `GET /chats` 的 Chat 视图带上该 Chat 的覆盖值，供 Chats 页显示。
- 跨字段校验沿用配置加载时的规则：`enabled` 为 `true` 时必须有 `api_key`，`base_url` 必须是 HTTPS 且不带凭据。不合法的写入在落盘前被拒绝。

### 密钥规则

`api_key` 走共享的 `SecretInput`（`src/ingress/admin/secret-input.ts` 的 `resolveSecretInput`），调用方类别照现有端点传入，实现照 `src/ingress/admin/search.ts`。

- 新明文默认条目名 `decision-gate`，重名加后缀；面板里可以改名。
- 面板会话可以用 `{ entry }` 选用已有条目，例如直接选 OpenRouter Provider 的那一个。API key 与已配对客户端提交 `{ entry }` 得到 403。
- 程序化凭据在保留原密钥的同时改 `base_url`，返回 400，要求同一次请求重新提交密钥。`base_url` 按生效值比较，从缺省改成显式地址也算变化。面板会话不受这条限制。这条规则防的是把一个共用的密钥指向别的地址。
- 当前条目只被这一处使用时，填新密钥是原地替换值（`rotate`），配置文件没有变化，不能走普通的配置写入，照搜索端点的做法处理；被别处共用时新建条目并改指向。
- 读端点对程序化凭据只返回 `key_configured` 布尔值。任何响应、应用结果与日志都不出现密钥的值，提交的明文先经 `SecretStore.remember` 登记。

### 前端

- 新页面 `/decision-gate`（`apps/admin-next/src/routes/decision-gate.tsx`、`pages/decision-gate.tsx`），导航项加在 `apps/admin-next/src/nav.ts` 里 Harness tuning 与 Search settings 所在的分组。中文标题「入场闸门」。
- 页面分两块：行为（开关、模式、阈值、历史条数、批内条数、提问文本）与连接（模型、地址、密钥、超时）。密钥输入用现成的 `apps/admin-next/src/components/secret-input/secret-field.tsx`。
- Chats 页加一个闸门对话框，仿 `apps/admin-next/src/components/chats/proactive-reply-dialog.tsx`，每个字段可以选「继承全局」或单独填写。
- 四个 locale（`en`、`zh-CN`、`de-DE`、`ar`）都要补键值。中文文案用现有术语表里的中文词，不在界面上写机制说明：「提问必须是是非题」「换了提问要重新观察阈值」这类提醒留在配置字段说明与用户指南里。
- 遵循 Koi 设计规范与不直接写 `useEffect` 的规则。

## 模块落点

| 位置 | 内容 |
| --- | --- |
| `src/platform/decisions.ts` | Decisions API 的薄客户端：构造请求、超时、TypeBox 校验响应、错误归类。无业务依赖。HTTP 禁止重定向 |
| `src/platform/decision-gate.ts` | 配置解析与默认值，对应 `src/platform/proactive-reply.ts` |
| `src/orchestration/decision-gate.ts` | 闸门本体：进程内状态、请求内容的组装、两段流程，对应 `src/orchestration/proactive-reply.ts` |
| `src/orchestration/invocation-queue/due.ts` | 在两条路径上接入闸门 |
| `src/platform/config/projection.ts` | `HostIntakeSettings` 加 `decision_gate` |
| `src/store/migrations/066_bucket_decisions.sql`、`src/store/schema/` | 新表 |
| `src/ingress/admin/decision-gate.ts`、`src/ingress/admin/chats.ts`、`src/ingress/admin/routes/` | 表单的读写端点与决策行的只读端点 |
| `packages/admin-surface/src/specs/` | 登记新端点 |
| `apps/admin-next/src/` | 页面、Chats 对话框、`lib/api/decision-gate.ts`、四个 locale |

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
| 批内有 `/ask`、@、回复 bot 或关键词 | 不发请求，直接送入 |
| Chat 开了 `ask_only` | 不发请求 |
| 长程任务完成回执到期 | 不发请求，回执路径行为不变 |
| 循环闹钟到期，或从面板恢复失败的 Invocation | 不发请求，各自路径行为不变 |
| Playground 房间的批次 | 不发请求，不写决策行 |
| 引用的 keychain 条目不存在，或环境变量未设置 | 送入，`error_code = 'secret_unresolved'` |
| `command` 引用的运行时间超过 `timeout_ms` | 到点送入，`secret_unresolved`；Scheduler 不空转 |
| 面板里轮换了被引用的条目 | 下一次决策的请求带新密钥，不需要重启或重载 |
| 程序化凭据向表单端点提交 `{ entry }` | 403，文件与 keychain 都不变 |
| 程序化凭据保留原密钥的同时改 `base_url` | 400，文件不变 |
| 表单写入让 `enabled` 为 `true` 而没有 `api_key` | 拒绝，文件不变 |
| 配置了自定义 `instructions` | 请求里用的是覆盖后的文本，占位符已替换；Chat 级覆盖优先于全局 |
| `shadow` 模式 | Bucket 的状态转换与时序同未开启时一致，只多出决策行 |
| 闸门关闭 | 不发请求，不写决策行，现有测试全部不变 |
| 在途请求达到上限 | 送入，记录 `concurrency_limit` |
| 错误信息里带有密钥 | 落库与日志前已脱敏 |

## 验证

按 AGENTS.md 的测试规则，这些属于隔离测试，写在 vitest，放 `test/decision-gate/`。Decisions API 用本地 HTTP fixture 或注入的 fetch 替身，不连真实服务；调度走真实的 `BucketScheduler` 与 `InvocationQueueService`，参考 `test/proactive/` 与 `test/context/hot-inject-send-barrier.test.ts` 的搭法。

- 断言落盘状态，不只断言返回值：`buckets.state` 与 `error_code`、`bucket_decisions` 各列、是否产生了 `invocations` 行、`invocation_buckets` 的 attach 行。
- 时间只用一种基准，全部从当前时钟推导或全部用注入的时钟，不写死承担「未来」语义的绝对时间。
- 配置：继承、默认值、私聊拒绝、缺 `api_key` 报错、热更新分类（含 `api_key`、`base_url`、`model`）。
- 表单端点（vitest，放 `test/admin/`）：补丁语义与 `null` 删除、revision 冲突、私聊与未知 Chat、[密钥规则](#密钥规则)里的每一条，以及响应、应用结果与日志里不出现密钥的值。断言落盘的 `config.jsonc` 与 keychain 条目，不只断言响应。
- 面板 E2E（Playwright，英文 locale）：`/decision-gate` 补进 `01-routes`；新增一个套件覆盖全局表单的保存与选用已有条目；仿 `09-chats-proactive-reply` 加一个 Chat 覆盖的套件。
- 交付前运行：受影响测试、完整 `pnpm test`、`pnpm run check`、`pnpm run lint`、`git diff --check`；因为改了 `ConfigSchema`，再跑 `pnpm run docs:build` 与 `pnpm run docs:verify`（`DOCS_BASE_PATH=/` 与 `/surowan/` 各一遍），构建后 `git status --porcelain` 应为空；改了面板前端与 Admin API，跑完整的 `pnpm run admin:test:e2e`。
- 真实 Decisions API 的连通性不在自动测试里，由 `doctor` 覆盖，这一项必做：只在闸门开启时执行，解析 `api_key` 并发一次最小请求，引用悬空或鉴权失败都要报出来，输出经 `SecretStore.redact`。

文档同步：`agent-doc/configuration.md`（字段、热更新与密钥）、`agent-doc/telegram-agent-flow.md`（Bucket 到期流程与新的跳过原因）、`agent-doc/data-layer.md`（新表与保留）、`agent-doc/admin-panel.md`（新端点、写端点白名单与页面）、`agent-doc/verification.md`（真实环境对照项），以及 AGENTS.md 的项目目标列表。用户文档在 `apps/docs/content/` 加一页闸门指南（参照 `docs/guides/proactive-replies.md`），改完运行 `pnpm run manual:prepare`。新端点会出现在 `surowan-utils` 与 MCP 里，核对 `skills/surowan-utils`、`skills/surowan-mcp` 与 `packages/cli/README.md` 是否要补说明。

## 不做

- 「继续积攒」这个结果，以及任何基于模型的延长收集窗口。
- 发送前对草稿再判一次。评估显示没有收益。
- 把图片传给决策模型。
- 用 chat completions 模型做闸门。
- Admin Panel 的决策列表页面。配置表单本期做。
- `configure` 向导里的闸门配置。
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
4. 决策行的列表页面留到下一期。配置表单已确认本期做；用户 2026-11-20 的原话只说到表单，列表页面按原计划仍然不做，如果也要做请指出。
5. 表单的实施默认：全局表单是独立页面 `/decision-gate`，放在 Harness tuning 所在的导航分组，而不是并进 Harness tuning 页或 Telegram 页；端点是 `GET` / `PUT /decision-gate` 与 `PUT /chats/:id/decision-gate`，都用逐字段补丁。
6. 程序化凭据（API key、已配对客户端）可以经表单端点开关闸门、改阈值与提问文本，和它们现在能改主动回复概率、`ask_only` 是同一级别的权限；密钥只能提交新的，不能选用已有条目。

## 工作方式

- 开发流程按 `tuu-create-feature` skill：从最新的 `origin/develop` 建 worktree，分支建议 `feature/decision-gate`，完成后验证、提交、写 devlog、push、开 PR。
- 提交信息用简短英文祈使句。PR 说明列出行为变化、数据库与配置影响、验证证据，以及真实环境里还没做的检查。
- 实现中发现本文与源码不符时以源码为准，并在 PR 说明里写出偏离的地方和原因。遇到[待用户确认](#待用户确认)之外的产品决策，停下来问用户，不要自行决定。
- 不读取 `key.json`，不在任何输出里打印密钥。
