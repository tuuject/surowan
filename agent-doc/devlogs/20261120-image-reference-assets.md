# Surowan - 20261120 生图参考素材：全库挑选、行内序号引用与 Agent 可见素材

## 背景

实现用户审核过的 PRD `doc/design/20261119-image-reference-assets.md`。改动前：

- 图片生成页的参考图区只列最近 8 张，更早的素材选不到。
- 点选参考图后只进「已选参考图」一排标签，文本框里看不出它被用在句子的哪里。
- 提示词里手写的 `{{image:UUID}}` 在解析时整段去掉，位置只决定图片顺序；绘图模型分不清哪张图对应哪句话。
- 图片素材有名称、描述、分类，但面板只能改名称；没有关键词，也没有「Agent 是否可见」的开关。
- Agent 只能把当前对话里出现过的 `img_…` 引用当输入图，看不到也查不到素材库。
- 宽屏下生成表单与「本次输出」左右并排。

PRD 的范围只包含图片素材，提示词素材不动。

本次改动由 Pi（`magpie/opencode-go/glm-5.3`，thinking `max`，T3 子线程「Implement image reference assets PRD」）实现，共一轮首次实现加一轮修正。主会话负责任务说明、review、复验与交付。

## 主要变更

### 1. 行内图片引用变成序号标签

`packages/image-service/src/resolve.ts` 不再删除 `{{image:UUID}}`，而是在原位换成 `图 N`。N 是这张图在交给绘图模型的有序图片列表里的位置（从 1 开始）：行内引用按首次出现排序，显式输入列表排在其后且不进入文字；同一张图重复引用得到同一个序号。标签格式只有一处出处：

```ts
export const IMAGE_REFERENCE_LABEL = '图';
export function imageReferenceLabel(ordinal: number): string {
  return `${IMAGE_REFERENCE_LABEL} ${ordinal}`;
}
```

标签以数字结尾，所以作者在引用前后紧挨着写数字时要补一个空格，否则 `{{image:…}}2` 会读成「图 12」：

```ts
const leading = reference.start > 0 && isAsciiDigit(text.charCodeAt(reference.start - 1)) ? ' ' : '';
const trailing = reference.end < text.length && isAsciiDigit(text.charCodeAt(reference.end)) ? ' ' : '';
result += leading + imageReferenceLabel(label) + trailing;
```

行为随之变化的一点：只含一个 `{{image:…}}` 的提示词现在解析为 `图 1`，不再报 `empty_prompt`；纯空白仍被拒绝。

### 2. 素材元数据：关键词与 Agent 可见

迁移 `src/store/migrations/065_image_asset_metadata.sql`：

```sql
ALTER TABLE image_assets ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
ALTER TABLE image_assets ADD COLUMN agent_visible INTEGER NOT NULL DEFAULT 0;
```

存量行与新建行（上传、生成输出、对话图片转换）都默认不可见。`packages/image-service/src/schema.ts` 同步了 Drizzle 定义。更新路径（`PUT /api/image/images/:id`）接受 `keywords` 与 `agentVisible`，仍按 `write_all` 开放给面板、CLI 与 MCP；Agent 没有任何修改可见性或元数据的工具。

