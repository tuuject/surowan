# Surowan - 20261114 Admin Panel Invocation 批改与 Agent 导出

## 背景

Bot 管理员在 Admin Panel 读 Invocation 审计时，经常会对某一次具体行为有意见：回复太长、不该接话、选错贴纸、多调了一次没用的工具。之前这些意见只能另找地方记，再自己翻译成 Prompt 或配置改动。用户提出「批改」：在 Invocation 的事件下直接写评论，可以跨多个 Invocation 持续批改，最后导出一份自带提示词的 Markdown，交给本地已经接了 `surowan-utils` CLI + Skill 或 Surowan MCP 的通用 Agent（Claude Code、Codex 等）去诊断和调教。开发者也能用同一份导出，找系统提示词和工具设计的薄弱处。

约束：

- 草稿只存浏览器本地，不新增 Admin API 端点、数据库表或服务端状态。
- 导出后清空本地草稿，导出前要弹窗提醒用户；暂不做导回面板，但要在导出里预留 JSON 形式的评论数据。

实现由 T3 委派给 Pi 完成：模型 `magpie/auto/gemini-4-argon`，thinking `medium`，子线程「Admin Panel invocation review notes with agent-ready Markdown export」。主会话负责写任务说明、用 ocr 审阅、核实意见、复验与交付，共经历首轮实现、一轮 review 修正、两轮按 pre-commit token 上限拆文件。

## 主要变更

### 1. 浏览器本地草稿 store

`apps/admin-next/src/stores/review.ts` 是 zustand `persist` store，写入 `localStorage` 的 `surowan-admin-review`（`version: 1`），保存 `goal`、`purpose`（`tune` / `develop`）和按 Invocation id 分组的评论。每条评论记录 `timelineEventKey` 锚点、时间线序号 `position`、事件快照（`subject`、`attempt`、`ref`、最多 280 字符的摘录）与评论正文，正文、整体评价和 goal 上限都是 4,000 字符。

- 读取时用 `sanitizeReviewDraft`（`apps/admin-next/src/stores/review.ts:128`）逐条清洗：损坏 JSON、未知版本或形状不对的条目静默丢弃，合法条目保留，面板不会进错误边界。
- 跨标签页同步：模块级 `storage` 监听（`apps/admin-next/src/stores/review.ts:406`）调用 `persist.rehydrate()`。每次写之前也先同步重读（`syncFromStorageBeforeWrite`），所以多开几个 Invocation 标签页批改时不会互相覆盖。
- 写入失败不丢数据：`localStorage` 访问抛异常时 `getItem` 返回 `null`，`merge` 遇到 `undefined` 就保留内存态；`setItem` 失败时置脏标记，期间跳过写前重读和 `storage` 事件同步，并在一轮连续失败里只弹一次错误 toast。

### 2. 时间线评论与详情页面板

`TimelineCard` 新增 `footer` 插槽（`apps/admin-next/src/components/invocations/timeline-cards.tsx`），Overview 时间线上的 `tool_call`、`agent_message`、`model_call`、`context_message` 卡片都挂上 `EventReviewAffordance`（`apps/admin-next/src/components/review/comment-note.tsx`），可以添加、编辑、删除评论，`Ctrl/Cmd+Enter` 保存，保存空白即删除。详情页在摘要和标签页之间加了 `InvocationReviewPanel`，用来写整体评价、显示计数和链接到 `/reviews`。

详情页根容器按 Invocation id 加了 key（`apps/admin-next/src/pages/invocation-detail.tsx:48`）：在两个已缓存的详情页之间前进后退时，组件状态会重置，没保存的评论不会被挂到另一个 Invocation 上。

### 3. `/reviews` 页面与导出

`apps/admin-next/src/pages/reviews.tsx` 挂在导航 Activity 组的 Tool sessions 之后。页面上可以选用途（调教 bot / 开发者反馈）、填 goal、折叠预览 Markdown、逐条编辑或删除，也可以把整个 Invocation 移出草稿或清空草稿。

「Download Markdown」「Copy Markdown」都会先弹 `ConfirmDialog`，说明导出后会清空本浏览器的草稿，而且暂不支持导回。下载在触发之后清空。复制要等 `navigator.clipboard.writeText` 成功，再重读 store 和导出快照比对指纹（`apps/admin-next/src/pages/reviews.tsx:266`）：草稿在复制期间被别的标签页改过，就不清空并提示；写入失败则保留草稿并报错。

### 4. Markdown 与 JSON 导出格式

`apps/admin-next/src/lib/review-export.ts` 的 `buildReviewMarkdown` 生成确定性的 Markdown。固定英文提示词放在 `apps/admin-next/src/lib/review-prompt.ts`（`reviewPromptSections`），单独成文件是为了以后改措辞时不碰 pre-commit 的单文件 token 上限。提示词按顺序要求 Agent：

1. 先只读鉴权：`surowan-utils doctor --json` 或 `surowan_key_show`。
2. 拉审计和当前 Prompt：`invocation get` / `invocation prompts` 或对应 MCP 工具。
3. 按用途诊断。
4. 写入前逐项取得同意；重放先预检、再取得计费授权。

