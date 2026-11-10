# Surowan - 20261107 Admin Koi 管理页结构与分页返工

## 背景

首轮 Admin Koi 迁移后，用户逐轮指出结构与视觉仍未真正对齐模板：旧分组只是静态标题；CRUD 页面没有沿用订单管理结构；Dashboard 仍是旧拼卡布局；列表保留 Load more；非查询区仍使用 Card；筛选仍是旧即时过滤布局；查询 Input 的 focus ring 还会被折叠面板裁掉。

本次在原 PR 上继续返工，以 Koi admin 的 Dashboard、Orders 与 OrderSearchForm 为权威参考，同时保留旧 Admin 的菜单契约、真实 API、安全校验和中英文能力。

## 主要变更

### 1. 旧分组改成真正的可折叠父菜单

`apps/admin-next/src/components/app-shell/use-nav-menu.tsx` 改为 Koi parent/children NavMenu。监控、运行记录、Agent 数据等 7 个分组都是带图标、可折叠展开的一级父菜单，桌面侧栏、折叠 rail、水平 flyout 与移动 Drawer 共用同一棵树。

旧版仍是 7 组 25 个子项，顺序和路由不变；当前路由所在组自动展开，父组显示 active path，子项保留 `aria-current`。EN/ZH 父组与子项即时切换。实现期间曾误把孤儿 Image assets 接成第 26 项，已在审查中撤回路由、菜单和专属测试，原页面文件继续保留为无路由代码。

### 2. Dashboard 与 CRUD 页面按模板重组

`apps/admin-next/src/pages/overview.tsx` 改为 PageHeader、真实统计指标、最近 5 条 Invocation 表格与 View all，再接警告和 Bot/Telegram 状态；Wake、取消挂起会话和标记警告已读仍调用原 API，没有 mock。

Memories、Group memories、Dictionary、Alarms、Bot admins、Chats、Models、Prompts、API keys、Search settings、Passkeys、Image settings、Image assets 与 Playground 等列表管理区域统一采用订单页的筛选、真实操作工具栏、表格 loading/empty、计数/分页和 Dialog 层级。Invocations、Messages、Contexts、Stickers、Image generations 等只读列表也复用相同结构，但不虚构新增、批量删除或权限外操作。

### 3. 全部列表改成真实分页

`apps/admin-next/src/components/business/pagination.ts` 与 `cursor-list.tsx` 提供三类分页：

- offset/total API：按真实 offset 和 total 显示页码。
- 全量响应：只对渲染做真实数组切片，原始完整数组仍用于 revision、权限和跨行校验。
- keyset cursor：每页只显示当前 cursor page，维护已获取页与 cursor 历史，Previous/Next 往返；筛选回到第 1 页，没有 total 时只显示已知页与可能的下一页，不伪造总页数。

取消了 Load more 和无限拼接。分页修复还覆盖筛选 A → B → A 时旧页码复活、慢速 Next 覆盖后续 Previous、末页删除后页码收敛、跨页选择、Prompt scope 切换泄漏比较草稿等竞态。

Playground Invocation 列表原先只能拿最多 20 条，不能伪装全量分页，因此 `GET /api/playground/rooms/:id/invocations` 做向后兼容扩展：保留 `limit` / `items`，新增非负十进制 `offset` 与响应 `total`，SQL 使用真实 limit/offset + count。`agent-doc/admin-panel.md` 已同步该契约；无数据库或配置迁移。

### 4. 只有查询条件使用 Card，筛选改为手动提交

页面内容区只有共享查询区域使用 Koi Card；统计、最近记录、表格、工具栏、状态、设置和 Playground 都改成普通 section/panel/table。旧 `ui/card.tsx` 删除，源码中 Koi Card import 只剩 `components/business/list-page.tsx`。

新增 `query-form.tsx` 与 `lib/list-query.ts`，对齐 OrderSearchForm：Koi Field/Input/Select、响应式 1/2/3/4 列、移动端折叠、Search submit 与 ghost Reset。输入和 Select 只改 draft，Search 或 Enter 才 normalize、更新 URL、回第 1 页并查询；Reset 清空条件，Back/Forward 与深链恢复已应用 draft。旧即时 FilterToolbar 与重复 search-params 路径删除。

### 5. 修复查询控件 focus ring 裁剪

根因是桌面查询区没有额外内边距，Collapsible.Panel 的测量高度等于内容高度，而 Koi focus ring 位于控件外圈；长期 `overflow: hidden` 会裁平左、右、下边缘。

`list-page.tsx` 现在只在展开动画稳定后把 panel 改为 `overflow: visible`，打开/关闭动画和闭合状态仍裁剪，高度动画与 reduced-motion 不变。新增 `26-query-focus-ring.e2e.ts`，解析真实 box-shadow 外扩量并检查所有裁剪祖先，覆盖桌面 Input/Select 和移动展开/闭合。Playwright 局部截图与像素扫描确认修复前只有一行边框，修复后外圈完整。

### 6. 审查与测试适配

OCR 首轮对追加 diff 审查 105 个文件，报告 14 个 medium / 2 个 low：13 个 medium 已修，warning focus 一项经源码与 E2E 证明为误报。focus 修复后的最终 OCR 审查 117 个文件，报告 5 个 medium / 1 个 low：medium 已全部修复，low 是孤儿 Image assets 的嵌套三元样式项，未扩大范围处理。

提交钩子发现 `02-lists-filters.e2e.ts` 超过 5,000 tokens，按职责原样拆成 `02-lists-filters-invocations.e2e.ts` 与 `02-lists-filters-resources.e2e.ts`，28 个测试与断言保持不变。启用 Passkeys 的可选套件还暴露两处旧 Sign out 定位器，已改为 User menu → Sign out，8 项真实 WebAuthn 测试全部通过。

## 验证

```bash
git diff --check
# 通过

node scripts/file-token-limit.ts
# 通过，超限筛选套件已拆分

pnpm run check
# runtime、CLI、Admin 与 docs TypeScript 检查通过

pnpm run lint
# Biome lint 与格式检查通过

pnpm run admin:build
# Vite 构建通过

pnpm run admin:test:e2e
# 257 passed（最终主 agent 复验 1.2m）

E2E_PASSKEYS=1 pnpm run admin:test:e2e 16-passkeys
# 8 passed（真实 WebAuthn ceremony）

pnpm test
# 366 test files passed；1746 tests passed（451.08s）

ocr review --audience agent --background "<strict Koi migration context>" \
  --exclude '**/routeTree.gen.ts' --output /tmp/surowan-admin-koi-final-after-focus-ocr.txt
# 117 selected / 117 completed / 0 failed；0 critical / 0 high；5 medium 已修复
```

focus 回归做过反向 mutation：恢复 `overflow: hidden` 后桌面用例真实失败，恢复修复后通过。筛选拆分后的两个文件独立运行 28 passed，完整套件仍为 257。代码提交后 `origin/develop` 没有新提交，无需 rebase。

## 未执行

- 真实 Electron 壳、真实 Telegram 与 Docker 镜像构建。
- Safari / Firefox 视觉验收；当前浏览器与 focus 证据来自 Chromium。
- 启用 Passkeys 时“成功加载后后台刷新失败”的专门故障注入用例；标准与启用态 Passkeys 套件均通过，但该特定路径未新增覆盖。

## 提交

```txt
f4b2bbdd92077c155af54a672c7a3099be5491fa Align Admin Panel with Koi management pages
```
