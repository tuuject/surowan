# Surowan - 20261122 Invocation 详情页自动滚动到底部与悬浮开关栏

## 背景

上一次改动（`agent-doc/devlogs/20261121-invocation-live-refresh.md`，PR #125）让 Invocation 列表与详情页跟随 SSE 变更流自动刷新，「自动刷新」开关放在两个页面的标题栏。用户盯一次正在运行的 Invocation 时，新的 Tool 调用、模型调用、发送都追加在页面底部，需要手动往下滚才能看到；用户希望加一个「自动滚动到页面底部」的开关，并把它放在悬浮栏上。

改动前：

- 详情页的「自动刷新」开关在页面顶部标题栏，读者滚到下面看新行时够不到它。
- 详情数据按 id / sequence 升序返回（`src/ingress/admin/audit/invocation-detail.ts` 的 `orderBy`），新行总在各标签页的末尾，所以「跟上新进展」就是「滚到页面底部」。
- 面板的滚动容器是 `html`（`apps/admin-next/src/styles/globals.css` 让 `html` 负责 `overflow-y`），不是某个内部容器。

## 主要变更

### 1. 详情页底部的悬浮开关栏

新增 `apps/admin-next/src/components/invocations/live-controls.tsx`（`InvocationLiveControls`，`:46`），放在详情页内容的最后（`apps/admin-next/src/pages/invocation-detail.tsx:111`），里面是「自动刷新」与新的「自动滚动到底部」两个开关。详情页标题栏不再放「自动刷新」，列表页保持不变。

样式沿用设置页保存栏 `FormActionBar` 的做法：`position: sticky` 贴在视口底部，滚动时浮在内容上，到页面末尾后落在最后一节之后，不会盖住最后一行；玻璃底色 `surface-glass-tint`、`float` 阴影，圆角用 Koi 给悬浮条的 `radius-bar`，宽度随内容、靠行尾对齐，窄屏时两个开关换行。两条贴底栏共用一个层级，所以把 `FormActionBar` 里私有的 `30` 提到 `apps/admin-next/src/components/app-shell/shared.ts` 的 `STICKY_BAR_Z_INDEX`。

### 2. 「自动滚动到底部」的触发时机

偏好 `invocationAutoScroll` 放进持久化的 `apps/admin-next/src/stores/ui.ts`（`surowan-admin-ui`），默认关闭。

- 打开开关的事件处理里立刻滚到底部。
- 开着时，`invocationQuery` 每带回一份**新的**数据就再滚一次。TanStack Query 的结构共享让内容没变时对象引用不变，所以重取到相同数据（例如流连接时补推的那一次）不会滚动。
- 打开页面时的首份数据只标记起点，不会自己跳到底部；开关关着时到达的变化也不在打开后补滚。

实现上不写 `useEffect`：`FollowChanges`（`:28`）在渲染期比较数据引用，开着时把变化计数加一，并以计数为 `key` 挂一个隐藏锚点，锚点的 callback ref 在 React 提交新行之后执行，所以量到的页面高度已经包含新行：

```tsx
if (value !== seen) {
  setSeen(value);
  if (enabled) {
    setChanges(changes + 1);
  }
}
return changes === 0 ? null : <span key={changes} ref={scrollOnAttach} hidden />;
```

滚动用 `window.scrollTo` 到 `document.documentElement.scrollHeight`，`prefers-reduced-motion: reduce` 时改为瞬时滚动（`scrollPageToBottom`，`:10`）。切换标签页、展开行不改变数据，所以不会触发滚动。

### 3. 文案与文档

- 四种语言新增 `layout.business.autoScroll`：Auto scroll to bottom / 自动滚动到底部 / Automatisch nach unten scrollen / التمرير التلقائي إلى الأسفل。
- `agent-doc/admin-panel.md` 写明悬浮栏的位置、触发规则与实现要点；`agent-doc/verification.md` 记录新的 e2e 覆盖；用户指南 `apps/docs/content/docs/configure/admin.md` 改成「列表顶部和详情页底部的悬浮栏」并补上「自动滚动到底部」一句。

## 验证

`apps/admin-next/e2e/40-invocation-live-refresh.e2e.ts:265` 新增一条用例，在 1280×560 视口上断言：默认关闭，页面顶部时两个悬浮开关都在视口内；关着时新行到达不移动页面；打开即滚到底；读者回到顶部后，下一条新行把页面带回底部且新行在视口内；刷新后开关仍开着，但打开页面不会自己跳到底；再关掉后新行不移动页面。产物为 `detail-auto-scroll.png` 截图。原有的 390px 用例改为断言两个开关都在视口内。

把 `<FollowChanges>` 临时拿掉后，这条用例在「新行把页面带回底部」一步失败（距底部 551px），还原后通过。另用一条临时用例（已删除，未提交）截了中文、暗色主题下的桌面与 390px 截图，人工看过：悬浮栏在暗色下可辨识，中文在手机宽度下单行放得下。

```bash
git diff --check                                   # 通过
biome lint . && biome format .                     # 通过（pnpm run lint 在本机被一个输出包装器截断，直接跑 biome 的退出码为 0）
pnpm run check                                     # 通过
node scripts/file-token-limit.ts                   # 通过（13 个文件）
pnpm test                                          # 483 files / 2489 tests 全部通过
pnpm run admin:build && pnpm run admin:test:e2e    # 386 passed（2.4m）
pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify                                # 通过
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify  # 通过
pnpm run manual:prepare                            # 通过（56 篇）
git status --porcelain                             # 构建后只有本次改动
```

未执行：真实浏览器里长时间挂着一次真实运行的人工验收、`doctor` 与真实 Telegram 验收。

## 提交

```txt
e8c021b3 Add auto scroll to the Invocation detail page
```
