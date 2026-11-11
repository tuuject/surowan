# Surowan - 20261112 自适应 Bucket 节拍：bump 延长与最长等待

## 背景

此前 Bucket 只有固定窗口 `telegram.bucket_window_seconds`：第一条可触发消息到达后 deadline 定为 `first_received_at + window`，之后的消息只加入、不改 deadline。群里有人连续发言时，一批常在话说到一半时被交给模型。

需求是三个参数：最短等待、最长等待、每条新消息把 deadline 推迟到「到达 + bump」，且默认值必须与现有固定 15 秒完全一致、旧配置不改也不变。约束：

- deadline 存在 `buckets.deadline_at`，Scheduler 只有一个按最早 deadline 重排的 `setTimeout`，serve 每次入库后 `wake()`。不新增定时器或轮询。
- 运行时已有三处只往后推的 deadline 写入（轮结束 `deferCollectingBucket`、Scheduler 轮中途 `deferBucket`、运行结束 `executeInvocation`），新逻辑不能把它们推出的更晚 deadline 拉回来。
- AGENTS.md 要求清理式切换、不留兼容别名，同时用户要求不破坏旧配置。

## 主要变更

### 1. 配置：沿用 window 作最短时间，新增两个可选字段

不引入 `min_time` 新名字再给 `bucket_window_seconds` 做别名，而是让它本身就是最短等待，新增 `bucket_max_seconds` 与 `bucket_bump_seconds`（`src/platform/config/schema.ts:149`），都是 0–300 的整数秒。`bucket_window_seconds` 在段内仍必填，所以已有配置一行都不用改，也没有需要废弃的旧字段。

`resolveBucketTiming`（`src/platform/config/resolve.ts:153`）替换原来的 `resolveBucketWindowSeconds`，一次给出 `{ windowSeconds, maxSeconds, bumpSeconds }`：

```ts
case 'telegram': {
  const windowSeconds = config.telegram.bucket_window_seconds;
  return {
    windowSeconds,
    maxSeconds: config.telegram.bucket_max_seconds ?? windowSeconds,
    bumpSeconds: config.telegram.bucket_bump_seconds ?? 0,
  };
}
case 'playground':
  return { windowSeconds: 0, maxSeconds: 0, bumpSeconds: 0 };
```

`maxSeconds` 缺省跟随 window 而不是常量 15：写了 `bucket_window_seconds: 30` 的旧配置得到 30/30/0，仍是固定 30 秒，也不会因为 `max < window` 被校验拒绝。缺省配置即 15/15/0。

`InvocationPolicy.bucketWindowSeconds` 没有任何读者，随旧 resolver 一起删除。

### 2. 入库时延长 deadline

`appendToBucket` 读 collecting Bucket 时多取 `firstReceivedAt`，对 `eligibleHuman` 消息调用 `bumpDeadline`（`src/ingress/telegram-ingestion/buckets.ts:121`）：

```ts
const bumped = new Date(
  Math.min(
    Date.parse(firstReceivedAt) + timing.maxSeconds * 1_000,
    receivedAt.getTime() + timing.bumpSeconds * 1_000,
  ),
).toISOString();
deps.store.orm.run(
  sql`UPDATE buckets SET deadline_at = ${bumped}, updated_at = ${receivedAt.toISOString()}
     WHERE id = ${bucketId} AND state = 'collecting' AND deadline_at < ${bumped}`,
);
```

即 `deadline = max(deadline, min(first + max, arrival + bump))`。需求给的是 `min(first + max, max(deadline, arrival + bump))`，两者在 `deadline <= first + max` 时相同；差别只在轮结束等运行时推迟已把 deadline 推过 `first + max` 时：需求原式会把它截回 `first + max`，违反「新消息只能延后」并让轮中途收集的批次在轮结束瞬间交出（这正是 `deferCollectingBucket` 要防的「秒回」）。所以 max 只截断消息带来的延长。

几个取舍：

- 开 Bucket 的第一条消息不延长，初始 deadline 仍是 `first + window`，与需求一致。
- 只有能开 Bucket 的消息（`eligibleHuman`）延长。其他 Bot、服务消息、未开 `sticker_trigger_enabled` 时的单独 Sticker 照旧加入但不推迟，与「两个 Bot 不能互相唤醒」同理。这是对需求「每条新消息」的有意收窄。
- `bumpSeconds === 0` 时直接返回，不写库，默认行为零差异。
- 竞争：入库与结算（collecting → queued）都是 better-sqlite3 同步事务、同一写者串行。消息要么在结算前加入并延长，要么在结算后开新 Bucket。deadline 已过但 Scheduler 还没处理时到达的消息照常加入并按公式延长，与原先「加入仍在 collecting 的 Bucket」一致。
- 不动 Scheduler：bump 只把 deadline 往后推，`wake()` 后循环重算延迟；即使没 wake，旧定时器到点只会发现无到期 Bucket 并重排。

