# Surowan - 20261114 修复 web_fetch 丢弃已失败响应体时吞掉拒绝原因

## 背景

PR #84（web_fetch 查看图片）合入后，develop 上 `e469ba12` 的 Docker workflow（run 43603953512）`verify` 失败，只挂了一个用例：

- `test/web-fetch/images.test.ts:181` › web_fetch refuses images it cannot view and invalid referers, and audits each refusal，期望 `Image exceeds`，实际是 `web_fetch failed: body must not be read`。

用例里 `/huge.png` 声明了 64 MiB 的 `content-length`，body 是一个 `pull` 会 reject 的 `ReadableStream`，用来证明超限时不读 body。但 `ReadableStream` 构造后会主动调一次 `pull` 填满 highWaterMark，reject 后流进入 errored 状态。`src/plugins/web-fetch/content.ts` 的 `storeFetchedImage` 在拒绝前 `await response.body?.cancel()`，而对 errored 流调用 `cancel()` 会以流里存下的错误 reject，于是这个错误盖掉了 `image_too_large`。

这是一个微任务竞态。临时探针（Node 26.5.0）显示：构造 Response 后等 0～3 个 tick 再 `cancel()` 会 resolve，等 5 个及以上就 reject。本机 Node 26 走到 `cancel()` 的 tick 少，测试碰巧能过；CI 的 Node 24.22.2 会先进入 errored 状态，所以失败。

生产环境也有同样的问题：真实连接如果在 runtime 丢弃 body 之前就已经出错，模型看到的会是一个笼统的抓取失败，而不是 `image_too_large`。同一模块里重定向跳转前的 `cancel()` 和 `readBody` 截断后的 `reader.cancel()` 也是这种写法。

## 主要变更

### 1. 丢弃 body 改为尽力而为

`src/plugins/web-fetch/content.ts:26`、`src/plugins/web-fetch/transport.ts:41` 和 `src/plugins/web-fetch/transport.ts:200` 三处都加上 `.catch(() => undefined)`。仓库里 `src/capabilities/media/download.ts`、`src/ingress/admin/mcp/tools.ts` 等处本来就是这么写的：

```ts
if (declaredLength > MAX_DOWNLOAD_BYTES) {
  // Discarding is best effort: a body that already failed must not mask the refusal.
  await response.body?.cancel().catch(() => undefined);
  throw new WebFetchError('image_too_large', `Image exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB`);
}
```

### 2. 测试改为确定性复现

`test/web-fetch/images.test.ts:141` 的 `/huge.png` 改成在 `start` 里直接 `controller.error(...)`，流在 Response 构造时就已经是 errored 状态，结果不再依赖 Node 版本的 tick 数。读这个 body 会 reject（所以去掉 `content-length` 预检时用例仍会失败），cancel 也会 reject（所以 cancel 的错误一旦盖掉拒绝原因，用例也会失败）。

## 验证

```bash
# 原代码 + 新测试，本机 Node 26.5.0
pnpm exec vitest run test/web-fetch/images.test.ts
# 1 failed | 3 passed；Received: "web_fetch failed: body must not be read"（与 CI 一致）

# 修复后
pnpm exec vitest run test/web-fetch
# Test Files 3 passed (3)，Tests 16 passed (16)
git diff --check
# 通过
pnpm run lint
# exit 0
pnpm run check
# exit 0
```

审计状态由原用例断言：`web-huge` 的 `tool_calls` 行为 `state = 'error'`、`error_code = 'image_too_large'`。

未执行：完整 `pnpm test`（只改了 web-fetch 插件）；本机没有 Node 24，Node 24 上的结果要看这个 PR 的 CI。`src/plugins/web-search/request.ts`、`src/capabilities/mcp/index.ts`、`src/platform/image-models.ts` 里也有不带 catch 的 `cancel()`，这次没有改。

## 提交

```txt
d3b06023 Keep web_fetch refusals when discarding a failed body
```
