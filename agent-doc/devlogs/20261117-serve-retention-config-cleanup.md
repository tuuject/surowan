# Surowan - 20261117 serve 内置保留清理、删除兼容配置字段与一次性脚本

## 背景

一次全仓审计里有三项需要用户拍板的问题，用户逐项做了决定：

- `retention.online_days` 是必填配置，但执行它的 `purgeExpiredData` 只有 `backup` 命令调用，长期运行的 `serve` 从不清理。Compose 模板和备份文档都没有定时方案，所以不跑 `backup` 的部署会让 `model_calls`、`tool_calls`、`invocations` 等一直增长。每次带迁移的升级留下的 `pre-migration-*.sqlite` 也只在 `backup` 时轮换。**决定：`serve` 自己每天清理。**
- 三个配置字段只为兼容而留：`agent.memory_ttl_warning_days`（运行时不读）、`agent.send_empty_text_fallback_enabled`（`send_empty_text_strategy: "random_text"` 的旧别名，`harness.ts` 里有一段专门处理它）、`vision.background_sticker_concurrency`（只能填 `1`，运行时不读）。这与仓库的「清理式切换，不保留兼容别名」规则相反。**决定：三个都删，接受旧配置文件因未知字段而启动失败。** MCP 的 `follow_redirects` 不动。
- 三个一次性迁移脚本还留在仓库里。**决定：全部删除。**

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-e2-retention-config-scripts-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. `serve` 启动时与每 24 小时执行保留清理

新增 `src/adapters/local-monolith/runtime/retention.ts` 的 `RetentionCleanup`：`start()` 立即跑一次，再挂一个 `unref` 的 24 小时定时器；每次都从当前发布的配置读取 `retention.online_days`；抛错只记 `retention_cleanup_failed` 日志，不影响下一次；成功记 `retention_cleanup`，两者都带 `duration_ms`。

`runtime/serve.ts` 在 `startServeServices` 里、Scheduler 构造之前启动它（紧接着已有的 `memoPad.purgeExpired()` 与 blob sweep），所以升级后第一次清理即使要删掉很大的积压，也不会和正在运行的 Invocation 抢。`runtime/index.ts` 的关停序列在关闭 store 之前调用 `state.retention?.stop()`，接管走同一条路径。

`purgeExpiredData` 删什么没有改动，`backup` 仍然在备份前调用它。

因为运行中的服务现在会读取这个值，`retention.online_days` 在 `src/platform/config/diff-merge.ts` 里从 `outside_serve` 改为热字段：面板把 `outside_serve` 显示为「不影响运行中的服务」，对它已经不成立。`paths.backups` 与 `retention.backup_copies` 仍是 `outside_serve`。

### 2. 迁移前副本只在同类之间轮换

`SqliteStore.migrate` 写出 `pre-migration-*.sqlite` 之后，只保留最新的 `retention.backup_copies` 份迁移前副本：

```ts
await rotateBackups(config.paths.backups, config.retention.backup_copies, /^pre-migration-/);
```

`rotateBackups` 新增可选的文件名过滤；`backup` 命令自己的轮换不带过滤，行为不变。迁移路径不会删除任何 `surowan-*.sqlite` 完整备份或 `.images` 目录。

图片快照目录的命名收进一个函数 `imageSnapshotPath()`（把 `.sqlite` 后缀换成 `.images`），生成快照与轮换共用它；轮换只删除以 `.images` 结尾且确实对应被轮换备份的目录。

### 3. 删除三个兼容字段

从 Schema（`schema-sections.ts`）、类型与默认值（`config/index.ts`、`resolve.ts`）、热字段表（`diff-merge.ts`）、`config-inspection.ts`、`harness.ts`，以及测试 fixture、`scripts/seed-dev-data.ts`、示例配置与文档里全部移除。配置里还留着其中任何一个时，报错会点名字段：

