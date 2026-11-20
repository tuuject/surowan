# Surowan - 20261121 Decisions 入场闸门

## 背景

用户希望 Bot 在群聊里少插话，并且不想靠改人格 Prompt 来做。2026-11-10 至 11-12 的离线评估（`agent-doc/investigations/2026-11-11-decisions-api-gate-eval.md`）表明，用 OpenRouter Decisions API 上的 `typesafe/jev-1.14` 问一句是非题，可以预测「范本模型会不会回这批消息」，AUC 0.933，单次约 0.7 秒。据此写成了实施计划 `agent-doc/design/20261112 Decisions 入场闸门实施计划.md`。

计划写成之后 keychain、多 Host 边界和 `/ask` 先后合入。2026-11-20 对照 `develop` 复核了一遍并修订（提交 `22d54a65`），用户当天确认了修订，并要求把 Admin Panel 的配置表单纳入本期。

改动前，一个到期的 Bucket 只经过暂停、配置、Agent 三元组、睡眠和主动回复抽样这几道闸门，之后一定会交给主模型。本次在它们之后加了一道由决策模型把关的闸门。

本次由 Pi（`magpie/opencode-go/deepseek-v4.1-flash`，thinking `max`）在 T3 子线程里实现，分四个子任务依次做，共四轮首次实现加两轮修正。主会话负责拆分、任务说明、review、复验与交付。

## 主要变更

### 1. 配置、Host 投影、Decisions 客户端与审计表

- `telegram.decision_gate`（十个字段）与 `telegram.chats[].decision_gate`（前六个行为字段），逐字段继承，默认关闭、默认 `shadow`。解析在 `src/platform/decision-gate.ts`：

  ```ts
  enabled: local?.enabled ?? global?.enabled ?? DECISION_GATE_DEFAULTS.enabled,
  mode: local?.mode ?? global?.mode ?? DECISION_GATE_DEFAULTS.mode,
  threshold: local?.threshold ?? global?.threshold ?? DECISION_GATE_DEFAULTS.threshold,
  // ...
  model: global?.model ?? DECISION_GATE_DEFAULTS.model,
  base_url: global?.base_url ?? DECISION_GATE_DEFAULTS.base_url,
  api_key: global?.api_key,
  ```

- 跨字段校验放在新文件 `src/platform/config/semantics-decision-gate.ts`（`semantics.ts` 已接近 20,000 字节上限）：私聊不能配置；全局或任意一个群开启时必须有全局 `api_key`（只查字段在不在）；`base_url` 必须是 HTTPS，不带凭据、`?` 与 `#`。
- `HostIntakeSettings` 增加 `decision_gate`：Telegram 返回全局段，Playground 返回 `undefined`，core 里没有宿主字面量分支。
- 两级的全部字段都是热更新（`src/platform/config/diff-merge.ts` 的 `HOT_DECISION_GATE_PATHS`）。
- `src/platform/decisions.ts` 是 Decisions API 的薄客户端：`POST {base_url}/decisions`，只带一个 `noul` 问题，TypeBox 校验响应，禁止重定向，响应体上限 64 KiB。预期内的失败不抛错，返回稳定错误码 `timeout`、`aborted`、`network_error`、`http_error`、`invalid_response`、`refusal`。
- 迁移 `066_bucket_decisions.sql` 与 Drizzle 表 `bucketDecisions`，外键到 `buckets` 与 `conversations` 并级联删除，所以现有的保留期清理会连带删掉决策行。

### 2. 闸门本体与调度接入

`processDueBuckets` 是一个同步 SQLite 事务，决策是异步 HTTP，所以分两段做（`src/orchestration/decision-gate/`）：

- **第一段，事务内**（`begin`）：读批次与历史、渲染请求内容、记下指纹、写一行 `pending` 的 `bucket_decisions`。`enforce` 还把 `deadline_at` 推到 `now + timeout_ms + 500ms` 并让 Bucket 留在 `collecting`；`shadow` 不动 Bucket，本轮照常入队或 attach。所有可能抛错的步骤都排在内存登记之前，抛错时在同一事务里把决策行收尾成 `internal_error`，批次走普通路径。
- **事务提交后**发请求。密钥每次决策都重新 `SecretStore.resolve`，解析与 HTTP 共用同一个 `timeout_ms`。
- **第二段，新事务内**（`src/orchestration/decision-gate/settle.ts`）：Bucket 已不在 `collecting` 则标 `stale`；闸门此时已关或已切到 `shadow` 则不抛弃；「送入」打上放行标记并把 deadline 设为现在，下一轮跳过闸门走完整的现有路径；「抛弃」且批次没变则 `markBucketSkipped(..., 'decision_gate_dropped')`，批次变了就重新决策，最多 2 次，之后送入。

接入点在 `src/orchestration/invocation-queue/due.ts` 的两条路径，位置在现有闸门全部通过之后：