列表搜索改为匹配名称、描述、分类、关键词四个字段。原来的搜索把 `%`、`_`、`\` 用反斜杠转义，却没有给 `LIKE` 加 `ESCAPE`，SQLite 把反斜杠当成字面量，于是 `hero_v2`、`IMG_1234.png` 这样的词搜不到自己。这是改动前就有的问题，这次一并修掉：提示词列表、图片列表和 Agent 素材查询共用一个谓词（`packages/image-service/src/assets.ts`）：

```ts
function likeLiteral(column: AnySQLiteColumn, q: string): SQL {
  return sql`${column} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`;
}
```

### 3. Agent 查询并使用可见素材

`src/plugins/image/image.ts` 新增只读内部能力 `search_image_assets`（经 `execute` 调用）：只返回已提升且未归档的素材，字段为 id、名称、描述、分类、关键词，不含图片内容；按 `next_offset` 分页；有审计；图片生成未对该 Conversation 开启时拒绝。`image_generate` 新增参数 `library_image_refs`，与只接受对话内 `img_…` 的 `input_image_refs` 并列；Agent 也可以在提示词里写行内 `{{image:<素材 ID>}}`。

素材不分 Chat（PRD 决定：可见即所有 Chat 可用），所以每次使用都重新校验。工具侧先查一次并审计拒绝（`image_asset_unauthorized`）；`src/image/bridge/submission.ts` 的 `submit` 对「新参数 + 行内引用」的全部素材 ID 查两次：进入时一次，用于在创建任何东西之前快速拒绝；所有 `await`（对话图片转换）之后、同步的 `core.generations.create` 之前再一次。第二次是 review 后补的：管理员在转换期间取消提升时，原实现仍会创建并计费。

对话图片引用与素材引用合计不超过 16 张。

重放（`src/orchestration/replay/`）合成了同名能力，在内存里分页过滤运行开始时取的素材快照；快照由 `src/image/bridge/library.ts` 的 `agentAssetLibrary()` 翻完所有页得到。

`src/image/bridge.ts` 在修正轮超过了单文件 20,000 字节的提交关卡，按职责拆成 `src/image/bridge/{index,submission,library,reconcile,shared}.ts`，对外的 `ImageBridge` 类型不变。

### 4. 一键提取名称与关键词

新端点 `POST /api/image/images/:id/extract`（`src/ingress/admin/routes/image-extract.ts`、`src/image/asset-extraction.ts`）：让模型看图并提议名称和关键词。它是预览，不落盘；面板把结果填进编辑框，由管理员保存。照辞典融合的做法写 `model_calls`（role `tool`）审计，模型输出经 TypeBox 校验。API key 需要 `write+paid`，已写入 `agent-doc/admin-panel.md` 的写端点白名单。

默认使用工具模型。工具模型不接受图片输入时，在任何模型调用之前返回 409 `tool_model_no_image_input`，并附上当前可用的支持图片输入的模型清单；请求体可以带一次性的模型覆盖（按注册表校验，不持久化）。`requireToolModel` 为此多了一个输入模态参数，默认仍是 text。

关键词上限从保存上限推导：`KEYWORDS_LINE_MAX = 500`，12 个关键词用 `, ` 连接，所以单个关键词上限是 39 字符，保证提取结果一定存得进去。

### 5. 面板

- **图片生成页**（`apps/admin-next/src/pages/image-generate.tsx`、`components/image-generate/`）：
  - 保留最近 8 张的素材条，新增「More」弹窗，可搜索、翻页浏览全部未归档素材。
  - 在素材条、弹窗点选，或在本页上传新图，都会把 `{{image:<id>}}` 插到文本框光标处（替换选区；从未聚焦过时追加到末尾）。`MarkdownInput` 为此增加了 `insertRef` 句柄。
  - 文本是引用的唯一事实来源：删除「已选参考图」标签行，面板不再发送 `input_image_refs`（Admin API 的该字段保留，CLI 与 MCP 不受影响）。
  - 新增「已引用的图」一栏，从文本解析得到：缩略图、名称、`图 N` 序号；移除一项会删掉文本里它的全部 token。
  - 表单与「本次输出」在任何宽度下都上下排列。
- **生图素材页**（`pages/image-assets.tsx`、`components/image-assets/`）：图片素材的改名换成编辑弹窗，可改名称、描述、分类、关键词和「Agent 可用」开关，并可触发一键提取；表格新增关键词与可见性两列。保存只发送打开后改过的字段，避免把另一位管理员刚取消的提升写回去。
- 四种 locale 的文案同步更新；`图 N` 不翻译，因为它是模型收到的字面标签。

### 6. 文档与 Skill

同步了 `agent-doc/admin-panel.md`、`agent-doc/data-layer.md`、`agent-doc/telegram-agent-flow.md`、`agent-doc/verification.md`、用户指南 `apps/docs/content/docs/guides/images.md`，以及 `skills/surowan-mcp`、`skills/surowan-utils` 里的操作清单。System Skill `src/plugins/image/skills/image-generation/SKILL.md` 补上了「先查询、再引用」的链路。

## Review

首次实现后跑了一轮 `ocr review`（workspace 模式），共 53 条；修正轮没有再跑 AI review，由主会话对照清单逐条验收。

成立并已修正：

| 问题 | 处理 |
| --- | --- |
| 素材可见性只在 `await` 前检查 | `submit` 在创建前再查一次，并加了转换期间取消提升的回归测试 |
| 提示词素材的「已选」标签被连带删除 | 恢复，并加 e2e |
| `LIKE` 转义缺 `ESCAPE` | 三处搜索共用带 `ESCAPE` 的谓词 |
| `search_image_assets` 的 `offset` 上限 100，分页却会给出更大的 `next_offset` | 去掉上限，与底层查询一致 |
| 重放的素材快照只有第一页 30 条 | 改为翻完所有页 |
| 编辑弹窗的状态跨素材残留、重试失败的错误不显示、保存发送全部字段 | 每次打开是新会话，过期的提取结果被丢弃；错误独立显示；只发改过的字段 |
| 12 个 40 字关键词拼接后超过保存上限 | 上限从保存上限推导 |
| `{{image:…}}2` 解析成「图 12」 | 数字边界补空格 |
| 「More」弹窗关着也请求、上传后缓存不刷新、重开不回第一页 | 仅打开时请求；共用 query key 根并在变更后失效；打开时回第一页 |
| 一次性模型的 provider、model 限 80 字符 | 去掉上限 |
| e2e 不校验提取请求体、垂直排版断言过松 | 断言精确请求体；比较输出卡片顶部与表单底部，宽窄视口各一次 |

主会话读 diff 时另外提出并已修正：编辑弹窗的输入没有可见标签；「已引用的图」与文本框之间隔着模型等选项；最近素材条取 50 条只用 8 条；「More」弹窗的搜索按钮被挤成两行（主会话直接改的）。

判为不改：

- 按 Conversation 记录「搜索返回过」才接受素材 ID：PRD 定的是可见即全局可用，可见性本身就是授权。
- 提示词语法损坏时对话图片已被转换落盘：改动前就是这个顺序，损坏的提示词最终仍被拒绝。
- 重放里 `image_generate` 不校验素材 ID、查询的大小写规则与线上不完全一致：重放是合成场景，对话图片引用在那里同样不校验。
- 提取失败时面板原样显示后端错误：与辞典融合共用同一套错误约定，要改应两边一起改。
- 历史生成快照缺少两个新字段：没有代码从快照读取它们。

## 验证

以下由主会话在该 worktree 里亲自运行：

```bash
pnpm run lint
# 通过

