# Documentation site

Rspress 2 静态站，默认语言为简体中文（站点根路径），英文挂在 `/en/`，独立于 Bot/Admin 服务。公开内容根仅为 `content/`；维护者主题文档仍在 [`agent-doc/`](../../agent-doc/README.md)。

## 本地开发与验证

在仓库根目录使用 Node.js 24+ 与 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm run docs:dev
pnpm run docs:check
pnpm test test/docs
pnpm test test/manual-pack.test.ts
pnpm run docs:build
pnpm run docs:verify
pnpm run docs:preview
```

开发与预览默认监听 `127.0.0.1:5274`，不要同时占用同一端口。`docs:verify` 对已有 `dist/` 验证两种语言的内容、链接、来源提交、`llms.txt`/`llms-full.txt`、搜索索引、下载文件、旧 URL 重定向，并临时启动框架原生生产预览（回环地址、5276 起可用端口），逐个 HTTP 核对后关闭。它不调用 Bot、Doctor、Telegram 或 Provider；不存在的 Markdown 必须在 `/` 与 `/en/` 下都返回 404，不得用 SPA fallback 返回首页。

Markdown、`llms.txt`、`llms-full.txt` 只有生产构建能完整验证，不能用 dev 页面代替。每次更改正文、主题或生成逻辑后重新构建再 verify。

## 双语目录与页面一致性

```text
content/
  public/                两个语言共用的静态资源（示例、Schema、截图、_redirects）
  zh/  _nav.json  index.md（站点首页）  docs/…
  en/  _nav.json  index.md（站点首页）  docs/…
