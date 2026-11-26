# Surowan - 20261126 概览对话视图版式整理

## 背景

`20261126-invocation-chat-overview.md` 与 `20261126-invocation-chat-tool-results.md` 之后，用户反馈对话视图「看起来不是那么规整」，要求优化样式实现。在 1280px 浅色英文、1280px 深色中文、390px 浅色中文三种截图里核对后，问题集中在：

- 批改按钮（悬停才显示，但始终占位）放在 Bot 气泡的外侧，气泡被挤离右边缘，下面的元信息却贴着右边缘，两者不对齐。
- 群友消息元信息里复制 ID 的 36px 图标按钮把那一行撑高，消息之间的间距看起来不均匀；按钮右侧留白也比左侧宽。
- 步骤主体一项一行：「耗时」「参数」「结果」「查看详情」「没有原始请求内容」各占一行；回复下单独一行「› 结果」挂在右边，展开后的面板又从最左边铺开。
- 时间的位置不统一：群友消息在名字旁，回复在下方，步骤在标题后。
- 元信息里露出原始枚举 `text`；气泡宽度被覆盖成 560px，与 Koi `ChatBubble` 自带的 480px 不一致。

## 主要变更

### 1. 共用的条目结构 `chat-parts.tsx`

新增 `apps/admin-next/src/components/invocations/chat-parts.tsx` 的 `ItemMeta`：每个条目在内容下方只有一行元信息，时间打头，然后是事实，最后是展开开关；开关打开的面板排在这一行下面。面板首次打开才挂载，关闭后保留（JSON 树的展开状态不丢）。开关是带 `aria-expanded`/`aria-controls` 的按钮，面板是带名字的 `section`。

元信息行里非开关的按钮（复制 ID）用负外边距收回，不再撑高行，也让左右留白对称：

```ts
  // A 36px icon control (copy an id) must not make its line taller than the
  // others, nor leave a wider gap after it than before it.
  '& button:not([aria-expanded])': { marginBlock: '-2', marginInlineEnd: '-2' },
```

Bot 一侧的面板贴右、最宽 480px，挂在回复正下方。

### 2. 消息、回复与步骤都用这套结构

- `chat-bubbles.tsx`：群友消息标题行只放名字与 `@username`；元信息依次是时间、「消息 1001」、复制发送者 ID、打开消息记录，不再显示原始 `kind`。回复的元信息是时间、回复哪条、每条投递的状态与消息号，「结果」作为同一行的开关。去掉气泡的 560px 覆盖，只保留 `minWidth: 0`。
- `step-details.tsx` 改为 `ToolStepFooter`、`ModelStepFooter`、`AgentStepFooter` 与 `ToolOutcomeView`：工具步骤一行是「时间、耗时、错误码或没有记录结果、› 参数、› 结果」；模型调用一行是时间、尝试次数、Token、费用、耗时、错误码、没有原始请求内容与「› 查看详情」；助手私有文本先显示正文，再一行时间与「› 思考过程」。
- `chat-steps.tsx` 的步骤标题行去掉时间，只剩图标、名称与状态徽章。

### 3. 批改按钮放在朝向对话的一侧

`apps/admin-next/src/components/review/comment-note.tsx` 的 `ReviewableItem` 在 Bot 一侧用 `row-reverse`：内容留在自己的边上，按钮落在内侧（群友气泡之后、Bot 气泡之前）。按钮包裹层加 `marginBlock: '-2'`，单行标题不会被撑到 36px。元信息与内容之间多一档间距，批改意见卡片最宽 480px，与气泡一致。

### 4. 其他

- 概览条目之间的间距从 `4` 放宽到 `5`。
- 四个语言删去已无引用的 `contextMessage.telegramMessage` / `roomMessage`。
- 公开截图 `tuning/invocation-resume`（中英）露出概览顶部的一条群友消息，元信息顺序变了，重拍后替换。

## 验证

```bash
pnpm exec vitest run apps/admin-next/src
# 9 files, 54 tests passed

pnpm run check
# exit 0

npx biome lint . && npx biome format . && git diff --check
# No fixes applied；无输出

pnpm run admin:build && pnpm run admin:test:e2e 41-invocation-chat 03-invocation-detail 34-invocation-review 07-theme 10-developer 13-sender-ids 40-invocation-live-refresh 23-mcp-images
# 44 passed

pnpm run admin:test:e2e
# 391 passed, 1 failed：30-dev-mock，5273 端口仍被这个 worktree 里已在运行的 npm run dev:mock 占用（不是本次启动的，没有停掉）
```

改动前后都用一个临时 Playwright 脚本（未提交）截了 1280px 浅色英文、1280px 深色中文、390px 浅色中文三张图并逐张看过；手机宽度下没有横向滚动。

```bash
pnpm --filter surowan-admin-next exec playwright test --config playwright.docs.config.ts tuning-runs -g invocation-resume
# 2 passed（en、zh-CN）；聚焦运行不发布，看过图后从 staging 手动复制到 apps/docs/content/public/screenshots/tuning/
```

未运行：`rose` 调色板与 RTL 下的查看；完整的 `pnpm run docs:screenshots`。

## 提交

```txt
b4730cae Even out the invocation chat layout
```
