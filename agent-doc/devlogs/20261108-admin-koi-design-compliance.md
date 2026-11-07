# Surowan - 20261108 Admin Koi 设计规范查漏补缺

## 背景

前两轮迁移（`73a0cd96`、`f4b2bbdd`）之后，用户指出不少页面仍不符合 Koi 设计规范，也没有跟上 `/Users/tcdw/Projects/design/apps/admin` 的标准模板，要求排查并补齐。逐页对照后发现的主要问题有：

- 页面布局仍大量依赖 Tailwind 工具类，靠 `globals.css` 把 Tailwind 主题映射到 Koi token；图标混用 lucide 与 tabler 的描边图标，不是 Koi 规定的 Font Awesome Solid。
- `src/components/ui/*` 这层 shadcn 风格适配器还在，部分控件仍是原生 select/checkbox，Dialog 页脚、行操作、表单字段的写法与 Koi 规则不一致。
- 详情页用「返回」链接而不是 PageHeader，错误态是手写的红字；登录卡片与模板不一致。
- 文案中有大量中点（`·`）分隔符，Koi 文案规则禁止这种写法。

动手前让用户确认了两个范围决定：

1. **全量对齐**：彻底移除 Tailwind，样式全部改为 Panda `css()` + Koi token/text style；图标统一为 Font Awesome 7 Solid，经 Koi `Icon` 渲染；共享组件与各页结构按模板重排。
2. **Card 按模板用**：列表页的表格直接放在页面上，只有筛选条件进 Card；概览的统计卡与最近记录放进 Card；设置类表单放在限宽 Card 里。这条取代了上一轮「只有查询区用 Card」的约束，e2e 也随之改写。

## 主要变更

### 1. 移除 Tailwind 与旧图标库

`2a408b53` 从 `apps/admin-next/package.json` 删掉 `tailwindcss`、`@tailwindcss/postcss`、`tailwind-merge`、`clsx`、`lucide-react` 与 `@tabler/icons-react`，新增 `@iconify-icons/fa7-solid`；`postcss.config.cjs` 只剩 Panda 插件，`globals.css` 只保留 cascade layer 声明、安全区变量与拖拽区规则。`panda.config.ts` 在 Koi preset 之外只补了一个系统等宽字体栈（Koi 只提供 sans）。

`apps/admin-next/src/components/icons.tsx:46` 用一个工厂把 FA7 图标数据包装成组件，Koi 自带的 Plus/Trash/Search/Chevron 等则直接从 `@tuuject/koi-react/icons` 引入。主题只写 `<html data-theme>`，不再同时写 `.dark` class。

`src/lib/utils.ts`（`cn()`）删除，`79046eec` 删除了最后一批 `src/components/ui/*` 适配器（label、radio-group、separator 等），控件全部直接使用 Koi 组件。

### 2. 共享组件按 Koi 规则重写

- `table-shell.tsx`：基于 Koi `Table`，新增 `selection`（首列 Koi Checkbox，全选 + 每行）与 `activeRowKey`（当前行选中底色与 `aria-current`），列可声明 `paddingBlock: 'none'` 给图标按钮列用。
- `list-page.tsx`：`RowActions` 按 Koi Table 规范排列行操作（`sm ghost` 按钮或 `md` IconButton，无间距、靠右、外拉 8px）。
- 新增 `setting-row.tsx`（左侧标签与说明、右侧控件）与 `form-action-bar.tsx`（模板 FormActionBar 的粘性玻璃保存条）。
- `layout/panel.tsx` 是一张 Koi `Card`，`h2` 标题同时作为区域名：`apps/admin-next/src/components/layout/panel.tsx:30` 加上 `role="region"` 与 `aria-labelledby`。
- `ConfirmDialog` 与所有对话框的取消按钮统一为 `ghost secondary`，确认是实心按钮。

### 3. 各页按模板重排

- 概览：统计卡网格、Card 包住最近 Invocation 表与「View all」，下方并排警告 Card 和 Bot 状态 Card。
- 列表页（Memories、Dictionary、Chats、Models、Prompts、API keys 等）：PageHeader → 筛选 Card → 工具栏 → 页面上的表格 → 计数与分页。Chats 行操作收进 Edit 图标按钮 + 「More actions」菜单（设置分组与快捷链接）+ 删除；Models 行操作为健康检查、编辑、「More actions」（Set as agent / vision）与删除。
- 设置类页面（Settings、Telegram、Developer、Preferences、Harness、Image settings）：768px 一栏，每组设置一张 Card，Field 宽度受限，即时生效的用 Switch，保存后生效的用 Checkbox，长表单底部是 FormActionBar。
- 详情页（Invocation、Message、Context、Image generation）：去掉返回链接，改为 PageHeader（面包屑负责返回）+「Summary」Panel + 其余各区一张 Panel。`DetailError` 改用 Koi `Empty` 加回到列表的按钮（`apps/admin-next/src/components/business/detail-state.tsx:51`）。
- 登录页：按模板换成一张 400px 的 Koi `Card`，logo 用 `secondary-solid`（`apps/admin-next/src/pages/auth.tsx:49`），提交按钮 `size="lg" fullWidth`，加载时只显示 `loadingLabel`，不再替换按钮文字。
- 文件导入用 `DropZone`，2–5 个选项用 `RadioGroup`，标签用 `Tag`，原生控件全部换成 Koi 组件。

### 4. 文案与视觉细节

