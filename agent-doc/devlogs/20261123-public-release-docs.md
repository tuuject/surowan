# Surowan - 20261123 Public Release 文档重组：中英双语、三分类与 Playwright 双语截图

## 背景

`agent-doc/design/20261106 Public Release 文档重组调研与规划.md` 调研了公开文档的问题：文档站只有中文；新手主线围绕「手改完整配置」；任务说明和精确参考混在一页里；多处说明已经和源码脱节（API key 不能改配置、删除 Chat 要重启、首次运行必须配 Vision 等）；2026-11-06 之后合入的十多项功能没有写进文档；也没有任何真实截图。规划要求：

- 保留「指南」「配置文件参考」「开发者参考」三个顶层分类；
- 简体中文走默认根路径，English 挂在 `/en/`；
- Bot 镜像内置手册只打包英文；
- 截图由 Playwright 从真实面板截取 `zh-CN` 与 `en` 两套。

用户要求按该规划实施：拆成 epic，由 T3 委派子 agent 并行开发。所有子任务都用 agent Pi、模型 `opencode-go/deepseek-v4.1-flash`（catalog id `magpie/opencode-go/deepseek-v4.1-flash`）、`thinking: max`；主会话只负责派发、审阅、复验和集成。第 10 节的待确认项按推荐选项实施，在 PR review 中由维护者确认。各 epic 的共享契约（页面清单与中英标题、写作约定、截图场景 id、旧 URL 映射）见 `agent-doc/design/20261123 Public Release 文档重组实施拆分.md`。

## 主要变更

### 1. 双语骨架与工具链（Epic A）

- **站点结构**：`apps/docs/content/` 拆成 `zh/` 与 `en/` 两棵相同的页面树，加上共享的 `public/`。`apps/docs/rspress.config.ts` 用 `lang: 'zh'` 加两种 locale，并设 `localeRedirect: 'never'`。两种语言各有自己的 llms 文案、搜索索引和来源提示。来源提示的句子只在 `scripts/docs/locales.ts` 的 `provenanceText` 里生成一处。
- **生成页注册表**：生成页统一登记在 `scripts/docs/generated-pages.ts`，prepare、手册打包和 verify 都读这一份。
- **旧 URL 重定向**：`scripts/docs/redirects.ts` 生成 Cloudflare `_redirects`，把旧路径的无扩展名、`.html`、`.md` 三种形式都映射到新页面。旧字段分页的 slug 以 `86db554f` 为准冻结，配置段以后改名或删除也不会丢旧链接。
- **内置手册**：`scripts/manual-prepare.ts` 只从 `content/en/docs` 打包，支持嵌套导航（`developer/http/`），在原位置渲染为子小节。注册表里有、导航没列出的生成页放进「Other pages」。`.dockerignore` 排除 `content/zh` 和本地残留的 `src/manual`。
- **docs:verify**：`scripts/docs/verify.ts` 对两种语言逐页检查 frontmatter、唯一 H1、来源句子正好出现一次、中英页面集合一致、搜索索引的内容、中英页面不互相链接、重定向目标存在、缺失的 `.md` 返回 404；并核对环境变量 `DOCS_BASE_PATH` 和 `DOCS_SITE_ORIGIN` 与构建产物一致。
- **最小示例**：新增 `apps/docs/examples/config.minimal.example.jsonc`，不配 Telegram 也能启动 `serve`，用真实 `loadConfig` 单独校验。

### 2. Playwright 双语截图流水线（Epic B1、B2）

