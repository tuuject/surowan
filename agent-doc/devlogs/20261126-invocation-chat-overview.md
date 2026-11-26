# Surowan - 20261126 运行详情「概览」改成对话视图

## 背景

Admin Panel 运行详情页的「概览」原来是一条竖向时间线：入队、开始、结束三个生命周期节点，加上每条 Context 消息、每次模型调用、每次工具调用、每条 Agent 消息各一张卡片，按时间混排。一次带几次工具调用的运行就会摊成十几张卡片，读者要从里面拼出「群友说了什么、Bot 做了什么、最后回了什么」。

用户画了草图，要求改成聊天形式：

- 每批消息前有一条「消息入队」分隔线，下面是群友名字和消息气泡。
- 两次回复之间模型做的事收成一行（如「调用 3 次工具、使用一次 skill」），点开后逐条列出「使用 skill web-fetch」「使用工具 web_fetch」，工具还能再展开详情。
- Bot 的消息在右侧；鼠标移过去或用 Tab 键聚焦时，旁边出现「添加批改」入口。

开工前确认了四个决定：替换「概览」标签页（其余原始数据标签页不动）；历史上下文消息在顶部折叠；批改入口覆盖所有条目，旧草稿锚点全部保留；步骤组展开后列出私有文本与失败的模型调用，成功的模型调用只计数。

约束：一个 Invocation 可以在运行中 attach 多批消息，但详情 API 只返回开场 `bucket_id`，前端无法知道消息属于哪一批、模型何时读到它。数据其实已经落库：`invocation_messages.source_bucket_id` 标明每条 `new` 消息的来源批次（`src/store/invocation-snapshot.ts` 追加快照时写入），`invocation_buckets.injected_at` 记录模型读到这批的时间（`src/orchestration/agent-runtime/transcript.ts` 的 `markBucketInjected`）。

## 主要变更

### 1. 详情 API 返回批次，live 指纹跟随注入

`src/ingress/admin/audit/invocation-detail.ts:144` 读取该 Invocation 的 `invocation_buckets`（按 `attached_at, bucket_id` 排序），响应新增：

```ts
      source_bucket_id: row.sourceBucketId?.toString() ?? null,
      // ...
    buckets: bucketRows.map((row) => ({
      bucket_id: row.bucketId.toString(),
      attached_at: row.attachedAt,
      injected_at: row.injectedAt,
    })),
```

批次被注入时只更新 `injected_at` 和 canonical Context，`agent_messages` 不一定同步变化，所以 `src/ingress/admin/audit/invocation-live.ts:97` 的详情指纹折入 `invocation_buckets` 的 `bucket_id ~ injected_at`，否则页面要等下一次模型调用才刷新分隔线。

### 2. 纯模型 `invocation-chat.ts`

`apps/admin-next/src/lib/invocation-chat.ts` 在现有时间线（`buildInvocationTimeline`，排序与 `timelineEventKey` 锚点不变）之上重新分组，不依赖 React：

- `orderBatches`（`:262`）：开场批次在前；附加批次按 `injected_at` 排；没读到的批次放最后。老数据没有 `invocation_buckets` 行时合成一个开场批次。
- `new` 消息按 `source_bucket_id` 归批，来源为空或不在列表里的归开场批次，不丢消息。
- 模型/工具/Agent 事件归到「时间不晚于它的最后一次注入」那一批（`:315`），时间解析不了的归开场批次：

```ts
        const at = timeOf(event.at);
        const owner = [...read].reverse().find((bucket) => timeOf(bucket.injected_at) <= at);
        (owner === undefined ? openingSlot : (slots.get(owner.bucket_id) ?? openingSlot)).activity.push(event);
```

- `send` / `send_reply` 单独成为回复条目，`parseReplyParts`（`:131`）把 `send_reply` 的每个 part 拆成一个气泡，调用级 `reply_to_message_id` 只给第一条；同一个 tool call 的全部 `host_sends` 都挂在回复上。
- 两次回复之间的其余事件收成一个步骤组，key 取第一个事件的锚点，运行中追加步骤时展开状态不丢。`classifyStep`（`:187`）识别 `read` 读 `system:///skills/<name>/SKILL.md` 或 `mcp-skill://<alias>/<skill>/SKILL.md` 为技能，`execute` 的 `call`/`help`/`search` 取内部能力名或查询词；参数畸形时退回工具名。成功的模型调用、工具结果和空的助手轮次标为 `secondary`。
- `position` 按显示顺序编号（历史 → 每批的消息、步骤、回复），新写的批改意见在导出里按读者看到的顺序排。

`timeline.ts` 的 `parseSendArguments` 拆出 `parseSendObject`，供 `send_reply` 的 part 复用同一套解析。

### 3. 视图与批改入口

- `apps/admin-next/src/components/invocations/overview-tab.tsx` 用 Koi `Divider` 画批次分隔线（读到、等待、未交给模型三种文案）和「运行结束」；历史消息与步骤组用 `ChatDisclosure`（`chat-steps.tsx:34`，首次展开才挂载内容，之后保留，写了一半的意见不会因收起而丢）。
- `chat-bubbles.tsx` 用 Koi `ChatBubble`：群友 `received` 在左、Bot `sent` 在右；保留原卡片上的复制发送者 ID、消息号与「打开消息记录」。
- `StepGroup`（`chat-steps.tsx:232`）只显示非 `secondary` 的步骤，`secondary` 步骤带批改意见时也显示，有意见时默认展开，旧草稿里挂在成功模型调用、工具结果上的意见不会在页面上消失。
- `step-details.tsx` 接手原 `timeline-cards.tsx` 里工具、模型调用、Agent 消息的详情部分；`timeline-cards.tsx` 删除。
- `apps/admin-next/src/components/review/comment-note.tsx:172` 的 `ReviewableItem` 取代 `EventReviewAffordance`，根节点是 `<article>`，入口放在内容的行内末端：

