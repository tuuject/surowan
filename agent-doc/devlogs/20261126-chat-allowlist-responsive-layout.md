# Surowan - 20261126 会话白名单改为五列摘要与窄屏列表

## 背景

Admin Panel 的「会话白名单」页把每项会话配置都放在独立的表格列里：会话、话题、主模型、活跃时间、主动回复、入场闸门、群聊记忆、状态、操作，一共九列，表格 `minWidth` 是 1040px。改造前的实际问题：

- 1440px 桌面下，模型标识符 `merge / e2e-merge-model` 被拆成三四行，会话 ID 在「会话」列里被截断（`truncate`），话题、主动回复等短列大量换行。
- 手机上表格横向滚动，首屏只能看到两列半。
- 默认值和继承状态也占一列：未覆盖的入场闸门显示「跟随全局设置」，看不出实际生效的是开启还是关闭；没开的群聊记忆、主动回复也各占一格「关闭」。
- 筛选区是一张只放了一个「会话」输入框的 Card，和「添加会话」工具栏分成两块。

用户要求重组信息而不是删减：列表负责浏览和比对差异，详情负责完整呈现，编辑仍交给现有对话框；不改后端 API 与配置结构，桌面与移动端复用同一套展示逻辑，不能有横向溢出或丢失操作入口。

## 主要变更

### 1. 取值与来源集中在 `facts.ts`

`apps/admin-next/src/components/chats/facts.ts` 的 `useChatFacts(view, gate)`（`:155`）把一个 Chat 的配置算成「实际生效值 + 来源」：`chat`（本会话写的）、`global`（来自全局段）、`default`（谁都没配置）。表格、窄屏列表和详情都只消费它的结果。

活跃时间按运行时 `src/platform/participation.ts` 的 `compileParticipation` 同样的规则解析，而不是沿用旧表格的判断。旧代码在本会话没有 `participation`、全局也没有 `active_windows` 时一律显示「不限制」，但全局只写了 `trigger_keywords` 时运行时其实是「仅触发可唤醒」：

```ts
export function effectiveActiveHours(
  chat: ParticipationView | null,
  global: ParticipationView | null,
): { readonly hours: ActiveHours; readonly source: FactSource } {
  if (chat === null && global === null) {
    return { hours: { kind: 'unrestricted' }, source: 'default' };
  }
  if (chat?.ask_only ?? global?.ask_only ?? false) {
    return { hours: { kind: 'askOnly' }, source: chat?.ask_only === undefined ? 'global' : 'chat' };
  }
  if (!scheduled(chat) && !scheduled(global)) {
    return { hours: { kind: 'unrestricted' }, source: chat === null ? 'global' : 'chat' };
  }
  const windows = chat?.active_windows ?? global?.active_windows ?? [];
  // ...
}
```

入场闸门的生效值需要全局段，而 `GET /chats` 不带它。页面另外读取 `GET /decision-gate`（`apps/admin-next/src/pages/chats.tsx:45`），saved 侧配全局 `saved`、active 侧配 `active`，把本会话覆盖叠上去（`facts.ts:316`）。读取失败时退回旧行为，只描述本会话写了什么（「跟随全局设置」「开启（拦截）」等）。

### 2. 视觉层级：值一直可见，来源决定权重

`apps/admin-next/src/components/chats/row-parts.tsx` 放两种布局共用的展示块：`ChatIdentity`、`ChatModelSummary`、`ChatPolicySummary`、`ChatStatusBadge`、`ChatActions` 与 `ChatSettingsDetails`。

- 本会话写的值用正文色；继承全局的值用 `text-muted`，末尾标「（继承）」（复用已有的 `inheritedSuffix`，`InheritedMark` 在 `:60`）；默认值只用 `text-muted`。
- 会话策略摘要总是列出群的活跃时间（最多两段，其余显示「另 N 个时段」）；主动回复、入场闸门、群聊记忆、MCP 只在生效开启或本会话单独设置时出现，继承来的「关闭」省略。本会话自己关掉主动回复这类与全局不同的设置会出现在摘要里。
- 主模型以目录里的显示名为主，Provider 与思考强度在次行，完整 `provider / model` 放进 tooltip 和详情；没有配置模型时显示已有的「未设置」，不再拼出 `null / null`。
- 会话名、模型名用 `<bdi>` 隔离，不再在块级元素上写 `dir="auto"`，阿拉伯语标题在英文表格里不会右对齐跑偏。

各行摘要的标签列要等宽，值才能跨行对齐。每个 `dl` 带上所有可能出现的标签，用一个零高度、`visibility: hidden` 的伪元素撑开标签列（`row-parts.tsx:121`）。生成内容不进 `textContent`，也不进无障碍树：

```ts
<dl
  data-label-sizer={labels.join('\n')}
  className={css({
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    // Spacing rides on the rows, not `rowGap`: the sizer's own row must add no height.
    '& > dt:not(:first-of-type), & > dd:not(:first-of-type)': { paddingBlockStart: '2' },
    '&::after': {
      content: 'attr(data-label-sizer)',
      gridColumn: '1',
      whiteSpace: 'pre',
      height: '0',
      overflow: 'hidden',
      visibility: 'hidden',
    },
  })}
>
```