- 中点分隔符全部移除（`0dc009f7`）：句子式文案改用当地语言的逗号（en `, `，zh `，`），行内元信息用布局 gap 分隔；模型发现弹窗的说明改成一整句，修掉了原来拼出 `2 selected · · relay-model-b …` 的双中点。参与时段摘要通过 `separator` 参数取 `common.separator`。
- 状态徽章（`76e47d79`）：参照模板「已完成 → neutral」，正常结束的状态（completed、success、ready、fired、merged）一律 neutral，只有进行中、等待、失败的状态上色。原来 completed 映射到 primary，在 rose 色板下和 failed 几乎同色（`apps/admin-next/src/lib/format.ts:11`）。
- Panda 不支持 `gap: '4 6'` 这种双值写法，Bot 状态和 Memo 详情的 `dl` 因此没有间距，出现「Administrator pausesNone」；已改为 `rowGap` + `columnGap`。
- 列表计数补了单数形式（`totalCount_one` / `cursorPageCount_one`），不再显示「1 records」。

### 5. e2e 适配

- Field 迁移时丢了不少控件 `id`，而 e2e 用 `#id` 定位。改为在 Koi `Field` 上传 `id`，让 label 关联保持正确；Koi Checkbox 的隐藏 input 同样会被 label 命中，相关断言改用 `getByRole('checkbox', { name })`。
- `FormActionBar` 新增 `statusId`（`apps/admin-next/src/components/business/form-action-bar.tsx:33`），图片设置的保存按钮由保存要求说明来描述，e2e 继续用 `#image-save-requirements` 断言。
- `25-koi-crud-structure.e2e.ts:13` 的 `expectCardStructure` 按新规则断言：Card 不嵌套；列表主表格不在 Card 里；筛选 Card 数量正确；概览与 Stickers 的次级表格各在一张 Card 内；设置页的表单在 Card 里。
- `/image-generations` 的结构用例原本靠赌加载态通过：e2e 后端没有接图片服务，列表接口始终返回 503，分页只在请求失败前短暂出现。用例现在用 `page.route` 给出一页真实的空数据。
- 其它断言跟着 UI 变化更新：主题改查 `data-theme`，Chats 快捷链接走「More actions」菜单，Developer 页的状态在 warning Alert 中，清除按钮文案改为「Clear payloads」。

### 6. 文档与仓库清理

`AGENTS.md`、`agent-doc/admin-panel.md`、`agent-doc/verification.md`、`apps/admin-next/README.md` 删除了 Tailwind、shadcn ui 适配层和 dark class 的描述；README 的「共享业务组件契约」按当前 barrel 导出重写，并写明模板的 Card 规则。`biome.json`、`scripts/file-token-limit.ts`、`test/file-token-limit.test.ts` 与 `CONTRIBUTING.md` 中针对已不存在的 `src/components/ui/**` 的特例一并删除。

## 验证

```bash
npx biome lint . && npx biome format .        # 即 pnpm run lint
# 退出码 0

pnpm run check
# 退出码 0（runtime、CLI、Admin 与 docs TypeScript 检查）

node scripts/file-token-limit.ts
# 退出码 0

git diff --check
# 通过

pnpm run admin:build
# ✓ built

cd apps/admin-next && npx playwright test     # 即 pnpm run admin:test:e2e
# 257 passed（58.9s，76e47d79 构建）

npx playwright test 25-koi -g "image-generations|playground|warnings" --repeat-each=8
# 32 passed（修复前同一命令 2 failed，失败原因是 image_unavailable）

npx vitest run                                # 即 pnpm test
# Test Files 366 passed；Tests 1746 passed
```

另外用 Playwright 脚本截了登录页（亮/暗）、详情页、Chats/Image settings（中文）、概览/Models/Settings/Invocation 详情（暗色 + rose 色板），以及概览/Chats/Harness 的 390px 手机宽度，逐张看过。

## 未执行

- OCR 代码审查这一轮没有跑。
- 启用 Passkeys 的 e2e（`E2E_PASSKEYS=1`）没有跑。
- Safari / Firefox 视觉验收、真实 Electron 壳、真实 Telegram 环境；截图都来自 Chromium。
- 孤儿页 `src/pages/image-assets.tsx`（develop 上就没有路由）只把残留的 Tailwind 类名换成了 Koi Button，没有接路由，也没有做视觉验收。

## 提交

```txt
2a408b535efe8b3461cc42f9d629465edbaf96a5 Replace Admin Tailwind and outline icons with Koi styles
e890d0809111b8d3751640218fafafd47bb5b55a Align Admin overview, settings and list pages with the Koi template
c4b809b65ffe1e1c94dd83c6d45abc782fb5311e Use Koi selection, switches and fields on the Admin dictionary
dd5c34e5a06221bf509a9faa4b3f803da7dc05b6 Restructure Admin chats and models around Koi row actions
f61734d949e31f7b4aeba3cc518e191d20a2b69a Give Admin prompts, web search and harness the Koi form layout
79046eecf1edb46e264b1343c766bddb45814b97 Finish the Admin move off ui adapters and native controls
14185b06fefb591158131f35ba090f0275474bdd Align Admin detail pages, sign-in and e2e with the Koi template
0dc009f7bdacb4dc89cc99f4053791e3b8c7ac49 Drop middle-dot separators and stale Tailwind notes from Admin
76e47d7905b778847f0277202feb575db623377a Keep finished states neutral and fix Admin grid gaps and counts
```
