# Surowan - 20261124 web_fetch 返回 Defuddle 解析的页面元数据

## 背景

运营者在 Admin Panel 审阅 Invocation 11466 时发现：群友贴了一条 X 推文链接，Bot 用 `web_fetch` 读了页面，却看不到推文配图。

- 前一轮 Invocation 11465 用默认的 Markdown 模式抓这条推文，结果只有 1.9 KB 正文和 4 张头像 `_normal.jpg`，没有配图链接，Header 里也只有 `Title:`。模型只能凭文字回复。
- 被用户截图指出后，11466 里的模型改用 `raw: true` 重抓，自己在 `<head>` 里翻到 `og:image`，再用 `web_fetch` 打开图片，成功拿到 2048×1536 的配图。看图通道本身没问题，缺的是图片链接。

在本地用同一 URL、同一组 Defuddle 参数复现后，发现：

- X 免登录页面的 body 里其实有配图 `<img alt="" …>`，但这套页面结构里没有任何 `data-testid`。Defuddle 的 TwitterExtractor 靠 `article[data-testid="tweet"]` 定位推文，所以没有命中，页面走了通用正文抽取，配图在这一步被丢掉了（排除了 `inert` 和空 `alt` 两种可能，具体是哪条规则删掉的没有继续追）。
- Defuddle 其实已经把 `og:image` 解析进了 `result.image`，`description`、`published`、`site` 等字段也都有值。但 `src/plugins/web-fetch/content.ts` 的 `htmlToMarkdown` 只取了 `title` 和 `content`，其余元数据全部被丢弃。

运营者的思路是：把元数据单独列出来，下面再放 Markdown。用户随后要求把 Defuddle 解析出来的元数据完整地返回给模型，而不是只挑几个字段。

## 主要变更

### 1. Header 逐行列出 Defuddle 元数据

`htmlToMarkdown`（`src/plugins/web-fetch/content.ts:66`）改为返回 `ConvertedPage`：`markdown`、`metadataLines`（每个字段一行 `Label: value`，空字段省略），以及 `previewImage`。字段覆盖 `DefuddleMetadata` 的全部内容，只有 `parseTime` 例外：它是本进程的解析耗时，不是页面元数据，而且会让同一页面两次抓取的审计文本不一样。

```ts
const fields: readonly (readonly [label: string, value: string])[] = [
  ['Title', oneLine(result.title, TITLE_MAX_CHARS)],
  ['Description', oneLine(result.description, DESCRIPTION_MAX_CHARS)],
  ['Author', oneLine(result.author, FIELD_MAX_CHARS)],
  // ...
  ['Preview image', previewImage ?? ''],
  ['Favicon', fetchableUrl(result.favicon, url) ?? ''],
  ['Schema.org', schemaOrgJson(result.schemaOrgData)],
];
```

`web-fetch.ts` 把这些行接在 `Format:` 之后、Markdown 之前，所以它们和正文一起计入 32 KiB 的结果预算（`bodyBudget`）。

### 2. 页面控制的字段如何约束

这些值都来自页面本身，所以分别做了约束：

- **文本字段**：空白与 U+0085 折叠成单个空格，再按字段截断（标题 300、描述 1000、其余 200 字符）。否则页面可以在 `og:description` 里塞换行，伪造出 `Format:`、`Status:` 这样的 Header 行。
- **`Preview image` 与 `Favicon`**：Defuddle 不会把相对路径转成绝对 URL，所以按页面 URL 解析成绝对地址，并去掉 fragment。之后必须通过 `web_fetch` 自己的 `parseUrl`（为此从 `transport.ts` 导出）：要求 HTTP(S)、默认端口、不带凭据，并且长度不超过 2048 字符。不满足就省略，保证模型拿到的链接都能原样交回 `web_fetch`。
- **`Schema.org`**：去掉空的 JSON-LD 块后输出紧凑 JSON，并转义 `JSON.stringify` 不会处理的 U+0085、U+2028、U+2029。超过 4 KiB 时截断，末尾加 ` [truncated]`。不少站点会把整篇 `articleBody` 放进 JSON-LD，不截断就会把正文挤出预算。

### 3. 看图提示覆盖预览图

能看图时，`Images:` 提示原本只在 Markdown 里有 `![](http…)` 时才出现。现在有预览图也会出现，措辞按实际情况组合，比如 `Images: linked as ![alt](url) or listed as Preview image; …`。Tool 描述、`src/plugins/web-fetch/skills/web-fetch/SKILL.md`、`agent-doc/telegram-agent-flow.md` 的 `web_fetch` 一节，以及用户指南 `apps/docs/content/docs/guides/extensions.md` 都同步说明了元数据行和预览图。SKILL.md 还加了一句提醒：在下结论说页面没有图片之前，先看看 `Preview image`。

## 验证

先写下可能出错的情况（正文丢图、相对或不可抓取的链接、换行伪造 Header、超长元数据挤占预算、空字段噪音、缺少看图提示、`parseTime` 带来的不确定性、JSON 里的行分隔符），再写测试：

- `test/web-fetch/content.test.ts:82`：逐行断言字段的顺序和内容；断言伪造的 `Format:`/`Status:` 仍留在 `Description` 一行里；断言 U+2028 已转义、元数据位于正文之前、审计 `result_text` 和返回文本一致；同一页面抓两次，文本完全相同。
- `test/web-fetch/content.test.ts:130`：5000 字符的描述被截到 1000 字符，带 20000 个「碗」的 JSON-LD 截到 4 KiB 并带上 ` [truncated]`，正文仍然保留。
- `test/web-fetch/images.test.ts:64`：模拟 X 推文页，正文里没有图片链接、只有 `og:image`。断言出现 `Preview image:` 和 `Images: listed as Preview image` 两行，再用这个链接加上 `referer` 调用 `web_fetch`，拿回 80×60 的工具图片。
- `test/web-fetch/images.test.ts:111`：`og:image` 依次换成 `javascript:`、`data:`、`ftp:`、带凭据、非默认端口和超长 URL 六种情况，同时 `javascript:` favicon、只有空白的 author、空 JSON-LD 都不应输出对应行。

在实现之前，前三条新测试都失败了，第四条因为当时根本没有输出元数据而本来就是通过的。

把运营者那条推文的真实页面保存到本地后，用新代码离线跑了一遍：输出包含 `Preview image: https://pbs.twimg.com/media/HX4yWjcaAAATyeE?format=webp&name=large`，`Images:` 提示里也出现了 `listed as Preview image`。

```bash
git diff --check                                         # 通过
pnpm run lint                                            # 先由 lint:fix 修正一处测试格式，之后退出码 0
pnpm run check                                           # 退出码 0
node scripts/file-token-limit.ts                         # 退出码 0
pnpm vitest run test/web-fetch                           # 20 passed
pnpm test                                                # 483 files / 2493 tests 全部通过
DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify          # 55 页、179 个 HTTP 资源校验通过
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify  # 同上；构建后 git status 只剩本次改动
```

未执行：在线 Bot 上的真实 Telegram 验收，以及用新的 Tool 描述重放 Invocation 11465（重放会真实调用模型）。

## 提交

```txt
f5c87ed2 Return page metadata from web_fetch HTML conversion
```