```txt
Invalid config: /agent/memory_ttl_warning_days: schema is false; /agent: must not have additional properties: memory_ttl_warning_days; /agent: must be null; /agent: must match a schema in anyOf
```

`harness.ts` 里别名相关的分支删除后，`send_empty_text_strategy` 仍保留一小段特判，语义与原来一致：`null` 是显式重置；与当前生效值相同不产生编辑；改回 `reject` 是删键而不是写入显式值；其他值照写。

`apps/docs/content/docs/operations/upgrade.md` 新增升级说明：升级前从 `config.jsonc` 删掉这三个键，`send_empty_text_fallback_enabled: true` 要换成 `send_empty_text_strategy: "random_text"`。

### 4. 删除三个一次性脚本

`scripts/migrate-key-jar.ts`、`scripts/migrate-admins.ts`、`scripts/scrub-model-request-images.ts`。它们用到的运行时导出都还有别的调用方，没有连带删除。文档里让读者去运行 `migrate-admins.ts` 的句子删除，事实部分保留；已发布迁移 `026` 的 SQL 注释按规则不动。

## review 过程

一轮 ocr（3 条）加主会话人工审阅（1 条），四条全部成立，打回同一子线程修正：

| 问题 | 来源 | 处理 |
| --- | --- | --- |
| 首轮把图片快照目录的轮换匹配改成了 `.sqlite.images`，而真实目录名是 `<name>.images`，改完后快照目录永远不会被轮换删除；配套测试用的是产品不会生成的目录名 | ocr 与人工 | 恢复正确匹配并抽出 `imageSnapshotPath()`；测试改为走真实 `backupDatabase` |
| 迁移前副本套用 `backup` 的轮换规则时，`backup_copies: 1` 的升级会删掉用户最后一份完整备份 | ocr | 这是主会话任务说明的错误，不是实现的错误。改为只在迁移前副本之间轮换（第 2 节） |
| 配置里显式写着 `"send_empty_text_strategy": "reject"` 时，保存未改动的 Harness 页会删掉这个键 | ocr 与人工 | 恢复「相同值不产生编辑」 |
| `retention.online_days` 仍归类为「不影响运行中的服务」 | 人工 | 改为热字段，文档同步 |

## 验证

主会话亲自运行（在子 agent 的 checkout 内，Windows）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test test/runtime/retention.test.ts test/operations.test.ts test/admin/harness.test.ts \
  test/config/reload.test.ts test/config/diff.test.ts test/config/boundary.test.ts   # 连跑 3 次
# 每次 6 files / 54 tests passed

pnpm test
# Test Files  1 failed | 407 passed | 1 skipped (409)
# Tests  1 failed | 2020 passed | 9 skipped (2030)
# 唯一的失败是 test/recurring-alarms/schedule.test.ts 的 Windows 路径断言：
# 基线（8d5e82f8）上同样失败，与本次改动无关，由另一个 PR 修复

DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两次都是 Verified 53 HTML/Markdown pages ... 173 HTTP resources

pnpm run admin:build && pnpm run admin:test:e2e
# 329 passed (2.7m)

git diff --cached --check && node scripts/file-token-limit.ts
# 无输出
```

子 agent 自报、主会话未重跑：图片快照轮换、迁移前副本轮换、Harness 无编辑三条回归测试在修复前确认失败。

未执行：

- 没有在带大量历史审计数据的真实数据库上测过第一次启动清理要多久。它在 Scheduler 启动之前同步执行，积压很大的实例升级后首次启动会被它拖慢。
- `doctor`、真实 Telegram 验收未跑。
- 没有在 Linux 上跑；CI 的 `verify` 会跑全量。

`src/adapters/local-monolith/database.ts` 现在 19,577 字节，距离 pre-commit 的 20,000 字节上限很近，下次再往里加代码需要先拆分。

## 提交

```txt
dc53b16e Run retention cleanup in serve and drop legacy config fields
```
