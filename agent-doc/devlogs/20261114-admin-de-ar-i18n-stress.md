# Surowan - 20261114 Admin Panel 德语与阿拉伯语：以国际化做设计系统压力测试

## 背景

Admin Panel 原来只有 `en` 与 `zh-CN`，`src/lib/i18n.ts` 不设置 `dir`，两处语言控件都写死成 `i18n.language === 'zh-CN' ? 'zh-CN' : 'en'`。德语、阿拉伯语都没有真实用户需求，这次加进来是当压力测试用：德语考验长复合词和文本膨胀，阿拉伯语考验真正的 RTL，以及 RTL 文本里夹着的 API key、模型 id、URL、时间戳等 LTR 技术串。目标是让 Koi 设计系统和面板不再依赖「文本很短」「方向永远是 LTR」这两个隐含假设，并且尽量在设计系统层修共性问题。

面板用的是 npm 上的 `@tuuject/koi-react@0.5.0`，DS 层的修复只能落在 design 仓库（tuuject/design PR #3：`DirectionProvider`、`Icon` 的 `mirrored`、Drawer `start`/`end`、浮层方向、可换行的 Button/Badge/Tag、`pnpm rtl-check`）。面板这边的约束是：不在 app 里绕过 Koi 组件的缺陷，en/zh-CN 的 LTR 不能回归，业务逻辑与 API 不变。

## 主要变更

### 1. 语言注册与方向

- `src/lib/i18n.ts:25` 的 `LANGUAGE_DIRECTIONS` 是唯一知道语言方向的地方；`applyDocumentLanguage`（`:80`）同步写 `<html lang dir>` 和标题，挂在 `languageChanged` 上（`:101`），切换语言不重载页面。存储键仍是 `admin-language`，浏览器语言 `de*`/`ar*`/`zh*` 映射到对应语言。
- `src/components/app-direction.tsx:22` 用 Koi 的 `DirectionProvider` 包住整个应用，方向由当前语言推导，浮层定位和方向键跟着走。
- 头部语言控件从两态切换改成 Koi `Menu`，列出四种语言（各用本语言名称），当前语言打勾，可访问名称不变。

### 2. 翻译与目录约束

- 新增 `src/locales/de-DE/**` 与 `src/locales/ar/**`，逐键镜像 en。德语用正式的无人称写法，阿语用 MSA，技术标识与品牌名不译。
- `src/locales/catalog.ts:53` 的 `Catalog<T>` 与 `:60` 的 `CompleteCatalog<T>`：键漂移仍然在 `tsc` 报错。阿语必须给每个复数族提供六种 CLDR 形式，包括 en 里只写 `{{count}}`、不带 `_one/_other` 后缀的键。i18next 会先找 `key_<category>`，所以 en 原文不用改。手动挑 one/many 的三对键（`oneModel`/`manyModels` 等），阿语改用「标签 + 数字」的中性写法。
- `src/locales/catalog.test.ts` 检查键集、插值变量、`<time>` 标签在四种语言之间一致；按各语言的 `Intl.PluralRules`，对 0/1/2/3/11/100 断言取到的正是对应形式。另有两个源码扫描：一个禁止对带标签的键用 `t()`，一个禁止给 `count` 传字符串（i18next 遇到字符串 count 不做复数选择）。
- 为满足 pre-commit 的单文件体积上限，四种语言的 `models` 都拆成 `src/locales/<lang>/models/` 目录。拆分前后把键值拍平比对，没有任何差异。

### 3. 双向文本

- `src/components/business/bidi-text.tsx:25` 的 `TechText` 渲染 `<bdi dir="ltr">`；`time-text.tsx` 的 `TimeText` 把 `formatTime` 的结果包进 `TechText`，约 90 处时间戳都换成了它。
- 句子里嵌的时间戳用 `Trans` + `components={{ time: <TechText /> }}` 渲染，四种语言的文案写成 `<time>{{time}}</time>`。最初的实现在文本里插 FSI/PDI 控制字符，复制时会带出去，已经删掉。
- 技术输入框用 `dir="ltr"`，自由文本用 `dir="auto"`。CodeMirror 提示词编辑器启用了 `perLineTextDirection`。图表只把刻度和轨道设成 LTR 区域，说明文字在区域之外。

### 4. 布局与图标