### 3. 运行时推迟仍只用 window

`deferCollectingBucket`、`deferBucket` 与运行结束的推迟改读 `resolveBucketTiming(...).windowSeconds`，语义不变：轮结束后这批再收集一个 window。上限按 `first_received_at` 计，所以一轮比 max 还长时，这批在轮结束后满一个 window 结算、不再被延长；这些消息已经等得比 max 久了。

### 4. 校验

- `bucket_max_seconds >= bucket_window_seconds`（`src/platform/config/semantics.ts:98`）。
- `idle_grace_seconds` 由「不小于 window」改为「不小于 max」（`src/platform/config/semantics.ts:366`）。原不变量是「轮结束时仍在收集的 Bucket 会在 grace 内到期」；有了 bump，它最晚在 `first + max` 到期，因此 grace 要覆盖 max。旧配置 max 等于 window，判定不变。报错文案随之变化，`test/foundation/configuration-contract.test.ts` 的断言同步更新。

两个新字段不在热更新白名单里，与 `bucket_window_seconds` 一样需要重启；`configurationView` 增加两个字段的原样投影。

### 5. 文档

`agent-doc/telegram-agent-flow.md` 新增「自适应延长」小节，`agent-doc/configuration.md` 补字段说明与 `idle_grace_seconds` 校验，`agent-doc/verification.md` 登记新测试；用户手册 `configure/telegram.md` 新增「等多久再处理一批消息」，`apps/docs/examples/config.example.jsonc` 写出两项缺省值；Admin Harness 页 `idle_grace_seconds` 的中英文说明改为「不能小于 Bucket 最长等待（bucket_max_seconds）」。

### 6. 测试

新增 `test/scheduler/bucket-timing.test.ts`，直接用 `ingest(update, at)` 与 `processDue(at)` 控制时钟，一律断言 `buckets.deadline_at` 与 `bucket_messages` 落库状态：缺省固定 15 秒、无后续消息在 window 结算、bump 未超过 window 时不变、bump 超过 window 时延长且旧 deadline 不结算、连续延长且不拉回运行时推出的更晚 deadline、截断到 max、每 2 秒一条的消息流在 max 结算且下一批从自己的首条消息重新计、Sticker 只加入不延长、三种结算竞争（迟到的 Scheduler、deadline 当刻到达、结算后同一毫秒到达）下每条消息只在一个 Bucket、旧配置兼容与配置校验。另有一个用例在 fake timers（`setTimeout`/`clearTimeout`/`Date`）下跑真实 Scheduler 循环：deadline 被延长后旧时刻不启动 handler，新时刻启动且仅一次，之后一分钟不再触发。`test/config/reload-pending.test.ts` 补「两个新字段改动只进入 restartRequired、运行配置不变」。

## 验证

```bash
pnpm exec vitest run test/scheduler/bucket-timing.test.ts
# 15 passed。

# 变异检查（临时改 buckets.ts 后跑上面的文件，随后还原）：
#   去掉 max 上限         → 2 failed
#   完全不 bump           → 6 failed
#   companion 消息也 bump → 1 failed
#   去掉 deadline_at < bumped（允许拉回）→ 2 failed

pnpm test
# 首轮：370 files / 1792 tests，1 failed：configuration-contract 断言旧 idle grace 文案（预期中的契约变化），更新断言后
pnpm exec vitest run test/foundation/configuration-contract.test.ts test/scheduler test/config/reload-pending.test.ts test/config/reload.test.ts test/config/telegram-optional.test.ts
# 9 files / 48 tests passed。
pnpm test   # 在提交 e2e0b3d1 上重跑
# 370 files / 1792 tests passed，445.21s。

git diff --check && pnpm run lint && pnpm run check
# 通过（admin e2e 结束后紧接着跑的一次 lint 返回过 1，随后连续重跑均为 0，未复现）。

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 50 个页面与 164 个 HTTP 资源；构建后 git status 只有本次改动。
pnpm exec vitest run test/docs/examples.test.ts test/docs/search.test.ts test/manual-pack.test.ts
# 13 passed。

pnpm run admin:build && pnpm run admin:test:e2e 19-harness 24-i18n 01-routes
# 34 passed。
```

## 未执行

- 真实 Telegram 群聊中的节拍验收（连续发言延长、持续刷屏在 max 结算）。
- 产品知识索引 `src/platform/prompts/2-product-knowledge.md` 未加入新的手册章节。

## 提交

```txt
e2e0b3d10824f19aae77d9ccdf930754a3b46e14 Add adaptive bucket timing with bump and max window
```
