# Surowan - 20261127 web_fetch 支持非 UTF-8 编码网页

## 背景

`web_fetch` 的 `readTextBody` 只会用严格 UTF-8 解码响应体，不是合法 UTF-8 就报 `invalid_text_encoding`（`Response is not valid UTF-8`）。GBK、Big5、Shift_JIS、EUC-KR、windows-1251 之类的旧网页和 RSS 因此一律读不了，哪怕响应头或页面里已经写明了编码。

截断时，旧实现依次少读 0–3 个字节反复尝试 UTF-8 解码，用来丢掉读取上限切开的半个字符；这个办法只适用于 UTF-8。

动手前先列出可能的失败方式，测试按这份清单写：

1. 响应头的 `charset=GBK` 被忽略，结果是乱码或直接报错。
2. 只写在 `<meta charset>` / `http-equiv` 里的编码被忽略；注释里或其它标签属性里的假 meta 被误认。
3. 优先级错误：应为 BOM > 响应头 > 文档内声明。
4. 标签别名（`gb2312`、`cp1251`、带引号的值）没有归一；未知标签抛出 RangeError，最后变成 `network_error`。
5. meta 里写 `utf-16` 的页面必须按 UTF-8 读。
6. RSS/XML 的 `<?xml encoding?>` 被忽略。
7. 截断切在多字节字符中间，尾部出现 `�` 或整页报错。
8. 旧编码转成 UTF-8 后变长，结果超过 32 KiB 预算。
9. 声明了编码的页面里有个别坏字节，整页失败。
10. 未声明编码的二进制或非 UTF-8 内容仍要拒绝（回归保护）。

## 主要变更

### 1. 按浏览器的顺序选编码

新增 `src/plugins/web-fetch/charset.ts`，`textEncodingOf`（`src/plugins/web-fetch/charset.ts:25`）依次看：

- BOM（UTF-8 / UTF-16LE / UTF-16BE）；
- `Content-Type` 的 `charset` 参数，值可以带引号；
- 文档自己的声明：`text/html` 走 HTML 规范的 meta 预扫描（`metaCharset`，`src/plugins/web-fetch/charset.ts:94`，实现了 get an attribute、注释跳过、其它标签属性跳过、`http-equiv` + `content` 的 pragma 规则），XML 类型（`application/xml`、`text/xml`、`+xml`）读开头的 XML 声明。

标签交给 `new TextDecoder(label).encoding` 按 WHATWG 别名表解析；构造失败（未知标签，以及 Node 不支持的 ISO-2022-KR、HZ-GB-2312 这类 replacement 标签）就跳过，交给下一层。文档内声明为 UTF-16 时改按 UTF-8，`x-user-defined` 改按 windows-1252，与浏览器一致（`documentEncoding`，`src/plugins/web-fetch/charset.ts:48`）。

规范建议预扫描 1024 字节，这里扫 4 KiB（`src/plugins/web-fetch/charset.ts:12`）：浏览器找不到声明时还能按字节频率猜，本 Tool 不猜，漏掉放在长标题或关键词列表后面的声明就整页失败。

### 2. 声明了就宽松解码，没声明仍然严格

`readTextBody`（`src/plugins/web-fetch/transport.ts:171`）：

```ts
const { encoding, declared } = textEncodingOf(bytes, response.headers.get('content-type'));
try {
  // ...
  const text = new TextDecoder(encoding, { fatal: !declared }).decode(bytes, { stream: truncated });
  return { text, truncated };
} catch {
  throw new WebFetchError('invalid_text_encoding', 'Response is not valid UTF-8 and declares no charset');
}
```

- 声明了编码（包括声明为 UTF-8）的响应像浏览器一样，坏字节变成 U+FFFD，不再整页失败。
- 什么都没声明时仍要求严格 UTF-8，失败码不变，挡住无 `Content-Type` 的二进制内容，也不猜编码。
- 截断时用 `stream: true` 解码，被切开的半个字符留在解码器里丢掉，替代原来只对 UTF-8 有效的「少读 0–3 字节重试」，对 GBK、Shift_JIS、UTF-16 同样成立。

### 3. 解码后再按结果预算截断

`readTextBody` 的上限按线上字节计。旧编码换成 UTF-8 会变长（windows-1252 的 `€` 1→3 字节，GBK 汉字 2→3 字节），所以不做 Markdown 转换的路径（`raw`、纯文本、JSON、站点 Markdown）在解码后再用 `truncateUtf8` 截一次（`src/plugins/web-fetch/web-fetch.ts:186`）。HTML 转换路径不需要：解码后的 JS 字符串长度不会超过原始字节数，2 MiB 上限对同步解析的约束不变。

### 4. 文档

- `agent-doc/telegram-agent-flow.md` 的 `web_fetch` 一节补了编码选择、宽松/严格规则与截断。
- `agent-doc/verification.md` 测试表新增 `web-fetch/charset.test.ts`。
- `apps/docs/content/{zh,en}/docs/configuration/web-fetch.md` 的「始终生效的边界」各加一条：写明编码的非 UTF-8 网页可以读，未写明且不是 UTF-8 的报 `invalid_text_encoding`。

## 验证

新测试 `test/web-fetch/charset.test.ts` 共 8 条，按上面的失败清单写，旧编码文本按字节写死（Node 只能解码这些编码，不能编码）。实现前先跑，8 条全部失败。实现后：

```bash
pnpm vitest run test/web-fetch/
# 29 passed
```

逐个注入变异，确认测试能抓到（每次都恢复原文件）：

| 变异 | 失败的测试 |
| --- | --- |
| `stream: false` | 读取上限切开的半个字符 |
| 去掉解码后的 UTF-8 截断 | 结果预算 |
| 预扫描改回 1024 字节 | meta 声明 |
| 不识别 `<!--` 注释 | meta 声明（最初没抓到：注释里没有 `>` 时 `<!` 分支本来就会跳过整段；诱饵改成注释里先出现 `>`） |
| 不跳过其它标签的属性 | meta 声明 |
| `content` 不要求 `http-equiv` pragma | meta 声明 |
| 不把 meta 里的 utf-16 换成 UTF-8 | meta 声明 |
| 一律宽松解码 | 未声明且非 UTF-8 仍拒绝 |
| 文档声明优先于响应头 | BOM / 响应头 / 页面优先级 |

```bash
pnpm run lint            # exit 0
pnpm run check           # 通过
git diff --check         # 通过
pnpm test                # 495 files, 2626 passed
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两遍都通过（148 页、两种语言）；构建前后 git status --porcelain 相同
for f in test/docs/*.test.ts; do pnpm test "$f"; done   # 全部通过
```

临时脚本（未提交）用 `createWebFetchTool` 加 `allowProxySyntheticAddresses: true`（本机是 fake-IP 代理）直接抓真实站点，`raw: true`：

```txt
https://abehiroshi.la.coocan.jp/top.htm  Content-Type: text/html（无 charset，靠 meta 认出 Shift_JIS）  title: 阿部 寛のホームページ  U+FFFD 0
https://www.newsmth.net/                 Content-Type: text/html;charset=GBK                          title: 水木社区-源于清华的高知社群  U+FFFD 0
http://www.ruanyifeng.com/               Content-Type: text/html（UTF-8）                              title: 阮一峰的个人网站 - Ruan YiFeng's Personal Website  U+FFFD 0
```

未运行：Admin Panel e2e（未改前端与 admin API）；部署实例里通过 Telegram 的真实验收。

## 提交

```txt
6f180930 Decode non-UTF-8 pages in web_fetch
```
