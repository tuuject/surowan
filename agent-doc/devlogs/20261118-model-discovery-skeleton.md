# Surowan - 20261118 获取模型列表弹窗改用骨架屏

## 背景

已有 Provider 的「获取模型列表」弹窗打开即请求列表。等待期间，「重新获取」按钮的文字变成「获取中…」，弹窗只剩这一个按钮，列表到达时整体撑开。按钮本身是 `sm` + `outline`，独占一行时尺寸和边框都很突兀，不符合 Koi 的风格：已知布局、未知数据应当用 Skeleton，页面级控件默认用 `md`。

## 主要变更

### 1. 列表加载时保持布局

`ModelDraftList`（`apps/admin-next/src/components/models/model-draft-list.tsx`）新增 `loading` 与 `toolbarEnd`：

- 搜索框带上搜索图标，与 `toolbarEnd` 放在同一行，高度都是 36px。
- `loading` 时搜索框禁用，列表外框保留，内部显示三行仿真骨架：16px 复选框占位，以及 ID、参数、来源三条 12px 的线，宽度各不相同。整块用 `role="status"`，附一段只给读屏器的「加载中…」。

弹窗（`apps/admin-next/src/components/models/model-picker-dialog.tsx`）在获取模式下，从请求开始就渲染列表：

- 请求地址还没拿到时，原位显示一条骨架线。
- 「重新获取」改为搜索框旁的 `IconButton`（ghost secondary、md，图标 `RefreshIcon`），名称与 tooltip 都是「重新获取」。请求期间禁用。
- 重新获取时同样换成骨架，同时隐藏「已选择 N 个」那一行，「添加」按钮也被阻止，避免在即将被替换的旧列表上勾选。

### 2. 首次失败由错误提示承载重试

首次获取失败时还没有列表，也就没有刷新按钮。错误改用 `Alert tone="error"` 显示，并带一个 ghost「重新获取」按钮。重试期间 query 仍处于 error 状态，因此只在不处于 fetching 时显示错误，避免和骨架同时出现。

### 3. 手动添加的查询按钮

手动模式的「查询」按钮改用 Koi `Button` 的 `loading`，标签固定。删除了不再使用的 `models.models.picker.lookingUp` 文案（四种语言）。

## 验证

```bash
git diff --check                 # 通过
pnpm run lint                    # 通过
pnpm run check                   # 通过（rebase 到 95b06735 后 admin check 复跑通过）
pnpm run admin:build             # 通过
pnpm run admin:test:e2e 08-models 29-modal-transitions 01-routes 25-koi-crud
# 88 passed
```

新增用例 `apps/admin-next/e2e/08-models.e2e.ts`「discovery holds its layout with placeholder rows, and a failed first fetch retries from the error」：先拦住首个 discover 请求，断言骨架状态（status 文案、搜索框与刷新按钮禁用、没有「Fetching…」文字）；再让它以 502 失败，断言 Alert 及其中的重试按钮；最后点重试，走真实 loopback 上游，断言列表行出现、控件恢复可用。用例生成 `discovery-loading.png`、`discovery-failed.png` 与 `discovery-listed.png`。

另外临时把该用例改成 412px 视口、暗色模式跑了一遍，人工检查了三张截图，之后把用例改回原样。实机移动端与生产环境验收未执行。新建 Provider 向导里的「获取模型列表」按钮仍是原来的文字切换，不在本次范围内。

## 提交

```txt
8a01ffb2 Show a skeleton while fetching provider models
```