pnpm run check
# 通过

pnpm test
# Test Files  451 passed | 1 skipped (452)
#       Tests  2262 passed | 9 skipped (2271)

pnpm run admin:build
# 通过

pnpm run admin:test:e2e
# 352 passed, 2 failed, 3 did not run（两个失败见下）

pnpm run admin:test:e2e 10-developer
# 5 passed（全量运行时失败的那个用例，单独重跑通过）

pnpm run admin:test:e2e 12-image-assets 12-image-assets-editing 12-image-generate --repeat-each 5
# 60 passed

MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
# Verified 54 HTML/Markdown pages, search, examples, schema, provenance and 176 HTTP resources (base /).

MSYS_NO_PATHCONV=1 DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# Verified 54 HTML/Markdown pages, search, examples, schema, provenance and 176 HTTP resources (base /surowan/).

node scripts/file-token-limit.ts   # 在暂存全部改动后
# 无输出（通过）
```

全量 e2e 的两个失败：

- `30-dev-mock.e2e.ts`：`Mock dev server failed: Port 5273 is already in use`。本机已有另一个 node 进程占着 5273，不是主会话启动的，没有去停它；这个套件在本机未能验证。
- `10-developer.e2e.ts:103`（保存模型详情来源地址）：全量并行运行时失败一次，单独重跑 5 个用例全过；该文件不在这次改动范围内。

「More」弹窗搜索按钮的修正是在全量运行之后做的；之后重跑了 `pnpm run admin:build`、`pnpm run lint` 与 `12-image-generate 12-image-assets 12-image-assets-editing`（12 passed），没有再跑全量。

主会话还看了 e2e 产出的截图（生成页上下排版、素材库弹窗、编辑弹窗与「工具模型不能看图」的提示）。

未执行：

- 真实绘图模型下 `图 N` 标签的出图效果（PRD 的依据是 Gemini Image 能处理顺序关系，这里没有实测）。
- 真实 Provider 下的一键提取，以及真实 Telegram 群里让 Agent 查询并使用素材的验收。
- CLI 与 MCP 对新字段和 `image asset extract` 的调用只有子 agent 自报的 `--dry-run`，主会话没有重跑。

## 提交

```txt
fe044e82 Add agent-visible image assets and in-prompt image references
```
