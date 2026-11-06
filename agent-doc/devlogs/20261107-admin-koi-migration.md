# Surowan - 20261107 Admin Panel 迁移到 Koi 设计体系

## 背景

`apps/admin-next` 原先用 Rsbuild、Tailwind 与 shadcn/Radix 组件搭建。此次以 `design/apps/admin` 模板为参考，把应用壳、导航、通用控件和页面视觉整体迁到 Koi，同时保留 Surowan 现有 Admin API、认证、审计、Playground 与全部业务路由。

迁移约束包括：菜单保持原有 7 组 25 项及顺序；中英文可切换并持久化；Koi 依赖只能使用 npm 发布版；不实现 Electron，但保留模板前端为桌面壳预留的安全区、titlebar、拖拽区和主题桥接；生产环境仍须满足 AdminServer 的严格 CSP。

## 主要变更

### 1. 构建链切换到 Vite 与 Panda CSS

`apps/admin-next/vite.config.ts` 取代 Rsbuild 配置，保留 `127.0.0.1:5273`、`ADMIN_API_TARGET` 代理、Origin 重写、`@/` alias、TanStack 文件路由自动切分与 `dist/` 产物目录。新增 `panda.config.ts` 和 `postcss.config.cjs`，由 Koi preset 生成设计系统样式。

`@tuuject/koi-react` 与 `@tuuject/koi-tokens` 固定为 npm `0.3.0`，新增 Panda `~2.1.2` 与 Zustand，移除 Rsbuild、Radix、sonner 和旧字体依赖；`pnpm-lock.yaml`、`pnpm-workspace.yaml` 同步。包名、目录和静态产物路径不变，因此 AdminServer、Docker 与 CI 的现有集成继续成立。

### 2. 应用壳与通用控件迁到 Koi

`apps/admin-next/src/components/app-shell/` 实现桌面侧栏、水平导航、移动 Drawer、面包屑、用户菜单、主题和语言切换。`src/nav.ts:79` 是导航唯一数据源，保留旧 Admin 的 7 组 25 项、分组顺序和路由；`activeNavValue` 让详情页继续高亮所属列表项。

旧 shadcn/Radix 原语替换为 Koi Button、Input、Select、Card、Dialog、Table、Tabs、Switch、Alert、Menu、Toast 等组件。部分共享组件保留原调用接口作为薄适配层，以减少业务页面结构改动；Tailwind 只保留布局工具，颜色、圆角、阴影与字体映射到 Koi 语义 token。

### 3. 中英文与主题契约

沿用 i18next 的 `en` / `zh-CN` catalog 和 `admin-language` 持久化。`src/main.tsx:68` 通过 `StringsProvider` 同步翻译 Koi 自带的关闭、分页、空态等文案；新增 `e2e/24-i18n.e2e.ts`，验证全部分组、25 个链接、顺序、路由、语言切换和刷新持久化。

主题继续使用 `admin-theme`，同时维护 Koi/Panda 的 `data-theme`、JSON viewer 的 `dark` class 与桌面壳可读的 `koi-theme`。首屏仍由同源 `public/theme-boot.js` 初始化，生产 HTML 没有 inline script，不破坏 `script-src 'self'`。

### 4. 保留桌面壳前端预留

保留 `viewport-fit=cover`、safe-area/titlebar 环境变量、`data-app-region="drag"` 与控件/portal 的 `no-drag`，以及 AppShell、移动 Drawer、登录页的桌面窗口避让。`src/env.d.ts` 保留 `koiSetTheme` / `koiSetFont` / `koiSetPalette` 可选桥接类型，`ThemeProvider` 接入 `koiSetTheme`。没有复制 `electron/` 目录，也没有引入 Electron 运行依赖。

### 5. 文档与 OCR 修复

更新 `apps/admin-next/README.md`、`NOTICE`、`AGENTS.md`、`agent-doc/admin-panel.md` 和 `agent-doc/operations.md`，使当前栈、命令、主题、i18n 与许可说明和源码一致。

OCR 审查后修复了主题初始化镜像写失败回滚、面包屑来源分散、筛选器缺少可见字段名、Base UI checked 选择器、Chat 快捷菜单原生链接，以及辞典/Prompt 深链 scope 回退等问题，并补强中英文菜单分组断言。

## 验证

```bash
pnpm install --frozen-lockfile
# 通过，锁文件与依赖策略一致

git diff --check
# 通过

pnpm run check
# runtime、CLI、Admin 与 docs TypeScript 检查通过

pnpm run lint
# Biome lint 与格式检查通过

pnpm run admin:build
# Vite 8 构建通过，10057 modules transformed，生成 dist/

pnpm run admin:test:e2e
# 206 passed（最终复验 56.1s）

pnpm test
# 366 test files passed；1746 tests passed（443.51s）

ocr review --audience agent --background "<migration context>" \
  --exclude 'pnpm-lock.yaml,**/routeTree.gen.ts' \
  --output /tmp/surowan-admin-koi-ocr.txt
# exit 0；191 个目标文件；0 critical / 0 high / 8 medium / 3 low；11 条评论均已处理
```

额外验证：生产 `dist/index.html` 只有同源脚本；Koi 依赖没有 `workspace:` / `file:` / `link:`；详情路由归一化到正确父菜单；真实 E2E AdminServer + Vite 代理完成首次建号并进入 Overview。OCR 唯一 warning 是尝试读取 `node_modules` 内一个不存在的 Koi Select 内部路径，不影响 191 个目标文件审查。

代码提交后再次 fetch，`origin/develop` 没有新提交，无需 rebase。

## 未执行

- 真实 Electron 桌面壳验收：本次按范围只保留前端桥接与窗口适配，不实现 Electron。
- 真实 Telegram 验收：后端链路未改，浏览器测试使用现有 fixture 与 Faux 替身。
- 真实 `docker build`：静态产物路径与许可文件保持不变，但未实际构建镜像。
- 全页面人工视觉走查：共享壳、响应式和暗色模式由 Playwright 覆盖，最终像素级视觉仍可人工复核。

## 提交

```txt
73a0cd9604e354124a90242db8cb4b3a64ff75a8 Migrate Admin Panel to Koi design system
```
