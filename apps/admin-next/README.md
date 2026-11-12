# Surowan Admin (Next)

Surowan 的 Admin Panel 前端。构建产物是**静态 SPA**（Vite + React + Koi 设计体系
`@tuuject/koi-react` / Panda CSS + TanStack Router/Query），由后端
`AdminServer`（`serve` 进程内的 `src/ingress/admin/index.ts`）**同源托管**，不依赖任何
Node/Nitro 运行时。`dist/` 里的 `index.html` 由后端做深链接回退（未知路径回落到 SPA）。

Koi 0.5.0 以 npm 发布版引入（不能用 `workspace:*` / `file:`）。应用壳、导航、登录、
通用控件和全部页面按 Koi 的组件、recipes 与语义 token 实现，样式一律写 Panda `css()`；
图标是 Font Awesome 7 Solid（`@iconify-icons/fa7-solid`，经 Koi `Icon` 渲染，集中在
`src/components/icons.tsx`）。亮暗主题只由 `<html data-theme>` 切换。`styled-system/`
由 Panda 构建生成，已 gitignore。

## 命令

```bash
pnpm --filter surowan-admin-next run check   # TypeScript 严格检查（tsc --noEmit）
pnpm --filter surowan-admin-next run build   # 产出 dist/（静态 SPA）
pnpm --filter surowan-admin-next run dev     # Vite dev server，监听 127.0.0.1:5273
pnpm --filter surowan-admin-next run test:e2e # Playwright 浏览器 E2E（见下文）
```

- `pnpm --filter surowan-admin-next run dev` 会把 `/api` 代理到 `ADMIN_API_TARGET`（默认
  `http://127.0.0.1:8787`），仅当浏览器 Origin 精确等于
  `http://localhost:5273` / `http://127.0.0.1:5273` 时才重写 Origin 为目标的
  origin；其它 Origin 原样转发，由后端拒绝。
- 生产环境不需要 `ADMIN_API_TARGET`：`serve` 在同源托管静态文件与 `/api`。
- Lint/格式检查走仓库根目录的 Biome（`pnpm exec biome check apps/admin-next`）。

## 路由与代码切分

路由是**文件路由**，由 TanStack Router 官方 Vite 集成驱动（`vite.config.ts` 里
`tanstackRouter({ target: 'react', autoCodeSplitting: true })`）：

- `src/routes/**` 是路由文件（`__root.tsx` 是认证门与 Layout），`src/routeTree.gen.ts`
  由构建期自动生成：**已提交进仓库、被 Biome 忽略、不要手改**；新增页面 = 在
  `src/routes/` 加一个文件（组件本体仍放 `src/pages/`），然后在下次构建/`dev` 时
  让插件重写路由树。
- `autoCodeSplitting` 把每个路由的 `component` 切成独立 async chunk：首屏只加载
  shell 与当前路由，其余页面按需拉取。`src/main.tsx` 只从 `./routeTree.gen`
  取路由树，不要再手写 `createRoute` 路由表。
- 详情页与列表页是**平级**路由、不互相嵌套：文件名带 `_` 后缀
  （`invocations_.$invocationId.tsx` → `/invocations/$invocationId`，`createFileRoute`
  的 id 同样带 `_`）。漏掉这个后缀，详情页就会变成列表页的子路由并渲染进列表页的
  `<Outlet/>`——列表页没有 Outlet，页面会变成空白。

## 安全约定

- 主题初始化用同源 `public/theme-boot.js`（`localStorage` 键 `admin-theme`），
  不引入内联脚本、不写 cookie、不注入 HTML。
- 业务代码不引入 `dangerouslySetInnerHTML` / `document.cookie`。
- 主题初始化只写 `<html data-theme>`（Koi/Panda 条件），`ThemeProvider` 之后接管；
  JSON viewer 按 `useTheme()` 的解析结果选亮暗主题。
- 界面语言存 `localStorage['admin-language']`，支持 English / 中文；Koi 组件自带的
  close / pagination / empty 文案由 `StringsProvider` 一并翻译。
- 前端保留桌面壳（Electron / 安装式 PWA）预留：`viewport-fit=cover`、`env()` 安全区、
  `env(titlebar-area-*)`、`data-app-region="drag"` 与抽屉/头部避让都在纯 Web 下退化为
  0；应用不包含 `electron/` 目录，也不引入 Electron 运行时依赖。

## 许可与字体

Koi 组件与 token 使用 `@tuuject/koi-react` / `@tuuject/koi-tokens` 0.5.0（MIT）。