```

- 路径映射：`content/zh/docs/guides/installation.md` → `/docs/guides/installation`；`content/en/docs/…` → `/en/docs/…`。站点首页分别对应 `/` 与 `/en/`。
- **每个页面都必须在两个语言目录下同时存在，相对路径完全一致。** `docs:verify` 会比较两侧的页面集合，缺一篇即失败。两侧的 `_meta.json` 可以有不同的 label，但目录结构与侧栏顺序相同；`_nav.json` 里的链接按本语言写相对站点路径（`/docs/…`），Rspress 会自动加上 `/en` 前缀。
- 每页写 `title`、`description` 与一个 H1（与 `title` 相同），页面间用相对 `.md` 链接，公开下载与截图用 `__DOCS_BASE__/文件名`。Rspress `replaceRules` 为后者加部署 base，确保 HTML、单页 Markdown 与合并的 `llms-full.txt` 都可用；新增下载须列入精确 dead-link 例外，由 `docs:verify` 检查真实产物。导航由 `_nav.json` / `_meta.json` 维护，支持一层嵌套目录（`developer/http/`）。
- 产品名与文案：中文正文用「塑料碗」，英文正文用 "Surowan"；站点标题与描述按语言写在 `scripts/docs/locales.ts`，经 `public/build-info.json` 交给 `rspress.config.ts`、主题与 `docs:verify`，三处不会各写一份。
- 页面与 llms 共享完整 Git SHA；未提交修改明确标为本地预览（`VersionNotice`，中英文文案同样来自 `locales.ts`）。

## 生成页与生成器

`scripts/docs/prepare.ts` 是唯一入口，负责：

1. 从当前 `ConfigSchema` 生成两种语言的字段参考：`content/<lang>/docs/configuration/fields.md` 是侧栏里的索引（含标量顶层字段），每个有子字段的段生成一页 `fields-<段名>.md`（下划线换成连字符），不进侧栏、由索引链接，Bot 手册打包时紧跟在索引后面。分页是为了让每页都低于 Bot 读文档的单次上限 `DOC_READ_MAX_BYTES`，`test/manual-pack.test.ts` 会检查；某一段长到超限时再按其子段拆。prepare 会先删掉旧的分页，被移除的配置段不会残留。
2. `public/config.schema.json`、白名单示例副本与 `public/build-info.json`（提交、dirty、部署 base、两语言的站点文案）。
3. `public/_redirects`（见下节）。

旧版生成器把字段参考写在 `content/docs/reference/fields*.md`；从旧 commit 升级的 checkout 会留下这些未跟踪文件，prepare 会先删除它们（以及删空后的旧目录），避免这次的 `git status` 一直被标成 dirty。生成页由 `scripts/docs/generated-pages.ts` 的注册表声明：每个条目给一个「路径谓词」和 `render(lang)`，返回该语言的全部页面。新增一组生成页（例如接口目录）只加一个条目，prepare、Bot 手册与 `docs:verify` 自动覆盖。这些文件被 Git 忽略，不手改、不另存第二份 Schema。生成页关闭编辑链接与 Git 更新时间：2.0.22 的默认组件不识别这些 frontmatter 开关，主题以两个小包装落实，`docs:verify` 验证生成页隐藏且手写页仍有编辑链接。

Schema 字段表只描述类型与显式约束，不推导运行时默认值。字段、权限、热更新、迁移、用户可见行为改变时，同一变更更新相关手写指南和测试。

## 旧 URL 重定向

重组前的 `docs/` 路径已被删除，映射表在 `scripts/docs/redirects.ts`（设计文档 §6）。prepare 按当前 `DOCS_BASE_PATH` 把三种公开形式写成 `content/public/_redirects`（构建后位于 `dist/_redirects`，Cloudflare Workers 静态资源从资源根读取）：

- 无扩展名：`/docs/configure/telegram` → `/docs/guides/first-bot`
- `.html`：`/docs/configure/telegram.html` → `/docs/guides/first-bot.html`
- `.md`（供直接下载）：`/docs/configure/telegram.md` → `/docs/guides/first-bot.md`

只为中文（根路径）页面生成规则；英文页在重组前没有深链。配置段分页的规则由生成器枚举，新增段自动带重定向。`docs:verify` 逐条检查目标是本次构建真实产物，但**不验证 Cloudflare 上的实际跳转行为**；上线后仍需实测 `.html` 深链、`.md` 下载与 404。

## 截图约定

截图按场景 id 存放，同一场景两种语言各一张浅色、桌面尺寸的图：

```text
content/public/screenshots/<id>.<locale>.light.png
locale ∈ { zh-CN, en }
```

编写正文时先写占位注释（此时页面文字本身必须完整，不依赖图片）：

```md
<!-- screenshot: installation/sign-in-one-time-code | 服务器一次性码登录表单 -->
```

替换为图片时用公开资源前缀：

```md
![服务器一次性码登录表单](__DOCS_BASE__/screenshots/installation/sign-in-one-time-code.zh-CN.light.png)
```

这种写法已在 `DOCS_BASE_PATH=/` 与 `/surowan/` 两种构建下实测。生产只跑根路径构建，`replaceRules` 加 base 后 Rspress 能在 `content/public` 下找到文件，**根路径的原生 dead-image 检查保持开启**，缺图直接构建失败；只有用于子路径验证的构建（base 不是 `/`）无法在 `content/public` 下解析带 base 的路径，这时 `rspress.config.ts` 才对 `${base}screenshots/` 放行，改由 `docs:verify` 按渲染后的 `src` 在 `dist/` 里逐个核对。**不要**改写成相对路径（如 `../../../public/screenshots/…`）：Rspress 会把小图内联成 `data:` URL 写进页面 Markdown 与 `llms-full.txt`。

## 镜像内置的英文手册

`pnpm run manual:prepare`（Docker 构建自动执行）把 `content/en/docs/**/*.md`、按 `_meta.json` 顺序生成的英文配置字段分页与 `examples/` 打包到 `src/manual/`（gitignored），供 Bot 的 `list_documents`/`read_document` 能力按需读取。只打包 `en`：镜像不携带中文重复页，索引更短。打包顺序来自 `_meta.json`，嵌套目录（`developer/http/`）在它被列出的位置成为 `###` 小节；生成页按注册表补齐，配置字段分页紧跟索引、其余未被侧栏收录的生成页与侧栏外的手写页一起列在末尾的 "Other pages"，既不重复也不丢失。`__DOCS_BASE__/examples/` 下的下载示例被包成原文引用页（`examples/*.md`）并把链接改写到包内，`__DOCS_BASE__/screenshots/` 的图片变成 `(Screenshot: <alt>)` 文字，其他 `__DOCS_BASE__` 资源只保留链接文字；打包后残留占位符即失败。新增或移动页面只改正文与 `_meta.json`，下一次构建自动同步。

`.dockerignore` 只让 `content/en/docs` 与 `apps/docs/examples` 进入镜像构建上下文，中文正文、`content/public`、主题与站点配置都不进镜像。

## 示例

