# Surowan - 20261117 按会话读消息的索引、诊断日志瘦身与 Session 写入节流

## 背景

一次全仓审计在数据层和运行时找到四个问题：

- `messages` 只有 `(chat_id, telegram_message_id)` 唯一索引和一个按 `local_sequence_no` 的部分索引，而多条热路径只按 `conversation_id` 过滤：Invocation 启动时取历史（`src/store/invocation-snapshot.ts`）、开新 Bucket 时收编待处理的 Bot 消息（`src/ingress/telegram-ingestion/buckets.ts`）、成员资料核查与场景渲染。消息不随在线保留窗口清理，表只增不减。用真实迁移建库、灌 50 万条合成消息实测，取历史一次约 217 ms，加上 `(conversation_id, telegram_date, telegram_message_id)` 后约 0.1 ms。驱动是同步的 better-sqlite3，这段时间整个进程被卡住。收编查询里按 `message_id` 反查 `bucket_messages` 同样没有可用索引。
- `test/recurring-alarms/schedule.test.ts` 的分层测试用 `relative()` 拼路径后与正斜杠字面量比较，在 Windows 上必然失败；CI 是 Ubuntu，所以一直没暴露。
- 每个 Invocation 开始和结束时的诊断日志（`logInvocationDiagnostic`）带着一段只有 `--expose-gc` 才会执行的强制 GC（全仓没有任何地方传这个参数），还有一条 `SELECT COUNT(*) FROM invocations WHERE started_at >= ?`，`started_at` 没有索引，是全表扫描，结果字段也没有任何读者。
- `AdminAuth.authenticate` 每个请求都更新 `admin_sessions.last_seen_at`。数据库开着 `synchronous = FULL`，面板列表页又在轮询，于是开着面板就是一串连续的 fsync 写入。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-a-runtime-data-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. 迁移 062：两条索引

`src/store/migrations/062_conversation_message_indexes.sql`，只有两条 `CREATE INDEX`，不重建表：

```sql
CREATE INDEX messages_conversation_history_idx
  ON messages(conversation_id, telegram_date, telegram_message_id);

CREATE INDEX bucket_messages_message_idx ON bucket_messages(message_id);
```

第一条同时服务 `conversation_id` 等值过滤与 `ORDER BY telegram_date DESC, telegram_message_id DESC`，历史查询不再扫全表、也不再用临时 B-tree 重排。Drizzle schema（`src/store/schema/messaging.ts`、`src/store/schema/invocation.ts`）同步镜像。`agent-doc/data-layer.md` 加了一段说明这条迁移的理由。

查询计划前后对比（子 agent 实测）：

```txt
history（invocation-snapshot.ts）
  之前: SCAN m + USE TEMP B-TREE FOR ORDER BY
  之后: SEARCH m USING INDEX messages_conversation_history_idx (conversation_id=?)

pending bot messages（buckets.ts）
  之前: SCAN m / SCAN bm USING INDEX sqlite_autoindex_bucket_messages_2 / USE TEMP B-TREE FOR ORDER BY
  之后: SEARCH m USING INDEX messages_conversation_history_idx (conversation_id=?)
        SEARCH bm USING COVERING INDEX bucket_messages_message_idx (message_id=?)
```

`test/schema/index-plans.test.ts` 新增用例，在全新库与升级库（删掉 062 的两条索引和迁移记录后重新打开）两种状态下对这三条查询跑 `EXPLAIN QUERY PLAN`，断言走新索引、没有 `SCAN m` / `SCAN bm`、没有临时 B-tree。四个测试文件里写死的迁移版本号与数量从 61 改到 62。

### 2. Windows 路径断言

```ts
importers.push(relative(root, path).split(sep).join('/'));
```

### 3. 诊断日志

`src/orchestration/scheduler/execution.ts` 删掉强制 GC 分支、`forced_gc` 与全部 `gc_*` 字段、`lastForcedGcAt` 记账，以及 `invocations_started_last_minute` 字段和它背后的全表计数。`InvocationExecutionState` 类型因此没有字段了，连同 `BucketScheduler` 里的实例和依赖注入一起删除。其余字段与两个事件名不变。

### 4. `last_seen_at` 至多每分钟写一次

`src/ingress/admin/auth.ts`：

```ts
const seenBefore = new Date(now.getTime() - LAST_SEEN_REFRESH_MS).toISOString();
this.#orm
  .update(adminSessions)
  .set({ lastSeenAt: now.toISOString() })
  .where(and(eq(adminSessions.id, row.id), lte(adminSessions.lastSeenAt, seenBefore)))
  .run();
```

过期判断与过期删除在这之前，逻辑没有动。`test/admin/auth.test.ts` 用注入的时钟断言：+5 秒与 +59 秒不写、+61 秒写入、其后 +30 秒不再写、过期后仍被拒绝并删除会话行。

## 验证

review：一轮 ocr，0 条意见。主会话复验时发现 `test/foundation/foundation.test.ts:178` 的 `toHaveLength(61)` 没有跟着新迁移更新（子 agent 没跑这个目录），由主会话改为 62。

主会话亲自运行（在子 agent 的 checkout 内）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test test/schema/index-plans.test.ts test/admin/auth.test.ts test/recurring-alarms/schedule.test.ts   # 连跑 3 次
# 每次 3 files / 48 tests passed

pnpm test
# Test Files  407 passed | 1 skipped (408)
# Tests  2015 passed | 9 skipped (2024)
# 基线（8d5e82f8）在同一台 Windows 机器上是 1 failed（即上面的路径断言）

pnpm run admin:build && pnpm run admin:test:e2e
# 329 passed (3.0m)

git add -A && node scripts/file-token-limit.ts
# 无拒绝输出
```

子 agent 自报、主会话未重跑：新的查询计划断言在迁移文件不存在时失败（`SCAN m` 断言不成立），加上迁移后通过；上面的查询计划前后对比。

未执行：

- 没有在真实数据量的生产库上验证迁移耗时。`CREATE INDEX` 在迁移事务里一次建完，消息很多的库升级后首次启动会多花一段时间，具体多久没有测过。
- `doctor`、真实 Telegram 验收未跑。

## 提交

```txt
3d925df7 Index per-conversation message reads and trim per-request overhead
```