- **独立入口**：`apps/admin-next/playwright.docs.config.ts` 与 `docs-screenshots/*.shot.ts`，入口命令是 `pnpm run docs:screenshots`。复用 e2e 的真实 AdminServer、临时 SQLite 和 Faux/回环 fixture。分 `zh-CN` 与 `en` 两个 project，固定 1440×1000、DPR 1、浅色主题、UTC、`reducedMotion`。
- **本地化种子**：`E2E_SEED_LOCALE` 选择对应语言的合成数据（`e2e/docs-locale*.ts`、`e2e/server-docs*.ts`）。失败运行和工具运行这类数据只对需要它的 spec 文件灌入；服务端发出的非回环请求一律拒绝；默认 e2e 不受影响。
- **发布流程**：截图先写进 staging 目录，必须全部测试通过、并按场景目录用 `scripts/docs/screenshot-assets.ts` 校验（TypeBox manifest、sharp 解码、中英成对、无孤图）之后，才替换 `apps/docs/content/public/screenshots/`。
- **产物**：39 个场景 × 2 种语言，共 78 张 PNG 加 `manifest.json`。另有手动触发的 `.github/workflows/docs-screenshots.yml`，在 Linux 上重新生成并上传 artifact。
- **顺带修复**：`apps/admin-next/src/pages/keychain.tsx` 的操作列加宽并禁止断词，英文的「Rotate/Delete」不再被拆开。

### 3. 指南（Epic C、D1、D2）

`content/{zh,en}/docs/guides/` 下 15 篇，加上两个首页和文档入口页：

- **新手主线**：安装与首次登录（Compose、一次性码、补设密码、接入可运行的模型）→ 第一个人设（在虚拟群聊试聊）→ 第一只 Bot（Telegram）。
- **调优与群边界**：入场闸门先 `shadow` 再 `enforce`、自适应消息批次、批改导出、Resume、`ask_only`、每群 MCP 绑定。
- **其余专题**：本地 Agent 协助、模型、Playground、知识、图片、工具、面板与密钥、维护、排障。

每条事实都对照了源码；设计文档 §2.2 列出的漂移已全部更正。

### 4. 配置文件参考与字段生成器（Epic E1、E2）

- **生成器**：字段生成器移到 `scripts/docs/config-fields/`，新增：
  - 遍历 `anyOf` 数组分支；
  - 渲染 Schema 实际用到的全部关键字，以及 `patternProperties` 的键名正则；
  - 区分「Schema 声明默认」和「运行时默认」。运行时默认直接从解析代码的常量导入；对必填字段，标明在哪个上级段缺省时才生效；
  - 在各段分页标出废弃字段及迁移说明。
- **源码改动**：为此在 `src/platform/config/resolve.ts` 新增 `BUCKET_TIMING_DEFAULTS`，行为不变。
- **生命周期测试**：`test/docs/lifecycle.test.ts` 用真实 `diffConfig` 逐行校验文档里的热应用/重启矩阵。
- **手写页**：17 篇，覆盖配置入门、生命周期、密钥、Telegram、Provider、models_dev、Agent、Vision、Tool Model、图片、辞典、搜索、网页读取、MCP、Admin、调试记录、数据与保留。

### 5. 开发者参考与接口目录（Epic F1、F2）

- **接口目录生成器**：`scripts/docs/interface-catalog/` 从 `ADMIN_SURFACE_SPECS`、`PANEL_SPECS` 和 MCP Server 自己的 tool/spec 对应关系生成以下目录：
  - HTTP 端点：5 页；
  - MCP 工具：160 个；
  - CLI 命令：146 条。
- **Session-only 路由**：靠「方法 + 路径」的源码锚点和路由实现绑定，并标出凭据类型。
- **源码改动**：`src/ingress/admin/mcp/tools.ts` 公开 `ToolCatalog.entries`，行为不变，这样共用同一路由的 `telegram token` 和 `telegram token clear` 不会被标错。
- **手写页**：12 篇，覆盖接口选择、HTTP 公共约定（会话、API key、Ed25519 配对签名、权限模式、分页、revision、错误码）、审计、配置、数据、Playground 与图片、MCP Server、两套 CLI、重放、Telegram 命令、扩展与 IM 宿主边界。

### 6. 收尾（Epic G）

