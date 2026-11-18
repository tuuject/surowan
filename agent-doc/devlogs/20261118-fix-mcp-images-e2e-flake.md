# Surowan - 20261118 修复 MCP 图片 E2E 的偶发超时

## 背景

#105 让 Invocation 详情的 Tool calls、Model calls、Telegram sends 三个 tab 改用 `AuditRecords`（`apps/admin-next/src/components/invocations/audit-records.tsx`）：`useMediaQuery('(min-width: 768px)')` 为真时渲染 `TableShell`，否则渲染折叠卡片。两套 DOM 互换时，表格行的展开状态会丢失。

之后 `e2e/23-mcp-images.e2e.ts` 在 CI 上间歇失败：#105 与 #107 的 PR 都挂了，#105 合入 develop 后的 push 却通过了。失败点都在第 27 行点击 `Enlarge tool image 1`。调用日志只有 `waiting for locator`，60 秒内都没找到这个按钮。在它之前，用例刚断言过两张图片都已加载，然后截了一张 `fullPage` 截图。

本地用 `--repeat-each 8` 复现了 1 次失败。临时写了一个探针用例，在截图前给 `(min-width: 768px)` 挂 `change` 监听，每次 `fullPage` 截图都记到 `false@1x1` 和 `true@1280x720` 两次变化，截图后页面上的 `[data-tool-result]` 数为 0。也就是说，Chromium 做整页截图时会把视口短暂压到 1×1，断点翻转后 `AuditRecords` 先卸掉表格再装回来，展开的那一行随之收起。是否失败取决于 `change` 事件和下一次点击谁先到。同一探针改用元素截图或视口截图时，没有出现任何变化，`[data-tool-result]` 仍是 1。

## 主要变更

### 1. 审计截图改为元素截图

`apps/admin-next/e2e/23-mcp-images.e2e.ts:26` 原来的 `page.screenshot({ fullPage: true })` 改为只截工具结果本身：

```ts
// Not fullPage: Chromium briefly shrinks the viewport to 1x1 for it, the (min-width: 768px) query flips, and
// AuditRecords remounts the table, collapsing the row this test is about to click into.
await result.screenshot({ path: join(tmpdir(), 'surowan-mcp-images-audit.png') });
```

产物 `surowan-mcp-images-audit.png` 现在只包含三段文字和两张图片，比整页截图更贴近这一步要验证的内容。用例最后一行 Context 页的 `fullPage` 截图之后没有交互，保持不变。

产品代码不改。真实浏览器不会被压到 1×1；用户把窗口拖过 768px 时展开行收起，这个代价可以接受。

## 验证

```bash
# 修复前
npx playwright test 23-mcp-images --repeat-each 8 --workers 4
# 1 failed, 7 passed

# 修复后
pnpm run admin:build                                          # 通过
npx playwright test 23-mcp-images --repeat-each 20 --workers 4
# 20 passed
git diff --check                                              # 通过
pnpm run lint                                                 # 通过
pnpm run check                                                # 通过
pnpm run admin:test:e2e
# 342 passed
```

人工查看了新的 `surowan-mcp-images-audit.png`，两张图片与前后文字都在。

其他用例里还有 `fullPage` 截图，如 `02-lists-filters-invocations.e2e.ts:100`，所在列表页同样用 `useMediaQuery` 切换布局。这些用例目前没有失败记录，本次没有逐个排查，也不改动。CI 上的结果需等 PR 跑完确认。

## 提交

```txt
3c45038e Fix flaky MCP images E2E screenshot
```