```ts
// `enforce` keeps the batch collecting until the verdict arrives; `shadow`
// carries on here and only records what the model would have said.
if (decide(deps, bucket, hostKind, chat, chatConfig, now, decisions) === 'hold') {
  return undefined;
}
```

其它要点：

- 一切失败都送入：超时、网络错误、非 2xx、响应不合法、`refusal`、密钥解析不出（`secret_unresolved`）、在途请求达到 4 个（`concurrency_limit`）、内部异常（`internal_error`）。不重试。
- 批内有 `/ask`、@、回复 Bot 或关键词时不发请求。判定从 `ProactiveReplyGate` 抽成 `src/orchestration/direct-trigger.ts`，两个闸门共用一份。
- 某个批次要经过 `enforce` 闸门时，`proactiveAllows` 视为放行且不动保底计数。
- 请求里的 Bot 名字读自连接身份对象（`TelegramConnectionIdentity` 的 getter，内存里的 `getMe` 结果，不调用 Telegram API），每次决策时读，token 热换后自动跟上。
- 停机时 `BucketScheduler.stop()` 先中止在途请求且不等待；残留的 `pending` 行在下次启动的 `recoverQueue` 里标成 `error` / `interrupted`。
- 每次决策打一行结构化日志 `agent_decision_gate`，不含消息正文。
- `doctor` 在闸门开启时解析密钥并发一次最小请求（`src/doctor-decisions.ts`），失败即 doctor 失败。
- `scripts/audit/` 在 Invocation 与 Conversation 视图里显示决策行。

### 3. Admin API

- `GET /decision-gate`：`{ revision, saved, active, key_configured, key_source }`，`key_source` 只给面板会话。
- `PUT /decision-gate`：全局段的逐字段补丁，省略保留、`null` 删除；`api_key` 走共享的 `SecretInput`。
- `PUT /chats/:id/decision-gate`：单个 Chat 的六个行为字段，同样的补丁语义。
- `GET /decision-gate/decisions`：决策行只读列表，按 Chat 过滤、分页。
- `GET /chats` 与 `GET /config/view` 带上闸门的非密钥字段。
- 四个端点登记到 `packages/admin-surface/src/specs/`，成为 CLI 命令 `decision-gate show` / `update` / `decisions`、`chat decision-gate <id>` 与对应的反向 MCP 工具。

密钥规则与联网搜索端点一致：程序化凭据提交 `{ entry }` 得 403；程序化凭据保留原密钥而改动生效的 `base_url` 得 400；条目只被这一处使用时原地轮换，被别处共用时新建条目并改指向；跨字段校验复用配置加载的 `validateDecisionGate`，不合法的写入在落盘前被拒绝。

### 4. 面板前端、E2E 与用户指南

- 新页面 `/decision-gate`（导航在 Agent setup 分组、Harness tuning 之后），分「行为」与「连接」两块，只发送改动过的字段，密钥用现成的 `secret-field.tsx`。
- Chats 页新增入场闸门对话框，每个字段可以勾选「为这个 Chat 单独设置」，未勾选时显示将要继承的全局值；行里新增一列概述。为了不超过文件大小上限，`chat-table.tsx` 的行菜单拆到 `chat-row-menu.tsx`。
- 四个 locale 都补了键值。界面上没有机制说明文字。
- E2E 新增 `38-decision-gate` 与 `39-chats-decision-gate`，各在结尾存一张整页截图作为验收产物。
- 用户指南 `apps/docs/content/docs/guides/entry-gate.md`。

## 计划之外的决定

实施计划「待用户确认」的六条都按计划写明的默认值实现。下面是计划没有写、实现时定下的：

- `shadow` 模式只对通过了主动回复抽样的批次发请求，也就是只判断本来就要交给主模型的批次，影子数据可以直接和 Bot 的实际发言对照。
- 批次指纹是「最大 `sequence_no` : 最大当前 Revision id」，计划只写了前者。这样决策期间的编辑也会让「抛弃」作废。
- 重新决策次数用尽时，那一行记 `state = success`、`outcome = enter`、`applied = 1`，`probability` 保留原值。
- `history` 遵守 `/cut_topic` 的 Context cutoff，与 `snapshotInvocation` 一致。
- 决策行只读端点的路径定为 `GET /decision-gate/decisions`，参数与分页照现有审计列表。
- 没有改 `src/platform/prompts/2-product-knowledge.md`。子 agent 按 `agent-doc/product-knowledge.md` 加过一条索引，主会话撤回了：改动系统 Prompt 分区会改变稳定 Prompt 哈希，让所有 Conversation Context 重建一次。代价是产品知识索引里暂时没有指向新指南页的条目。
- Decisions API 的线上格式计划里没写，实现前查了 OpenRouter 文档：`answers.gate` 是 `{ "type": "noul", "noul": <0..1> }` 或 `{ "type": "refusal" }`。