- **截图入页**：88 处截图占位换成真图，有 4 处 alt 与画面不符，已改正。
- **截图检查**：`scripts/docs/screenshot-references.ts` 用 CommonMark 解析（新增 devDependency `mdast-util-from-markdown@2.0.3`，锁文件里本来就有这个版本，作为 Rspress 的依赖），检查：
  - 每种语言只能引用对应语言的截图；
  - 每个截图场景在两种语言里都至少被引用一次；
  - 没有遗留占位符，也没有 `<img>` 写法；
  - `dist/screenshots` 与源文件逐字节一致。
- **手册打包修复**：`scripts/docs/manual-links.ts` 改为按解析结果改写链接和图片，代码块与行内代码不再被改写。
- **产品知识索引**：`src/platform/prompts/2-product-knowledge.md` 按英文手册重新整理，更正旧事实，补上新功能。
- **其余**：补齐跨页链接；站点文案统一为「塑料碗 Harness（Surowan Harness）」；同步 `apps/docs/README.md`、`agent-doc/operations.md`、`agent-doc/verification.md`、`AGENTS.md`；`docs.yml` 改为逐个运行 `test/docs/*.test.ts`。

### 7. 审阅与修正

- **ocr 审阅（只跑首轮）**：A、B1、B2、E1、F1、G 的代码部分各跑了一轮。修正轮均未再跑 AI 审阅。核实后成立并打回修正的条数：

  | Epic | 成立并修正 |
  | --- | --- |
  | A | 13 |
  | B1 | 12 |
  | B2 | 18 组 |
  | E1 | 7 |
  | F1 | 14 |
  | G | 3 组 |

  误报都写进了各修正轮的「不要改」，例如 `{{ bot.name }}` 在 `.md` 中按字面渲染、「是非问句」的用词。
- **纯 Markdown 的 epic**：ocr 不支持 `.md`（`unsupported_ext`），由主会话做中英结构对齐脚本检查，并对照源码抽查事实。顺手修了两处：
  - D2 的英文页缺一个截图占位；
  - C 的 first-bot 没说明新部署怎样拿到自己的 Telegram 数字 ID。
- **集成冲突**：E1 与 F1 在 `scripts/docs/generated-pages.ts`、`test/manual-pack.test.ts` 上冲突，主会话手动合并：保留 E1 的导入路径，加上 F1 的注册项。

### 8. 写文档时发现的疑似产品问题（未修改代码，文档按现状描述）

- **图片**：
  - 工作台选「Default（唯一模型）」时请求不带 `model_id`，`POST /api/image/generations` 和 `/resolve` 会拒绝；
  - 一个坏的图片凭据或不合法的图片模型会让面板上任何一次配置应用都失败，而启动时只会禁用生图；
  - `image.capabilities.maxOutputs` 允许 10，`image_generate.output_count` 却最多 4；
  - 图片相关 Admin 路由的错误信息只有中文。
- **MCP**：
  - 显式的 `mcp.servers[].tools` 列表要求每个工具都写 `tool_policies`，每群绑定却接受服务器的 `default_tool_policy`；
  - `follow_redirects` 必须显式写 `false`；
  - `required` 只在 Schema 注释里写了已废弃，没有 `deprecated: true` 标记。
- **配置分类**：`web_fetch.*` 与 `retention.warning_read_days` 都是运行时实时读取，却被归为需要重启。
- **权限**：AGENTS.md 说读取 Memo Blob 需要面板 Session，但 `/api/memories/blobs/:id` 在共享 dispatch 里，有读权限的 API key 也能取。
- **机器人命令**：回复只有中文；`/ask` 前缀会原样进入模型上下文。
- **诊断与引导**：
  - `doctor` 遇到没有文本模型的 Provider 会静默跳过；
  - 删除被 `tool_model` 引用的 Provider 时不会先报「使用中」；
  - 放行任何会话前，产品没法显示用户或会话的 ID。