```ts
const revealOnHoverClass = css({
  display: 'inline-flex',
  flexShrink: '0',
  transitionProperty: 'opacity',
  transitionDuration: 'fast',
  '@media (hover: hover)': { opacity: '0' },
  _groupHover: { opacity: '1' },
  _groupFocusWithin: { opacity: '1' },
});
```

只在能 hover 的设备上隐藏，触屏上一直显示；按钮仍在 Tab 顺序里，聚焦即显示。第一次截图时发现窄屏上隐藏的文字按钮会把气泡后面的内容挤到下一行，留下空行，改成窄屏只放图标按钮（`aria-label` 仍是「添加批改意见」）、`md` 以上放文字按钮，内容行不再换行。

### 4. 文案、文档与截图

- 四个语言的 `invocationDetail.timeline` 换成 `chat`，并拆到 `locales/<locale>/invocations/chat.ts`（阿拉伯语 `invocations.ts` 超过 pre-commit 的 5,000 token 上限）；删掉旧卡片独有、已无引用的 7 个键。
- 失败的模型调用标题只写「模型调用 provider/model」，由错误图标和「失败」徽章表示失败，不再重复。
- 用户指南 `guides/tuning.md` 的「可以批的地方」（中英）、开发者文档 `developer/http/audit.md`（中英）、`agent-doc/admin-panel.md` 的文件表与批改、API、live 指纹段落同步更新；研究笔记里指向 `timeline-cards.tsx` 的链接改指 `step-details.tsx`。
- 文档截图 `tuning/invocation-resume`（中英）包含概览，单独重拍后替换。完整的 `docs:screenshots` 只在全部场景成功时才发布，这次没有跑全量。

### 5. 测试与 e2e 样本

- `apps/admin-next/src/lib/invocation-chat.test.ts` 先于实现写成，覆盖：无批次行的老数据、按来源与注入时间分批（注入时刻同时发生的事件归新批）、未知来源回退、未读批次的 `pending`/`skipped`、`send_reply` 多条与被拒绝的 send、技能与能力识别及畸形参数、步骤组 key 稳定、时间解析失败不抛错。
- `test/admin/invocation-batches.test.ts` 用 hot-inject 夹具跑一次真实的「运行中附加第二批」：断言 `buckets` 两项且都有注入时间、`new` 消息分属两批、第一条回复早于第二次注入而读第二批的模型调用晚于它，并在清掉 `injected_at` 后断言 live 指纹变化。
- `test/fixtures/admin-seed-chat-run.ts` 把 bulk 里的 4100 补成两批已读、一批未读的长运行（技能、`execute`、失败后重试的模型调用、`send`、两段 `send_reply`），不新增运行行；模型名用 `e2e-chat-model`，第一次用 `gpt-4.1-mini` 时把 `02-lists-filters-invocations` 的按模型筛选从 2 条变成了 3 条。
- 新增 `e2e/41-invocation-chat.e2e.ts`：分隔线、气泡、折叠与展开、hover 与聚焦显隐（量包裹层的 `opacity`）、批改意见的锚点与 `position`、刷新后步骤组因意见自动展开、390px 无横向滚动、中文文案；产出桌面、手机、中文截图和 `chat-outline.json`。
- 依赖旧概览内容的用例改为新结构：`03`、`07`、`10`、`13`、`34`、`40`。其中 `10-developer` 暴露了一处回归：我把「没有原始请求内容」改成只在没有任何详情时显示，带 `error_detail` 的失败调用就不提示了，已恢复为请求与响应都为空就提示。

## 验证

```bash
pnpm exec vitest run apps/admin-next/src/lib/invocation-chat.test.ts apps/admin-next/src/lib/timeline.test.ts
# 2 files, 11 tests passed

pnpm exec vitest run test/admin/invocation-batches.test.ts test/admin/audit.test.ts apps/admin-next/src/lib
# 7 files, 25 tests passed

pnpm test
# Test Files 494 passed, Tests 2617 passed

pnpm run check
# tsc（根、cli、admin-next、docs）全部通过

npx biome lint . && npx biome format .
# No fixes applied（pnpm run lint 的输出被本机 shell 包装吞掉，直接调用 biome）

git diff --check
# 无输出

pnpm run admin:build && pnpm run admin:test:e2e
# 395 passed（拆分语言包后又跑 41-invocation-chat、24-i18n、33-i18n-stress、03-invocation-detail：38 passed）

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两次都是 Verified 148 HTML/Markdown pages ... 39 screenshots；构建后 git status 没有额外改动

pnpm --filter surowan-admin-next exec playwright test --config playwright.docs.config.ts tuning-runs -g invocation-resume
# 2 passed（en、zh-CN）；聚焦运行不发布，暂存图手动复制到 apps/docs/content/public/screenshots/tuning/
```

未运行：完整的 `pnpm run docs:screenshots`；真实 Telegram 群里的长运行（多批注入）人工查看。

## 提交

```txt
2a9eee4e Show the invocation overview as a chat
```