安全下载示例唯一源：`examples/`；Compose 模板例外，直接发布仓库根目录的 `docker-compose.yml`，与 README 共用一份。

- `config.minimal.example.jsonc`：能直接 `serve` 起管理面板、不含 Telegram 的最小配置。它必须**独立**通过真实 `loadConfig`（`test/docs/examples.test.ts`），不能只作为完整示例的片段被校验。
- `config.example.jsonc`：完整可运行示例，正文 JSONC 片段都合并进它再校验。
- `system-prompt.example.md`：人格 Prompt 示例。

完整配置与正文 JSONC 片段由真实 `loadConfig` 做离线校验，不解析 SecretRef 或使用真实密钥。

## 框架约束

- 仅保留轻量主题扩展，布局/导航/搜索/Markdown 使用 Rspress。`static-search-links` 针对 2.0.22 的 extensionless 搜索结果补上原生 `normalizeHref`。其本地搜索仅用 FlexSearch Document（不启用 worker/持久化），因此精确 alias 到同包 compact ESM 构建，避免完整版未使用的 worker fallback 把构建机路径带入 JS；不跳过泄漏检查。
- `patches/@rspress__core@2.0.22.patch` 修复默认搜索的全局 Enter 越界和空结果上下键取模：仅处理打开面板的搜索输入，有实际结果才导航。通过 pnpm 的 `patchedDependencies` 锁定并安装，不手改安装目录；`test/docs/search.test.ts` 执行已安装包的实际事件处理器。Docker 安装层也复制补丁，最终 runtime 不复制补丁或 docs。按钮补充 `:focus-visible` 边框。升级 Rspress/FlexSearch 后复查路由、compact alias、来源控件与键盘补丁的必要性，并运行生产浏览器验收。
- `route.localeRedirect: 'never'`：站点默认始终是中文，浏览器语言不触发自动跳转；语言切换仍由导航栏的语言菜单提供。
- 禁止把真实配置、密钥、SQLite、日志、`dev-data` 或 `agent-doc/design` 放进公开内容/资源。示例只用占位符与 SecretRef。截图只能由 Playwright 从真实面板自动截取，不制作假截图。

## 静态部署

`.github/workflows/docs.yml` 验证根路径与 `/surowan/`，仅上传静态检查 artifact；仅在 `main` 上构建 Bot 镜像验证站点依赖隔离，不负责发布。检查 artifact 中的 `docs.example.com` 是测试域名，不能直接当生产部署。

生产站点 `https://surowan.com` 由 Cloudflare Workers Builds 发布：连接本仓库的 `main` 分支，根目录 `/`，Worker 为纯静态资源（无脚本），配置见 [`wrangler.jsonc`](wrangler.jsonc)。缺失路径走 `404-page`（最近的 `404.html` + 404 状态），不使用 SPA fallback；`.html` 深链按默认 `auto-trailing-slash` 重定向到无扩展名路径；`_redirects` 提供旧 URL 跳转。Dashboard 中的构建设置：

- Build command：`pnpm run docs:build`
- Deploy command：`npx wrangler deploy --config apps/docs/wrangler.jsonc`（仓库根是 pnpm workspace，不指定配置时 Wrangler 拒绝在根目录自动探测）
- Build variables：`DOCS_SITE_ORIGIN=https://surowan.com`、`DOCS_BASE_PATH=/`

其他托管平台用干净、已提交的 checkout 显式设置：

```bash
DOCS_SITE_ORIGIN=https://your-docs-host.example DOCS_BASE_PATH=/ pnpm run docs:build
pnpm run docs:verify
```

PowerShell 请用 `$env:DOCS_SITE_ORIGIN` 和 `$env:DOCS_BASE_PATH`。origin 不带路径/凭据/查询；base 必须以 `/` 开头、结尾。子路径部署把 **`dist/` 的内容**挂载到该 base，不重复嵌套一层 base 目录。只上传 `dist/`，不要上传源码或 workspace。

选定主机后仍须实测 `.html` 深链、`.md`/`.txt`/`.json` 的内容与 MIME、缺失 `.md` 的 404 与 `_redirects` 的实际跳转；主机行为不由本地 preview 保证。不要开启把所有请求重写到 `index.html` 的 SPA catch-all。

真实 Docker 运行、Provider/Telegram、Doctor、迁移和恢复演练需要另行授权与隔离环境。离线示例测试和静态站检查不能代表这些链路通过。
