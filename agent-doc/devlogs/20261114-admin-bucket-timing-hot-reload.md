# Surowan - 20261114 在 Admin Panel 编辑 Bucket 节拍并热应用

## 背景

#69（`20261112-adaptive-bucket-timing.md`）新增了 `telegram.bucket_max_seconds` 与 `telegram.bucket_bump_seconds`，但只做了配置与运行时：Admin Panel 没有任何编辑入口，三个节拍字段（连同 `bucket_window_seconds`）都不在热更新白名单，改完必须重启。

这次的需求：

- 在 Telegram 设置页下实现节拍编辑。
- 修改要热加载。
- 修改不能影响当前正在收集的 Bucket。

改动前，运行时有五处读节拍，全部读当时的配置：开桶（`appendToBucket`）、消息延长（`bumpDeadline`）、轮结束推迟（`deferCollectingBucket`，读运行中 Invocation 的配置快照）、Scheduler 轮中途推迟（`deferBucket`，读实时配置）与运行结束推迟（`executeInvocation`，读实时配置）。只把字段加进白名单的话，一次 reload 会立刻改变正在收集的 Bucket 的 bump、上限与推迟窗口，违背第三条。

## 主要变更

### 1. Bucket 行快照自己的节拍（迁移 057）

`src/store/migrations/057_bucket_timing.sql` 给 `buckets` 加三列：

```sql
ALTER TABLE buckets ADD COLUMN window_seconds INTEGER NOT NULL DEFAULT 0 CHECK (window_seconds >= 0);
ALTER TABLE buckets ADD COLUMN max_seconds INTEGER NOT NULL DEFAULT 0 CHECK (max_seconds >= window_seconds);
ALTER TABLE buckets ADD COLUMN bump_seconds INTEGER NOT NULL DEFAULT 0 CHECK (bump_seconds >= 0);
```

ingestion 开 collecting Bucket 时调用一次 `resolveBucketTiming`，把结果写进这三列（`src/ingress/telegram-ingestion/buckets.ts:76`）。之后五处中的另外四处只读 Bucket 行：

- `bumpDeadline`（`src/ingress/telegram-ingestion/buckets.ts:134`）用行内 `bump_seconds` / `max_seconds`。
- `deferCollectingBucket`（`src/orchestration/agent-runtime/support.ts:248`）去掉 `config` 与 `hostKind` 参数，读该 Conversation 唯一 collecting Bucket 的 `window_seconds`。这也修掉了反方向的问题：运行开始后才 reload、之后才开的 Bucket，原来会被运行快照里的旧窗口推迟。
- `deferBucket`（`src/orchestration/invocation-queue/due.ts:188`）用到期查询带出的 `b.window_seconds`；`BucketRow.host_kind` 只为查窗口存在，随之删除。
- `executeInvocation` 的运行结束推迟（`src/orchestration/scheduler/execution.ts:120`）改成逐个 collecting Bucket 计算 `max(结束时刻, 运行开始 + 该 Bucket 的 window)`，不再整 Chat 用一个实时窗口。

创建即到期的 Bucket（启动追赶、任务回执、Playground 放行）不写这三列，取默认 0/0/0，与 `resolveBucketTiming` 给 Playground 的值一致。迁移前的旧行也是 0/0/0：升级时仍在收集的 Bucket 保持已写入的 deadline，不再被延长或按窗口推迟。考虑过按 `deadline_at - first_received_at` 回填旧行窗口，但被推迟过的 Bucket 会得到错误的大窗口，而且只影响升级那一刻的极少数 Bucket，不值得。

### 2. 三个字段进入热更新白名单

`src/platform/config/diff-merge.ts:66` 把 `telegram.bucket_window_seconds`、`telegram.bucket_max_seconds`、`telegram.bucket_bump_seconds` 加进 `HOT_PATHS`。不需要发布钩子：新值只在下次开桶时被读取。

连带影响：窗口（restart）与 `agent.context.idle_grace_seconds`（hot）原本是唯一能自然触发 `candidate_invalid`（文件合法、与待重启字段组合后不合法）的一对字段。现在两者都是热字段，在 candidate 里一起校验、一起采纳。`candidate_invalid` 检查保留，但当前 schema 已没有能自然触发它的组合。原来借它制造「已写入但未应用」的四个测试（`reload-model-command`、`reload-self-ignore`、`providers-discovery`、`reload`）改为把 `vision` Provider 的 `api_key` 指向不存在的 jar 条目（`secret_unresolved`）；`reload.test.ts` 的对应用例改为断言窗口与 idle grace 一起被采纳、单独把窗口调到 idle grace 之上则是 `config_invalid`。

### 3. Admin API：`GET /api/telegram` 与 `PUT /api/telegram/bucket-timing`

`src/ingress/admin/telegram.ts` 的视图加 `bucket_timing: { saved, active }`：`saved` 来自磁盘文件的解析结果（段缺失时即默认值），`active` 来自当前发布的配置；缺省的 max 报 `null`（跟随窗口），缺省的 bump 报 `0`。handler 依赖新增 `configStore`。

新写端点按 Harness 的语义实现：