- 图标统一走 Koi 的 `mirrored`（`src/components/icons.tsx:52`）；展开用的 chevron 在 RTL 下要反向旋转，见 `disclosureChevronClass`（`:70`）。移动端导航 Drawer 改为 `side="start"`。
- 表头允许换行，并开启 `hyphens: auto`（`src/components/business/table-shell.tsx:89`），德语表头按音节断开。曾经为了德语表头加宽固定列宽，结果和 develop 比对发现 en/zh-CN 回归了：1440 宽下 invocations 的 Created 列和 group memory 的 Actions 列被截断，手机端 contexts 的群名被挤成「Suro…」。这些加宽已经全部退回 develop 的值，只保留英文本身就需要的四处：sticker index state 120、API key name 116、invocation sends 80、memory status 120。
- 第一版曾给每个表格单元格加 `unicode-bidi: plaintext`，结果 RTL 表格里的徽章、数字、时间戳按各自段落方向靠左，和表头对不齐，已移除。现在由 e2e 断言列对齐。

### 5. 验证资产

压力套件拆成 `e2e/33-i18n-stress-{layout,rtl,bidi}.e2e.ts`，共享逻辑放在 `e2e/i18n-stress-helpers.ts`，共 16 个用例：

- de-DE/ar × 1440/820/390 × 27 个路由：无横向溢出、控件文字不溢出，并把截图写到 `<tmpdir>/surowan-admin-e2e-results/i18n-stress/`
- RTL 文档与侧边栏、列对齐、Koi 控件镜像（Drawer、Pagination、Breadcrumb、Switch）、浮层在视口内
- 语言菜单切换不重载页面、刷新后保持
- 技术串隔离与输入框方向、`<time>` 标签不外泄、活跃时段图表的星期标签不压到轨道

## 实施与审阅

- 实现：Pi（`magpie/opencode-go/deepseek-v4.1-flash`），经 T3 线程派发。Koi 侧另开一个线程。
- 审阅：两轮 ocr（22 条 + 7 条），主会话逐条回代码核实。成立的都打回同一线程修复；一条误报（invocations 状态列宽）没有改。主会话又补了截图审查和 develop 像素比对，因此多了两轮：
  - 修表格对齐和 FSI/PDI 的问题
  - 退回加宽的列宽
- 主会话亲手改的：invocations sends 列 72→80（英文「Sends」原本会被断成「Send/s」）、memories status 列 104→120（「short-term」原本会变成两行胶囊），以及把 tarball 联调接线换成 `0.6.0` 版本号。

## 验证

主会话在 worktree 里亲自跑，依赖为 design PR #3 打出的 Koi tarball：

```bash
pnpm run lint                      # 0
pnpm run check                     # 0
pnpm run admin:build               # 0
pnpm test                          # 387 files / 1915 tests passed
pnpm run admin:test:e2e            # 321 passed（develop 305 + 新增 16）
pnpm --filter surowan-admin-next exec playwright test 33-i18n-stress --repeat-each 5 --workers=4
                                   # 80 passed（拆分前）；拆分后 33-i18n-stress --list = 16 tests in 3 files
git diff --cached --check          # clean
# rebase 到 origin/develop 后：21-telegram 24-i18n 33-i18n-stress → 29 passed
```

LTR 回归比对：同一个临时 Playwright spec，分别在 `origin/develop`（31942331）和本分支上，各拍 en/zh-CN × 1440/390 × 27 个路由，共 108 张，再用 `magick compare -metric AE` 逐张比对：

- 61 张完全一致。
- 其余全部归了类：原来被省略号截掉的表头现在完整换行显示（页面高 20px）、徽章完整显示、Koi 文案按音节断字、时间戳与随机 config hash 的噪声。
- 1440 宽下没有出现 develop 没有的表格横向滚动。

截图都看过：阿语 overview、invocations、chats，德语手机 harness。

Koi 0.6.0 发布后（design PR #3 合并，`v0.6.0` 与审过的 head 相比只多了版本号），把 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 加上 0.6.0（与以往升 Koi 的做法一致），重新生成 lockfile，用 npm 上的真包重跑：

```bash
pnpm install --frozen-lockfile     # lockfile up to date
pnpm run lint                      # 0
pnpm run check                     # 0
pnpm run admin:build               # 0
pnpm test                          # 第一次 1 failed：test/playground/only.test.ts 在全量负载下读到 attempt 仍是 running
                                   # 单独跑 3 次都过，再跑全量 387 files / 1915 tests passed；本分支没有改后端
pnpm run admin:test:e2e            # 321 passed
pnpm --filter surowan-admin-next exec playwright test 33-i18n-stress --repeat-each 5 --workers=4
                                   # 80 passed
```

未执行：

- 只在 Chromium 跑过，没有测 Safari/Firefox（`:dir()`、德语断字词典）。
- CodeMirror 里实际输入阿拉伯文没有自动化覆盖。
- Invocation/消息/Memo 等详情页没有逐页截图。
- 没有真实的阿语或德语用户做验收。

## 提交

```txt
9858f952 Add German and Arabic to the admin panel with RTL and bidi support
38440bf8 Install Koi 0.6.0 from npm
```
