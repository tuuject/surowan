# Surowan - 20261112 Admin 列表改为快照式翻页

## 背景

Admin Panel 的八个审计/记忆列表（Invocations、Messages、Stickers、Contexts、Memories、Group memory、Alarms、Warnings）后端都是 keyset 游标：请求 `cursor`，返回 `{ items, next_cursor }`。前端 `CursorList` / `useCursorPages` 在 `useInfiniteQuery` 上模拟上一页/下一页，页数是「已加载页数 + 1」，不能跳页，也没有总数。这套 API 本来是为无限加载设计的。

用户决定全部改成翻页式 API，并定了两条：

- 外部契约一起切：已发布的 `surowan-utils` CLI 和 MCP 工具也从 cursor 改为 offset，不保留兼容别名（与 AGENTS.md 的清理式切换一致）。旧版 CLI 会校验 `next_cursor`，升级前它的 `invocation list` 不可用。
- 数据持续增长时要保护阅读体验：打开列表即固定快照；之后前面来了新数据，只在顶部提示条显示条数；用户点提示条才刷新整个列表；不点的话，无论怎么翻页都以打开时已有的数据为准。

约束：SQLite 在进程内同步执行，一次列表请求的计数不能拖慢 Bot；messages 永不清理、带 LIKE 搜索，COUNT 本身就要扫一遍匹配行。

## 主要变更

### 1. 共享的快照分页契约

`src/ingress/admin/audit/shared.ts:27` 把 `Page<T>` 改为 `{ items, total, limit, offset, as_of, new_count }`。请求参数是 `limit`（1–100）、`offset`（规范非负十进制，< 1e9）和可选的 `as_of`。不带 `as_of` 就新开快照，服务端取锚点列的当前最大值作为 token 返回；带上它就只看锚点 ≤ token 的行：

```ts
export function idSnapshot(
  orm: Orm,
  key: SQLiteColumn,
  column: SQL | SQLiteColumn,
  asOf: string | null | undefined,
): Snapshot {
  const requested = optionalFilter(asOf);
  const token = requested === undefined ? (currentMax(orm, key) ?? 0n) : parseAsOfId(requested);
  const bound = BigInt(token);
  return { token: bound.toString(), within: sql`${column} <= ${bound}`, after: sql`${column} > ${bound}` };
}
```

`total` 和 `new_count` 在过滤后的行上用一次 `count(*) FILTER` 聚合算出（`snapshotCounts`，`src/ingress/admin/audit/shared.ts:182`），不额外多扫一遍。非法 token 返回 400 `invalid_as_of`，非法 offset 返回 `invalid_offset`。`appendCursor` 与旧的 `page()` 删除。

### 2. 每个列表选自己的锚点

- 自增整数主键直接用 id：invocations、messages、stickers、warnings，以及 alarms 的 `long_tasks.id`。空表 token 为 `"0"`。
- id 随机的表用 ISO 时间（`timeSnapshot`，`src/ingress/admin/audit/shared.ts:151`），空表 token 为 epoch：
  - memories 用 `created_at`。memo id 是随机 UUID，原来的 `id DESC` 排序其实是乱序，所以排序也改成 `created_at, id` 倒序（`src/ingress/admin/memory.ts:142`）。
  - group memory 用 `created_at`。sleeping 可能稍后才写入更早一天的事件，排序键 `day` 当不了锚点。
  - contexts 用 `last_active_at`（`src/ingress/admin/audit/conversations.ts:68`）。快照后变活跃的会话会离开原位置、计入 `new_count`，换新快照后回到顶部。
- alarms 原来是 pending/历史两段游标，现在合并为一条 `ORDER BY CASE`（`src/plugins/alarm/admin.ts:97`）：pending 按计划时间升序置顶，历史按最近状态时间倒序。
- warnings 的分页在 store 层（`src/store/warnings.ts`）。HTTP 层的参数白名单改为 `limit`/`offset`/`as_of`/`unread`，旧的 `cursor` 直接返回 400 `invalid_query`。

快照只挡插入。行内容、删除，以及因状态变化导致的过滤命中变化仍是实时的，后面的行会补位。时间锚点下，与快照同一毫秒写入的行会落进快照，可以忽略。

### 3. 前端：`useSnapshotPages` 与提示条

`apps/admin-next/src/components/business/snapshot-list.tsx:44` 取代 `CursorList`。