## E2E 测试

```bash
pnpm run admin:build                       # 前置：E2E 驱动已构建的 dist
pnpm --filter surowan-admin-next exec playwright install chromium  # 首次运行前安装 Chromium
pnpm run admin:test:e2e                    # 或在本目录 pnpm --filter surowan-admin-next run test:e2e
```

Playwright 套件位于 `e2e/**/*.e2e.ts`（文件名不以 `.test.ts` 结尾，vitest
不会发现它们）。每个 spec 文件由 `e2e/helpers.ts` 派生自己的 Node 子进程
`e2e/server.ts`：临时目录 + 临时 SQLite + `test/fixtures/admin-seed.ts` 合成数据 +
真实 `AdminServer`（`static_dir` 指向本包 `dist`），回环随机端口，用完即关并清理；
文件间互不共享状态，按全部 CPU 核心并行，任一套件都可单独运行。
用例覆盖认证状态机、路由深链接、列表过滤与快照分页（新数据提示条）、Invocation
六 Tab、记忆/管理员/模型/Chats/Developer/告警/Overview 写操作与冲突路径、只读保证与 CSP 同源
安全断言。真实命令与契约清单见
[agent-doc/verification.md](../../agent-doc/verification.md#admin-panel-浏览器-e2e)。

`e2e/server.ts` 另外为 Models 页准备离线夹具：一个回环 `/v1/models` 上游
（`e2e/models-fixture.ts` 定义模型 id 与密钥，`E2E_ACCEPTED_RELAY_KEYS` 决定
它接受哪些 Key），以及用 `loadModelsDevCatalog({ fetchImpl })` 预置的
models.dev 目录缓存——`GET /providers/discover` 与 `lookup-metadata` 因此
永远不访问外网。夹具配置里还有一个 builtin `openrouter` provider，用来覆盖
「只读连接卡 + 已启用模型列表」这条路径。

## 数据请求约定

- 业务页面一律使用 `useQuery` / `useInfiniteQuery` 并显式渲染
  loading / error / data 三态，**禁止 `useSuspenseQuery`**。查询被拒时
  promise rejection 会在渲染期抛出并落进路由错误边界，产生无法恢复的
  “Something went wrong” 死屏；显式状态分支把错误留在页面内展示
  （`ApiError.code: message`）。
- 受保护请求返回 401（code `unauthenticated`）由
  `src/lib/query-client.ts` 的全局 Query/MutationCache `onError` 集中处理：
  失效 session query，让 AuthGate 回到登录 gate。登录 / setup / 改凭据的
  `invalid_credentials` 等 401 属于表单错误，必须留在表单内展示，不得被
  全局处理吞掉（判定按错误 code，不是按 status）。

### Chats 页（`src/pages/chats.tsx`）

- Manage → Chats 管理配置里的 Chat 与 Topic 白名单，以及 Chat 范围的模型 / thinking；不提供 Topic 级模型。Chat ID 与 Topic ID 全程保持字符串，服务端校验安全整数后写入配置。
- `GET /api/chats` 同时返回 `saved` 与 `active`，页面并排显示 Saved settings / Running settings。增删 Chat、Topic 范围变化只有重启后生效；已有 active Chat 的模型设置热应用于下一次 Invocation。删除不清除审计历史，最后一个配置 Chat 不能删除。
- 空 Topic 输入表示不限制 Topic；Global default 恢复模型与 thinking 继承，也可只覆盖 thinking。选了 Chat 模型时 thinking 必须显式指定（不提供继承项）。可选模型与思考档取自服务端，换模型自动选最弱档。
- 表单与删除确认打开时冻结 revision 和数据快照。后台刷新不能升级草稿的 `If-Match`；`config_conflict` 关闭旧对话框并要求重新打开。写入成功或失败都刷新 Chats / Models / config-status，因为失败也可能已写文件但未应用；错误仍内联展示。Settings 应用配置也使这三个视图失效。
- `e2e/09-chats.e2e.ts` 覆盖增删、Topic 待重启、热切模型与恢复继承、并发修改/删除、真实保存后应用失败与恢复、移动端暗色表单。

### Developer 页（`src/pages/developer.tsx`）

- Manage → Developer 通过现有配置写入流程管理可选的 `developer.record_model_payloads`（默认关闭），保存后热应用，保留文件与运行态不一致时的反馈。
- 清除历史报文使用 `ConfirmDialog` 明确确认；成功展示清除调用数，并使 Invocation 详情缓存失效。仅清除请求/响应快照，正常审计不变；说明 SQLite 文件未必缩小。
- `e2e/10-developer.e2e.ts` 覆盖默认值、切换与刷新持久化、取消/确认清除、详情空报文状态。

### Models 页（`src/pages/models.tsx`）写入约定

- 每个写请求都带 `GET /api/providers` 返回的 `revision`（`If-Match`）。
  `409 config_conflict` 表示 config.jsonc 在编辑期间被改动：提示 “config.jsonc changed…”、
  重新拉取，再让用户重试（`lib/model-manager.ts` 的 `writeErrorMessage`）。
- 保存反馈区分 “Applied” 与 “Saved, restart required”：只要 `apply.restart_required` 非空，
  就不能显示成全部已应用（`applyFeedback`）。Models 页自己的写入全部热应用，但其它字段仍可能
  待重启，此时也显示 “Saved, restart required”。待重启横幅与 “Restart now” 按钮由全局
  `restart_required` + `supervised` 驱动（未声明 `PLASTICWAN_SUPERVISED=1` 时只列字段并提示手动重启）。
- 凭据只写不读：`api_key` 与 header 值永远是 `type="password"`、`autocomplete="new-password"`
  的空输入框，没有查看按钮；提交后用 `mutation.reset()` 立刻把带明文 key 的请求体
  从 mutation cache 里丢掉。页面不写 localStorage，也不把 key 放进任何持久结构。
- 元数据草稿（`ModelMetadataDraft`）带 `sources` 与 `needs_confirmation`：`null`、或只有
  猜出来的匹配（`models.dev-cross-provider` / `models.dev-fuzzy`，见 `match.confidence`）
  支撑的字段必须由管理员确认后才能保存——字段齐全的可以用 “Accept listed values (N)” 一次接受，
  有空缺的要进编辑弹窗填写。面板不替模型填默认值；“Advanced” 折叠区只显示当前 API 真正支持的
  compat 字段。
- thinking 级别：`thinking_levels` 缺失不算空缺（沿用 Pi 默认），猜出来的照样要确认。
  模型接受哪些级别由 `supportedThinkingLevels` 计算，与服务端
  `src/platform/thinking-levels.ts` 是同一条规则，改一边必须改另一边。

面板 UI 文案全部经 i18next（English / 中文），新增可见文案必须同时补两个 catalog；本文档引用界面文案时用英文原文（E2E 固定 `en-US`）。

## 共享业务组件契约

页面必须复用 `src/components/business/` 下的公共层，不要复制各自的
加载/错误/空态实现，也不要发明跳页或全量排序。统一从 barrel 导入：

```ts
import {
  ChartPanel, ConfirmDialog, CopyableValue, DetailError, DetailSkeleton,
  FormActionBar, JsonViewer, KvList, LazyDetails, ListFilterCard, ListFooter,
  ListPageHeader, ListSearchForm, ListToolbar, MonoValue, RowActions, SettingRow,
  SnapshotList, SnapshotNotice, StateBadge, TableShell, TextValue, ToneBadge,
  useClientPagination, useOffsetPagination, useSnapshotPages,
  type ColumnSpec, type TableSelection,
} from '@/components/business';
```

页面区块复用 `@/components/layout/panel` 的 `Panel`：默认是 Koi `Card`，
`variant="plain"` 则是直接铺在页面上的 `section`。两者都有 `h2` 标题
（同时作为区域名，`role="region"` + `aria-labelledby`）、可选一行说明与右侧操作。
独立摘要和设置组可用 Card；同一工作区里的连续分区用 plain，以留白和分隔线建立层级。
Models 页只给 Current models 摘要保留 Card，Provider 导航、Connection 与 Models 都不包卡。
一张 Card 只装一件事，Card 里不再套 Card。

### 列表页骨架 `list-page.tsx` 与 `query-form.tsx`

- 顺序固定为 `ListPageHeader`（标题、说明、页级操作）→ `ListFilterCard`（唯一的
  筛选 Card，内放 `ListSearchForm`）→ `ListToolbar`（左侧新建等操作，右侧选择信息与
  刷新）→ 直接放在页面上的 `TableShell` → `ListFooter`（真实计数与 Koi 分页）。
- `ListSearchForm` 的输入只是草稿，点 Search 或回车才写进 URL；`ChatFilter` 的
  建议项也不会直接应用查询。
- `RowActions` 是表格行操作：`sm ghost` 按钮或 `md` IconButton，无间距、靠右并向外
  拉 8px，危险操作用 `color="error"`。

### 分页 `snapshot-list.tsx`、`cursor-pages.ts` 与 `pagination.ts`

- `SnapshotList` / `useSnapshotPages`：服务端快照分页（`limit`/`offset`/`as_of` →
  `total`/`new_count`，契约见 agent-doc/admin-panel.md「列表快照分页」）。打开页面、改过滤
  条件或点 `SnapshotNotice` 才开新快照并回到第 1 页；翻页、刷新与 15 秒轮询停在同一快照，
  新行只体现为提示条。页面自己插入行后递增 `snapshotKey`，让读者直接看到自己写入的行。
- `useCursorPages`：只给 Playground 房间时间线这种往回翻的 keyset 流；`ListFooter` 的
  `cursor` 模式只显示当前页条数和「已知页 + 可能的下一页」，从不编造总数。
- `useOffsetPagination` 给返回 `total` 的 offset API，`useClientPagination` 给一次性
  返回的整个数组（每页 10 条）。
- **禁止**：对已加载数据做客户端排序、把 error 当空态。

### 表格外壳 `table-shell.tsx`

- `TableShell<T>({ columns, data, rowKey, expandedRender?, isExpandable?, emptyText?,
  emptyDescription?, emptyAction?, minWidth?, layout?, caption?, loading?, skeletonRows?,
  selection?, activeRowKey? })`，基于 Koi `Table`；横向滚动由 Table 自带，行展开是本地
  state（chevron 列）。
- `ColumnSpec<T>`：`{ key, title, align?, width?, paddingBlock?, skeleton?, className?,
  render(row) }`；图标按钮列用 `paddingBlock: 'none'`。
- `selection` 渲染首列 Koi Checkbox（全选 + 每行），`activeRowKey` 给当前行选中底色与
  `aria-current`。无跳页、无排序。

### 设置类表单 `setting-row.tsx` 与 `form-action-bar.tsx`

- 设置页是限宽 768px 的一栏，每组设置一张 `Panel`；控件用 Koi `Field` 包裹，即时
  生效的开关用 `Switch`，保存后才生效的选择用 `Checkbox`。
- `SettingRow({ label, description?, hint?, children })`：左侧标签与说明、右侧控件，
  `children` 拿到 `{ id, describedBy }` 接线。
- `FormActionBar`：长表单底部的粘性保存条（玻璃底 + `float` 阴影）；`status` 常驻
  `role="status"`，`statusId` 让提交按钮由它描述，`error` 以 `role="alert"` 显示。

### 状态徽章 `state-badge.tsx`

- `StateBadge({ state })`：state → `stateColor`（`lib/format.ts` 的状态色表）
  → 语义变体（success/info/warning/danger/neutral）。未知状态与未知颜色一律
  兜底 neutral；`null`/空串渲染为 `—`。`ToneBadge` 直接按语义着色。
- `stateBadgeSemantic(state)`：纯函数，测试/样式复用。

### JSON 查看器 `json-viewer.tsx`

- `JsonViewer({ value, title?, defaultMode?, initiallyCollapsed?, collapseThresholdChars? })`：
  树/文本切换；畸形 JSON 自动降级为原文（文本模式）；payload 超过
  `collapseThresholdChars`（默认 2000）默认折叠并显示字符数；**只渲染文本，
  永不执行 HTML**；`value` 为 `null`/空串时显示 `—`。
- 文本内容不一定合法 JSON（如 `result_text`），直接传字符串即可。
- 折叠的大 payload 走 `LazyDetails`，展开前不构建 JSON 树。

### 懒挂载折叠区 `lazy-details.tsx`

- `LazyDetails({ summary, children, className? })`：原生 `<details>` 语义 +
  **展开前不挂载 children**。原生 `<details>` 只是把子树隐藏起来，仍然会渲染
  DOM——重内容（`JsonViewer` 树、tool registry 表格、长文本）必须用它包一层。
- 首次展开后 children 常驻，折叠不清空查看器内部状态（树/文本模式、节点展开）。
  summary 自带旋转的 chevron，样式由组件统一，调用方只传内容。

### 键值明细与文本 `kv-list.tsx`

- `KvList({ items: { label, value }[] })`：详情页诊断字段网格，按容器宽度自适应
  1–3 列。
- `TextValue({ value })`：可空文本，空值显示 `—`。
- `MonoValue({ value })`：可空等宽 ID（bigint 字符串字段保持字符串，不要
  转 `Number`）。

### 可复制值 `copyable-value.tsx`

- `CopyableValue({ label, value })`：显示标签与等宽字符串，通过图标按钮复制原始 `value`，不包含标签或其它修饰；`null` 显示 `—` 且不提供复制按钮。
- ID 始终保持字符串，不能转 `Number`；按钮有包含标签和值的可访问名称，成功/失败使用本地化 toast，剪贴板不可用时保留手动选择复制的入口。不调用任何 API。
- Messages / Revision 由页面按 `telegram_type` 区分用户与频道身份；Invocation 使用冻结快照的 `sender.id`，不回填当前资料。

### 二次确认弹窗 `confirm-dialog.tsx`

- `ConfirmDialog({ open, onOpenChange, title, description?, confirmText,
  cancelText?, destructive?, pending, error, onConfirm })`，供破坏性/控制
  操作使用。
- 弹窗由 Koi `Dialog`（`role="alertdialog"`）渲染：取消是 `ghost secondary`，确认是
  实心按钮（`destructive` 时 `color="error"`），pending 时显示 loading。Koi/Base UI
  不在点击时隐式关闭，`onConfirm` 一定执行。`onSelect` 仍只属于 Menu/Select，不要用在
  确认按钮上。
- **弹窗不自动关闭契约**：确认后由调用方在 mutation 成功/取消时设置
  `open=false`；`pending` 期间两个按钮禁用防重复提交，失败时弹窗保持打开
  并内联展示 `error`（`ApiError.code: message`）。调用方的 `onOpenChange`
  应在 mutation pending 时拒绝关闭（`!open && !pending` 才置 false）。
- **文案契约**：`confirmText` 必须描述具体动作（如 `Cancel alarm` /
  `Delete memory`），且必须与 dismiss 文案可区分——组件在渲染时校验
  `confirmText !== cancelText`，两者相同会直接抛错；默认 dismiss 文案为
  `Dismiss`，不要再把 dismiss 写成 `Cancel` 与确认动作混淆。

### 图表卡片 `chart-card.tsx`

- `ChartPanel({ title, children, className? })` + `TimeSeriesChart({ data,
  series, height? })`：基于 recharts 的时间序列折线封装，Overview/Usage
  使用。`ChartSeries = { dataKey, label, color }`，
  `ChartDatum` 的 `date` 字段作 x 轴。只画 API 真实返回的序列，不合成指标。

### 私有推理标记 `private-reasoning.tsx`

- `PrivateReasoningTag()`：金色徽章“Private reasoning”，用于 assistant 行。
- `PrivateReasoningNote()`：说明文案——assistant 文本是私有推理，只有成功的
  `send` tool call 才发往 Telegram。
- 任何展示 agent 消息的页面都必须把 assistant 普通文本标为私有推理。

### 详情页状态 `detail-state.tsx`

- `DetailSkeleton()`：详情页统一的 loading 骨架（两个大块占位）。
- `DetailError({ error, notFoundTitle, failedTitle, backTo, backLabel })`：
  详情页错误态，用 Koi `Empty` 渲染——404 显示 `notFoundTitle`，其余失败显示
  `failedTitle`，说明行用 `lib/errors.ts` 的 `errorMessage`（`ApiError.code: message`），
  操作是回到列表的按钮链接。
- 详情页结构：`ListPageHeader`（面包屑负责返回）→ 「Summary」`Panel`（`KvList`）→
  其余各区一张 `Panel`。四个详情页（invocation / context / message / image generation）
  共用这两个状态组件，页面自身只保留 `isPending / isError / data === undefined`
  的控制流和第三态（数据）渲染；`useSuspenseQuery` 依旧禁用。

### 契约禁止事项

- 共享组件不内嵌任何具体页面的业务字段；页面通过 render 函数/ColumnSpec 提供。
- 不在共享组件里使用 `useSuspenseQuery`、不调用受保护接口、不做 mutation。
- 通用控件和页面壳使用 Koi 组件/recipes；布局用 Panda `css()`，颜色、圆角、阴影与
  字体只引用 Koi 语义 token 与 text style，亮暗模式由 `data-theme` 统一切换。
- Card 按 Koi 管理模板使用：列表页的表格直接放在页面上，只有筛选条件进 Card；概览的
  统计与最近记录、设置类表单（限宽 768px）放在 Card 里；Card 不嵌套。
