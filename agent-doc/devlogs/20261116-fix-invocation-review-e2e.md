# Surowan - 20261116 Invocation 批改 e2e 断言修复

## 背景

`61c9152c`（Polish invocation review buttons and comment editor，PR #91）把 Invocation 详情页批改面板描述里的中点分隔符（` · `）换成了 CSS `columnGap`，两条计数文案拆成了两个独立 `<span>`。e2e 断言仍在找 `「N comments on this invocation · M invocations in your review draft」` 的整串文本，DOM 里这个串已不存在，三条用例在 `expect(...).toBeVisible()` 上 10s 超时：

- `34-invocation-review-workflow`：主流程用例（5 处断言）；
- `34-invocation-review-resilience`：malformed localStorage 与 setItem 失败两条用例（各 1 处）。

develop 的 verify job（run 43828143241）因此红了，326 过 3 挂。UI 行为变化是刻意的，所以修的是测试断言而不是组件。

## 主要变更

`e2e/review-helpers.ts` 新增 `expectReviewCounts(page, thisInvocationCount, draftInvocationCount)`：对两段计数文案分别做 `getByText(..., { exact: true })` 可见性断言，替代原来的整串匹配。两个 spec 文件的 7 处断言全部改走该 helper；第三个 spec（`34-invocation-review-export`）没有这类断言，未动。

其余 locator（`Add overall comment` 按钮、`Overall comment`/`Review comment` textbox、Edit/Save/Delete）经核对不受影响：Koi `Field` 通过 Base UI 的 `Field.Label` ↔ `Field.Control` 关联继续提供可访问名，ghost 按钮的可访问名仍是其文本。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm --filter @surowan/admin-surface run build   # 本地 dist 过期，tsc 会报无关错
pnpm run admin:build
cd apps/admin-next && pnpm exec playwright test e2e/34-invocation-review
# 4 passed（含 CI 挂掉的 3 个用例）

git diff --check && pnpm run lint && pnpm run check
# 全部通过（root + cli + admin-next + docs typecheck）
```

未执行：

- 完整 `pnpm run admin:test:e2e` 全量（329 条）未重跑，只跑了受影响的 3 个 spec；
- `pnpm test` vitest 全量未跑（改动仅限 e2e 文件，vitest 不覆盖）。

## 提交

```txt
2a159de3 Fix invocation review e2e assertions for split count text
```
