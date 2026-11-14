# Surowan - 20261114 修复消息批次 e2e 读写竞态

## 背景

PR #79（消息批次计时热更新）合入后，`31942331` 在 develop 和 main 上各跑了一次 Docker workflow，两次 `verify` 都失败了，挂的测试不一样：

- develop（run 43470608977）：`e2e/21-telegram.e2e.ts:132` › saves the batch timing and the running process adopts it without a restart，报 `TypeError: Cannot read properties of undefined (reading 'active')`，位置是第二次保存后的 `expect.poll`。
- main（run 43471389218）：`e2e/25-koi-crud-structure.e2e.ts:188` › /search-settings keeps its table outside Cards with real pagination，`page.waitForResponse` 等 `GET /api/search/config` 60 秒超时。

第一条的原因：测试点 Save 后立刻开始轮询 `GET /api/telegram`，这时 PUT 还在写 `config.jsonc`。`src/ingress/admin/config-file.ts` 的 `readConfigFile` 在读取前后各取一次 revision，如果中间正好发生了 rename，就返回 `409 config_conflict`，响应里没有 `bucket_timing`。`expect.poll` 只会在断言失败时重试，回调本身抛出 TypeError 会直接让测试失败。

为了确认这个机制，写了一个临时探针 spec（验证后已删除）：60 次 bucket-timing PUT，每次写入期间用 8 个并发循环请求 `GET /api/telegram`。结果是 `200 ok` 1009 次，`409 no bucket_timing (config_conflict)` 16 次。本机原测试重复 40 次全部通过，说明这个竞态只在较慢的 CI 机器上才容易出现。

第二条没有查到原因：PR #79 没有改动 search 相关代码，本机重复 40 次全部通过，CI 也没有上传 Playwright 产物，所以这次不改。

## 主要变更

### 1. 先等写入返回，再读取

`apps/admin-next/e2e/21-telegram.e2e.ts:167` 在第二次保存前先注册 PUT 响应的等待，确认写入成功后读一次即可，不再轮询：

```ts
const cleared = page.waitForResponse(
  (response) =>
    response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/telegram/bucket-timing',
);
await maximum.fill('');
await save.click();
expect((await cleared).ok()).toBe(true);
expect((await bucketTiming(page.request)).active.bucket_max_seconds).toBeNull();
```

PUT 在 `writeAndApply` 发布新配置之后才返回，前半段测试也是等 toast 出现后直接读 `active`，所以这里不需要再轮询。

### 2. helper 遇到非 2xx 时报出响应内容

`bucketTiming()`（`21-telegram.e2e.ts:125`）先断言响应成功，失败信息带上响应体。以后再出问题，看到的会是具体的 409 或 422 内容，而不是 `undefined.active`。

## 验证

```bash
# 原代码（develop 31942331）上的临时探针
npx playwright test e2e/zz-race-probe.e2e.ts --workers=1
# PROBE [["200 ok",1009],["409 no bucket_timing (config_conflict)",16]]

# 修复后，在 worktree 中
pnpm install --frozen-lockfile && pnpm run admin:build
npx playwright test e2e/21-telegram.e2e.ts --repeat-each=10
# 80 passed
git diff --check
# 通过
pnpm run lint
# exit 0
pnpm run check
# exit 0
```

修复前在主 checkout 上还跑过 `21-telegram.e2e.ts --repeat-each=15`（120 passed）和 `25-koi-crud-structure.e2e.ts -g "search-settings keeps" --repeat-each=40`（40 passed，未能复现第二条）。

未执行：完整 `pnpm run admin:test:e2e` 全套件、`pnpm test`（只改了一个 e2e spec）。修复后 CI 是否稳定，要等这个 PR 的 workflow 结果。

## 提交

```txt
11c09906 Fix the bucket timing e2e read racing its write
```