- **状态**：hook 保存「快照编号 + `as_of` + 页码」。打开页面、改过滤条件、点提示条，都会换新编号并回到第 1 页。
- **请求**：首个响应带回的 `as_of` 在渲染时 pin 住。之后翻页、工具栏刷新和 15 秒轮询都带同一个 token，只刷新当前页内容和 `new_count`。
- **Query key**：用快照编号而不是 `as_of`（`apps/admin-next/src/lib/queries.ts:134`）。这样 pin 住 token 不会多发一次请求，E2E 的请求记录也证实了这一点。
- **占位数据**：只在同一快照内保留上一页作为占位：

```ts
function withinSnapshot<T>(snapshot: number) {
  return (previous: T | undefined, previousQuery: Query<T, Error, T, readonly unknown[]> | undefined): T | undefined =>
    previousQuery?.queryKey[2] === snapshot ? previous : undefined;
}
```

这是全量 E2E 抓出来的：`keepPreviousData` 会在新过滤条件的结果到达前，继续显示旧条件下的行，`13-sender-ids` 因此撞上 23 个匹配元素。

- **提示条**：`new_count > 0` 时，列表上方出现 info 提示条 `SnapshotNotice`（`apps/admin-next/src/components/business/snapshot-list.tsx:102`）：「打开列表后新增了 N 条记录 / 显示新记录」。contexts 页换成「N 个会话出现新活动」。
- **读者自己新建的行**：Memories 页创建 memo 成功后递增 `snapshotKey`（`apps/admin-next/src/components/business/snapshot-list.tsx:161`），直接换新快照，而不是把读者刚写的行当成“新数据”塞进提示条。
- **Warnings 页**：改用同一个 hook。
- **Playground 时间线**：仍是往回翻的 keyset 流，`useCursorPages` 挪到 `cursor-pages.ts` 只供它使用，`ListFooter` 的 `cursor` 模式也保留。

### 4. CLI、MCP 与文档

- **CLI**：`packages/admin-surface` 的参数表把 `cursor` 换成 `offset` 与 `as-of=as_of`，MCP 工具同时接受 `as_of` 和 `as-of`。`surowan-utils invocation list` 改为 `--offset`/`--as-of`。
- **CLI 输出**：人类可读输出末尾给出 `showing a-b of total (as_of …)`、下一页参数，以及 `new_count` 提示（`packages/cli/src/commands.ts:346`）。`doctor` 和 list 都改用 `listWindow` 校验新字段。
- **文档**：agent-doc（`admin-panel.md` 新增「列表快照分页」小节、`verification.md`）、admin-next README、CLI README/REFERENCE、`skills/surowan-utils` 与文档站的 CLI 参考同步更新。
- **测试夹具**：E2E 新增 `/__e2e/insert-invocation` 钩子（`apps/admin-next/e2e/server-hooks.ts:131`）。批量 memo 种子的创建时间提前到命名 memo 之前，避免按时间排序后把它们挤出第 1 页。

## 验证

```bash
pnpm run lint
# exit 0（biome lint + format，No fixes applied）
pnpm run check
# exit 0（root tsc、cli:check、admin-next check、docs:check）
pnpm test
# Test Files 370 passed (370)，Tests 1793 passed (1793)
pnpm run admin:build && pnpm run admin:test:e2e
# 290 passed (1.3m)
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两次都 Verified 50 HTML/Markdown pages ... and 164 HTTP resources；构建前后 git status --porcelain 一致
git diff --cached --check
# 无输出
```

新增的快照行为测试：

- `test/admin/warnings.test.ts`：快照后记录的新警告只计入 `new_count`；`unread` 过滤同样作用于新行；非法 `as_of`/`offset` 被拒；旧 `cursor` 返回 `invalid_query`。
- `test/alarm/admin.test.ts`：快照后创建的 pending alarm 会排在最前，但不进入第 2 页。
- `test/admin/group-memory.test.ts`：sleeping 写入一条排序落在中间的旧日事件，逐页翻完快照不重复、不漏行。
- `test/admin/context.test.ts`：变活跃的会话离开快照、计入 `new_count`，换新快照后回到顶部。
- E2E `02-lists-filters-invocations`：插入新 Invocation 后，刷新和第 2 页都仍是原快照，提示条出现；点击后第一行变成新 id，总数从 30 变为 31。请求记录（`snapshot-requests.json`）与截图（`snapshot-notice.png`）作为附件写到 Playwright 输出目录。请求序列为 `as_of=null → 4127 → 4127(offset 25) → null`。

未执行：真实 Telegram 环境下的人工验收；旧版已发布 `surowan-utils` 对新服务端的兼容性（按决定不兼容，未测试）；大数据量（百万级 messages）下带 LIKE 搜索时的 COUNT 耗时。

## 提交

```txt
4dc0265b Switch admin lists to snapshot offset pagination
```