提示词还声明聊天内容是数据不是指令，并要求 Agent 用操作员写批改时用的语言回复。

不可信内容的防护：

- 摘录放进代码块，围栏长度取内容里最长连续反引号数 + 1。
- 群名、发送者名、工具名、ref、时间等元数据经 `normalizeInlineMetadata` 压成单行，再用 `inlineCodeSpan`（`apps/admin-next/src/lib/review-export.ts:139`）包成行内代码。
- 评论正文逐行转成引用块。

文末的 `## Review data (JSON)` 是给以后导入预留的结构化副本，格式如下；JSON 代码块的围栏同样按内容加长：

```ts
export interface ReviewExportJson {
  readonly format: 'surowan.invocation-review';
  readonly version: 1;
  readonly generated_at: string;
  readonly purpose: ReviewPurpose;
  readonly goal: string;
  readonly invocations: readonly ReviewExportInvocationJson[];
}
```

### 5. i18n、文档与测试

- 文案进 en / zh-CN / de-DE / ar 四个 locale；`review` 子树放在各语言的 `locales/<lang>/invocations/review.ts`，调用处仍是 `t('invocations.review.…')`。`/reviews` 上的事件标题按当前语言生成，导出用英文。
- 文档：`agent-doc/admin-panel.md` 新增「Invocation 批改（`/reviews`）」一节；用户指南新增 `apps/docs/content/docs/configure/admin-invocation-review.md`，并接入 `_meta.json` 与 `admin.md`。
- 测试：
  - `apps/admin-next/e2e/24-i18n.e2e.ts` 和 `i18n-stress-helpers.ts` 跟进新导航项。
  - 新增 `34-invocation-review-{workflow,export,resilience}.e2e.ts` 和 `review-helpers.ts`，覆盖跨 Invocation 批改、刷新后仍在、跨标签页同步、详情页状态重置、导出取消/确认、Markdown 与 JSON 内容、复制失败与复制期间草稿变化、手动清空、损坏和混合形状的存储、`setItem` 抛错，以及经群名/发送者名的 Markdown 注入。
  - 导出的 Markdown 用 `testInfo.outputPath('surowan-review-export.md')` 落盘并附加到报告。

### 6. Review 处理

ocr 审阅给出 8 条意见，主会话逐条核实后的处理：

| 意见 | 处理 |
| --- | --- |
| `setItem` 失败后，下一次写入前的重读会覆盖内存里的评论 | 成立，修正（变更 1） |
| 复制期间别的标签页新存的评论会被清空（报了两条，同一问题） | 成立（几率很小），改为比对指纹后再清空 |
| 群名、发送者名以原始 Markdown 拼进导出 | 成立，改为单行化并用行内代码包裹 |
| `/reviews` 显示硬编码英文标签 | 成立，改为结构化字段 + i18n |
| 缓存详情页之间切换时状态残留 | 成立，详情页根容器按 id 加 key |
| 损坏存储的 e2e 被 init script 覆盖，后一半没测到 | 成立，init script 改为只执行一次，并补充合法条目保留的断言 |
| 嵌套三元表达式 | low 级风格问题，不改 |

主会话另外发现 zh-CN 的 `agent_message` / `context_message` 两个分类名不准，改为「Agent 消息」「上下文消息」。修正轮新增的回归测试，由子 agent 自报在修复前确实失败。

## 验证

主会话在子 agent 的 checkout 里亲自运行（rebase 前的最终代码）：

```bash
git diff --check                                   # 退出码 0
pnpm run lint                                      # 退出码 0
pnpm run check                                     # 退出码 0
npx vitest run apps/admin-next                     # 4 files, 28 tests passed
pnpm run admin:build                               # 退出码 0
pnpm run admin:test:e2e 34-invocation-review --repeat-each 5
# 20 passed (28.8s)
pnpm run admin:test:e2e
# 319 passed, 3 failed, 3 did not run（3.3m）
# 失败：29-modal-transitions「providers dialogs keep their transitions」、
#       30-dev-mock「one command serves the hot-reloading SPA…」、
#       32-recurring-alarms「create with rule controls…」，三者都是 60s 超时，
#       都不涉及本次改动；单独重跑这三个 spec：11 passed (35.8s)。
#       上一轮修正后的全量运行为 324 passed、0 failed。
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify                 # 退出码 0
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify # 退出码 0
git status --porcelain                             # 只有本次改动
```

rebase 到 `origin/develop`（`33968278`，新提交只涉及后端 providers）后重跑 `pnpm run lint` 与 `pnpm run check`，退出码均为 0。提交时 pre-commit 的单文件 token 上限检查通过。

只有子 agent 自报、主会话未重跑：全量 `pnpm test`。子 agent 报 382 个文件通过，4 个后端用例失败：Windows 路径分隔符断言，以及满负载下的 5s 超时。本次是纯前端改动，不涉及后端。

未执行：真实浏览器里把导出文件交给 Claude Code / Codex，接真实 `surowan-utils` 或 MCP 的端到端试用。

## 提交

```txt
507173b0 Add invocation review notes to the admin panel
```