## Review 与处理

每个子任务首轮实现后跑一次 ocr（open-code-review），主会话逐条回到代码核实。修正轮不再跑 ocr。

| 子任务 | ocr 意见 | 成立并已修 | 不改或误报 |
| --- | --- | --- | --- |
| 1 配置与客户端 | 5 | 4（主会话直接改） | 1 |
| 2 调度闸门 | 8 | 7，加主会话自己读出的 1 条（打回一轮） | 1 |
| 3 Admin API | 3 | 1（主会话直接改） | 2 |
| 4 前端 | 10 | 10，加主会话自己提的 1 条（打回一轮） | 0 |

修掉的问题里比较重要的：

- 某个 Chat 单独开启闸门而全局没有 `api_key` 时校验放过，运行时闸门会静默失效。
- `begin()` 先登记「决策中」再做会抛错的操作：一旦抛错登记收不回，Bucket 永远被跳过，异常还会冒到没有 try/catch 的调度循环，让所有 Chat 停止调度。
- 判断「被回复的是不是 Bot」的 join 只按 `conversation_id` 加 `message_no` 匹配，用不上 `(chat_id, message_no)` 唯一索引，会在同步事务里扫整个 Conversation。
- 前端把新密钥明文放在 mutation 的 variables 里，保存后仍留在 TanStack Query 的 mutation 缓存中。
- 版本冲突时表单被自动重建，用户的改动在点 Reload 之前就丢了。

判为不改的：错误状态码之后响应体卡住时报 `http_error` 而不是 `timeout`（状态码已拿到，耗时仍被超时封顶）；`doctor` 探测里密钥解析不计入超时（诊断命令，现有密钥解析同样没有外层超时）；设置响应不过脱敏（与联网搜索端点一致，脱敏后表单会把 `[REDACTED]` 存回去）。误报 1 条：声称密钥路径常量与 keychain 用量路径对不上，实际一致，原地轮换的测试通过。

## 验证

以下由主会话在该 worktree 里亲自运行，对象是 rebase 到 `origin/develop`（`f8ab0004`）之后的最终代码：

```bash
pnpm install --frozen-lockfile
# 通过

pnpm --filter @surowan/admin-surface run build && pnpm run admin:build
# 通过

pnpm run lint
# 通过

pnpm run check
# 通过

pnpm test
# Test Files  480 passed (480)
#       Tests  2474 passed (2474)

pnpm run admin:test:e2e
# 378 passed (1.8m)

pnpm run admin:test:e2e 37-mcp-servers 38-decision-gate 39-chats-decision-gate --repeat-each=3
# 75 passed (32.4s)

pnpm run manual:prepare
# Packed 56 manual documents

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 55 HTML/Markdown pages, search, examples, schema, provenance and 179 HTTP resources (base /).

DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 55 HTML/Markdown pages, search, examples, schema, provenance and 179 HTTP resources (base /surowan/).

git diff --check origin/develop..HEAD
# 通过；之后 git status --porcelain 为空
```

文档构建与 `docs:verify` 是在撤回产品知识索引那一行之前跑的；那次撤回只把 `src/platform/prompts/2-product-knowledge.md` 恢复成 `develop` 的内容，文档站不读这个文件，没有重跑。提交 hook 的文件大小检查（`node scripts/file-token-limit.ts`）在每个子任务提交前都通过；rebase 之后按字节数扫了一遍分支改动的文件，超过 20,000 字节的只有豁免的 `AGENTS.md`、`packages/cli/README.md` 与 `routeTree.gen.ts`。

各子任务提交前还各跑过一次快速层（lint、类型检查、受影响测试，新测试连跑 3 到 5 轮），均通过。rebase 之后第一次完整 E2E 有 2 条失败，原因是没有重新构建前端，旧的 `dist` 里没有 `develop` 新带进来的 MCP Skill 徽标；重新 `pnpm run admin:build` 后 378 条全过。

base 提交 `22d54a65` 上的全量基线：458 个文件、2303 条全部通过，没有已知失败。

只由子 agent 自报、主会话没有单独重跑：子任务 2 与 4 的修正轮里，新增回归测试「回退修复后失败、恢复后通过」。子任务 1 与 3 中主会话直接改的 4 处，这一点由主会话自己确认过。

未执行：

- 对真实 Decisions API 的请求：没有跑过连到 OpenRouter 的 `doctor`，线上格式只依据文档与注入的 fetch 替身。
- 真实 Telegram 群里的验收：`shadow` 一周的影子数据对照，以及 `enforce` 的实际拦截效果。
- Docker 镜像内的运行验收。

## 提交

```txt
b48efc3e Add decision gate configuration, client and audit table
b7211c33 Gate due buckets on a decision model
116ce9c3 Add the decision gate Admin API
8e334225 Add the entry gate page to the Admin Panel
```