- `parseBucketTiming`（`:126`）只接受三字段的非空子集，取值用 `ConfigSchema` 里对应字段编译的校验器；后两项可传 `null` 删除，窗口在段内必填所以不能删。
- `bucketTimingEdits`（`:161`）跳过与文件现值相同、或可选字段写成其缺省含义的项；全部跳过时不写文件、revision 不变。
- 跨字段规则（`max >= window`、非零 idle grace 不小于 max）不在端点里重复，交给 `writeAndApply` 的整份文件校验，失败为 422 `config_invalid` 且文件不变。

token 写入与节拍写入共用一个 `writeAndRespond`。`packages/admin-surface/src/specs/settings.ts` 增加 `telegram bucket-timing` 行，CLI 与 MCP（`surowan_telegram_bucket_timing`）随之获得该操作；admin-panel.md 的写端点白名单同步。

### 4. Telegram 页「消息批次」面板

`apps/admin-next/src/components/telegram/bucket-timing.tsx:102` 的 `BucketTimingPanel` 放在 Token 面板之后，三个整数输入：最短等待、最长等待（留空 = 与最短等待相同）、每条消息延长。前端检查 0–300 整数与「最长不小于最短」；文件值与运行值不一致时在字段下显示「运行中：…」；服务端拒绝时保留编辑并以 `role="alert"` 显示原因。

页面有 10 秒一次的状态轮询，Token 保存也会改 revision。表单因此按「已保存的节拍」而不是 revision 做 key：只有节拍真的变了才重置草稿，mutation 放在表单外层，失败信息在重挂载后仍在。`useProviderWrite.refresh` 加入 `telegramQuery`，其它配置写入后 Telegram 页的 revision 不会过期。文案按 #76 的约定：Bucket 称「消息批次」，页面不出现配置键。

## 验证

先写测试并确认 13 项失败，再实现：

```bash
pnpm exec vitest run test/scheduler/bucket-timing-reload.test.ts test/schema/migrations-bucket-timing.test.ts \
  test/admin/telegram-bucket-timing.test.ts test/config/reload-pending.test.ts test/config/diff.test.ts
# 实现前：13 failed | 6 passed

pnpm exec vitest run test/scheduler/ test/schema/ test/admin/telegram-bucket-timing.test.ts test/admin/telegram.test.ts \
  test/config/ test/admin/providers-discovery.test.ts test/context/hot-inject-long-lived-rounds.test.ts \
  test/scene/retention.test.ts test/tasks/migration-upgrades.test.ts test/admin/mcp.test.ts test/cli
# 实现后：60 files / 256 passed | 6 skipped
```

新增覆盖：

- `test/scheduler/bucket-timing-reload.test.ts`：reload 后收集中的 Bucket 仍按自己的 bump/max 延长（调大不拖长、调小不截断）；Scheduler 轮中途推迟与运行结束推迟（fake timers 驱动真实 Scheduler 循环）都用 Bucket 自己的 window；新 Bucket 用新节拍并写入三列。
- `test/context/hot-inject-long-lived-rounds.test.ts` 新用例：真实 AgentRuntime 中，运行开始后才 reload、之后才开的 Bucket 在轮结束后按自己的 3 秒窗口注入，而不是运行快照里的 1 秒。
- `test/admin/telegram-bucket-timing.test.ts`：6 项，覆盖视图、热应用、`null` 删除、无变化不写、非法 body/范围/revision、整份文件校验与缺段建段。
- `test/schema/migrations-bucket-timing.test.ts`：从 056 升级，旧行 0/0/0 且 deadline 不变，CHECK 生效。

```bash
pnpm test
# 386 files：382 passed | 3 failed | 1 skipped；1883 passed | 6 failed | 8 skipped，1714s。
#  - foundation.test.ts（2 项）：迁移数量写死为 56，改为 57 后单独重跑通过。
#  - playground/only-serve.test.ts（3 项）：启动真实 serve 进程，本机冷启动超过 5s 默认超时；
#    --testTimeout=60000 单独重跑 4 passed。
#  - recurring-alarms/schedule.test.ts（1 项）：断言用 '/' 拼路径，Windows 上得到 '\\'，与本次改动无关。

git diff --check && pnpm run lint && pnpm run check
# 通过（lint:fix 只做了格式化）。

pnpm run admin:build && pnpm run admin:test:e2e 21-telegram 24-i18n 01-routes
# 首轮 37 passed | 1 failed：新用例误以为 bump 仍是 0，但同一文件的上一用例（共用 server）已存成 5，
# 「放弃修改」正确地恢复成 5。改为以当前保存值为基准后，21-telegram 8 passed。

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 51 个页面与 167 个 HTTP 资源；构建后 git status 只有本次改动。
pnpm test test/docs/examples.test.ts test/docs/search.test.ts test/manual-pack.test.ts
# 13 passed。
```

## 未执行

- 真实 Telegram 群聊中「收集期间修改节拍」的人工验收。
- 产品知识索引未针对手册新增段落重新烘焙。

## 提交

```txt
673e094f69d6ac5c1f1e6381cfb47b7e9a4d0013 Edit bucket timing in the admin panel and apply it hot
```