### 3. 五列表格、窄屏列表与工具栏

- `chat-table.tsx` 只剩五列：会话 20%、主模型 19%、会话策略吃剩余宽度、状态 128px、操作 96px，加 `TableShell` 自带的行首展开列，展开后是 `KvList` 形式的全部配置，含时区、触发关键词、注意力窗口和入场闸门各字段的来源。所有单元格顶对齐。
- `card-list.tsx` 是窄屏布局：发丝线分隔的纵向列表（按 Koi「列表不是表格也要读起来像表格」，不套 Card），主模型作为摘要第一行，「查看全部配置」展开同一个详情组件。这里的操作按钮不做表格那种 -8px 外扩，否则会伸出容器 8px。
- 切换按列表自身宽度决定：外层 `containerType: inline-size`，容器窄于 920px 时显示列表（`pages/chats.tsx:38`）。两套 DOM 并存，用 `display: none` 切换，隐藏的那套不进无障碍树。920px 留出了余量：1280px 窗口在有经典滚动条时容器约 968px，仍然显示表格；1024px 窗口显示列表。
- `toolbar.tsx` 取代筛选 Card：左侧搜索框，回车应用、写入 URL 的 `search`，有搜索时出现「清除筛选」；右侧「添加会话」与刷新。窄屏时搜索单独占一行。
- 删除从行内红色按钮移到「更多操作」菜单末尾，用分隔线隔开、错误色；只剩最后一个已保存的会话时禁用（与原按钮的禁用条件相同）。「编辑」保留在行内。

### 4. 文案、测试与文档

- 四种语言新增 16 个键（`colPolicy`、`searchChats`、`supergroup`、`channel`、`topicsLimited`、`moreWindows` 等）。阿拉伯语带 `{{count}}` 的两个键按 catalog 测试要求补齐 6 种 CLDR 复数形式。会话类型改为本地化文案，不再显示原始 `supergroup`。
- 原有 e2e 改为按标签定位摘要值（`chats-fixture.ts` 的 `labelledValue`），`chatRow` 改为匹配当前可见的表格行或列表项，删除改走菜单。入场闸门、主动回复、群聊记忆的断言从「只显示覆盖」改成断言实际生效值和继承标记。
- `i18n-stress-helpers.ts` 的 `openRoute` 只等待可见的表格，否则窄屏下隐藏的表格会让它一直等行出现。
- `docs-screenshots` 的列序号断言改为按行内容；`first-bot/chat-allowlist` 两张公开截图换成新布局。用户指南 `guides/chats.md` 中英文补了一段新列表的读法，`agent-doc/admin-panel.md`、`configuration.md`、`verification.md` 同步。

## 验证

先列出可能出错的情况：表格与列表都显示或都不显示、页面或列表项横向溢出、操作按钮出窗口、继承值被当成本会话值（或反过来）、关掉的继承功能挤进摘要、长名称与长模型名撑坏布局、RTL 下对齐跑偏、详情缺字段、搜索或删除在窄屏不可用、深色主题下继承值和本会话值颜色相同。新增的 `apps/admin-next/e2e/09-chats-layout.e2e.ts` 覆盖这些情况，在 1440/1280/1024/390/320 下逐一断言，并输出 `chats-<宽度>.png`、`chats-320-details.png`、`chats-390-dark.png` 作为可复查的截图。第一次运行时它在 1024px 抓到列表项伸出容器 8px（操作按钮沿用了表格的外扩），改掉后通过。

另外在浏览器里用 mock 后端实际检查了 1440、1280、1024、390、320 五种宽度，中文深色和阿拉伯语 RTL，以及超长中英混排群名、超长模型名、阿拉伯语群名、待重启的话题改动、继承的全局时段和全局闸门。

```bash
git diff --check
# 无输出
pnpm run lint
# Checked 1775 files, No fixes applied（exit 0）
pnpm run check
# exit 0
pnpm test
# Test Files 492 passed (492)，Tests 2608 passed (2608)
pnpm run admin:build && pnpm run admin:test:e2e
# 386 passed，1 failed：30-dev-mock 首个用例，因为本地 mock 开发服务器占着 5273
pnpm run admin:test:e2e 30-dev-mock --workers=1
# 停掉本地 mock、关掉连着 5273 的浏览器页签后：4 passed
pnpm run admin:test:e2e 09-chats-layout
# 3 passed
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 148 HTML/Markdown pages in two locales, 39 screenshots ...（两种 base 都通过），构建后无多余改动
pnpm run docs:screenshots
# 73 passed，3 failed，全部与本次改动无关：
# tools/recurring-alarm（en、zh-CN）断言「下次触发是周一」，今天（周四）不成立，是日期相关的时间炸弹；
# tools/mcp-servers（zh-CN）等「不可用」状态超时。
# 流水线因此没有替换公开截图；两张 first-bot/chat-allowlist 是从这次运行的 staging 里单独取出、看图确认后替换的。
```

未执行：真实部署环境下的人工验收。

## 提交

```txt
af6a540c Reorganize the Chats allowlist into a responsive summary list
```