- **面板**：
  - 入场闸门的判断记录没有面板列表；
  - 每群 `timezone` 只能改文件后重启；
  - 删除 Chat 时可能在配置已写出之后才返回 `chat_still_authorized`。
- **界面细节**：英文界面里的 U+2019 显示有空隙；中文的「续跑」按钮折成两行；英文图片模型表的「Remove」被断词。

## 验证

主会话在集成分支 `5dee84f7`（Windows 11）上亲自运行：

```bash
pnpm install --frozen-lockfile                  # pass
git diff --check 86db554f..HEAD                 # pass
pnpm run lint                                   # pass
pnpm run check                                  # pass（tsc、cli、admin-next、docs prepare + tsc）
DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
# Verified 138 HTML/Markdown pages in two locales, 39 screenshots (90 page references), search, examples, schema,
# provenance, redirects and 508 HTTP resources (base /).
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify   # 同上，base /surowan/
pnpm test
# Test Files 2 failed | 488 passed | 1 skipped (491); Tests 9 failed | 2578 passed | 9 skipped (2596)
# 失败只在 test/admin/live-invocations.test.ts、test/admin/live-invocations-lifecycle.test.ts，
# 这两项在 base 86db554f 上同样失败（hook 超时）
pnpm run admin:build && pnpm run admin:test:e2e
# 385 passed, 1 failed：09-chats「remove confirmation…」，Windows EPERM 改名竞态；单独重跑 3/3 通过
```

其他由主会话运行的检查：

- **镜像构建上下文模拟**：按 `.dockerignore` 移走被排除的路径后运行 `node scripts/manual-prepare.ts`，打包出 71 篇，索引首行是 `# Surowan User Manual`。
- **截图流水线**：
  - B1 合入前：`pnpm run docs:screenshots` 发布 30 张，`admin:test:e2e` 386/386 通过；
  - B2 合入前：发布 78 张，`admin:test:e2e` 384 通过、2 失败（`09-chats-active-hours` 在 develop 基线上同样失败，`10-developer` 单独重跑 2/2 通过）；
  - `09-chats-active-hours` 在当天早些时候通过、晚些时候在 develop 上也失败，看起来与当前时间有关。
- **基线对照**：在 base `86db554f` 的主 checkout 上跑 `pnpm test`，17 个文件失败，原因是主 checkout 的 `packages/image-service/dist` 过期；重新构建后剩下的只有 live-invocations 两项。

子 agent 自报、主会话没有逐项复跑的：各 epic 的 fail-first 测试确认，B2 的「失败运行不发布」证明，F1 的逐条回退验证，G 的 dist 截图篡改实验。

未执行：

- 真实 Telegram、Provider、MCP 与 Docker 镜像构建验收；
- Cloudflare `_redirects` 的线上跳转、`.html` 深链与 `.md` 下载的部署后 smoke；
- product-knowledge skill 要求的 5 个模型 grounding 探针；
- Linux CI 上重新生成截图：当前提交的截图在 Windows Chromium 上生成，字体渲染与 Linux 不同。

## 提交

```txt
a8bb5993 Restructure the docs site into a bilingual zh/en skeleton
c3b15dc8 Add Playwright pipeline for bilingual docs screenshots
dc1218b5 Write the remaining configuration reference pages in zh and en
0cd92dd6 Write the knowledge, images, tools and maintenance guides in zh and en
f4ac879d Write the MCP server, CLI, replay, command and extension references
77e513dc Write the tuning, chat-boundary, agent-assisted and troubleshooting guides
7865cba4 Write the onboarding guides and home pages in zh and en
a6617c81 Enrich the config field reference and write the core config pages
0d1083ab Generate interface catalogs and write the developer HTTP reference
6ea8d8ec Add the remaining 24 bilingual docs screenshot scenarios
5dee84f7 Close out the bilingual docs: screenshots, checks and product knowledge
4f729720 Record the Public Release docs implementation split
```
