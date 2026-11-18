# Surowan - 20261119 群聊记忆按日期搜索的可选 30 小时制

## 背景

群聊记忆按 Chat 本地自然日整理和归档：sleeping worker 一次只整理一个本地日期，每条事件摘要记在 `group_memories.day` 下，`search_group_memory` 传入 `date` 时只按 `day = date` 过滤。深夜群聊常常跨过零点，按自然日查「昨晚聊了什么」会被切成两半：23 点开始的话题归在当天，聊到凌晨两点的后半段却归到次日。

用户要的是一个可选的 30 小时制（默认关闭）。模型调用 `search_group_memory` 并传入精确到天的日期时：

- 关闭：返回当日 0 时至 24 时；
- 开启（不重叠）：返回当日 6 时至 24 时，以及次日 0 时至 6 时；
- 开启（与前一天重叠）：返回当日 0 时至 24 时，以及次日 0 时至 6 时。

另外要在 Admin Panel 加 tooltip，解释 30 小时制来自日本放送业，并说明它怎样划分日期。

关键约束：

- 只改「按日期搜索覆盖哪些时段」，整理与归档仍按自然日。改归档会牵动 sleeping 的批次切分、lane 游标和已有数据，用户的需求也只针对搜索。
- 事件行只存 `day` 与 message-id 区间，不存时间。归属只能从原文推出，而按 schema 注释，记忆行比原始消息活得久，必须处理原文已不在的情况。
- `group_memory` 整段已在热更新白名单里（`diff-merge.ts` 的 `HOT_GROUP_MEMORY_PATHS`），新字段要热应用，不能要求重建 Context。

## 主要变更

### 1. 配置字段 `group_memory.thirty_hour_clock`

`src/platform/config/schema-sections.ts:241`：可选枚举 `'off' | 'non_overlapping' | 'overlapping'`，缺省等于 `off`。配置里显式写 `"off"` 也接受，手写配置时更直观。`src/context/group-memory/index.ts` 定义同形的 `ThirtyHourClock` 类型与交接时刻 `THIRTY_HOUR_DAY_START_HOUR = 6`（`:56`）。类型放在 context 层，因为 platform 层不依赖业务模块，二者靠结构类型兼容。

### 2. 搜索窗口：`searchDayWindow`

`src/context/group-memory/day.ts:154` 返回带日期搜索覆盖的半开 UTC 窗口 `[start, end)`：

- `off` 直接复用 `localDayWindow`；
- `non_overlapping` 从当日本地 06:00 到次日本地 06:00；
- `overlapping` 从当日本地零点到次日本地 06:00。

本地 06:00 由 `localHourInstant`（`:133`）在当地这一天内二分查找「本地小时 ≥ 6 的第一个瞬间」得到，不是零点加 6 小时。春季跳时在 02:00 的日子，零点加 6 小时会落到当地 07:00。新增的按时区缓存的 `hourCycle: 'h23'` 格式化器只取小时。秋季回拨会让本地小时在一天里倒退一次，但没有真实时区把回拨放在跨 06:00 的位置，所以谓词在查找区间内仍是单调的。

### 3. 存储查询：事件按首条消息归属

`GroupMemoryStore.list` 新增 `window` 参数（`src/context/group-memory/store.ts:24` 的注释说明了语义）。带 `window` 时，查询 LEFT JOIN 同 Chat 的 `messages`，用事件首条消息的 `telegram_date` 判断归属（`dayCondition`，`:48`）：

```ts
return sql` AND ((g.day = ${input.day} AND (m.telegram_date IS NULL OR m.telegram_date >= ${input.window.start}))
             OR (g.day = ${nextDay(input.day)} AND m.telegram_date < ${input.window.end}))`;
```

- 只看 `day` 和次日两天的行。事件按自然日整理，跨不出它的归档日期。
- JOIN 条件带 `m.chat_id = g.chat_id`，靠 `messages_chat_telegram_message_id_key` 唯一索引命中。别的 Chat 里同一个 Telegram message id 不会影响归属。
- 首条原文已不在（`m.telegram_date IS NULL`）时，事件留在它的归档日期：在当天的查询里出现，在前一天的查询里不出现。这样既不会丢，也不会在两个日期下各出现一次。
- 按事件开始时刻归属，而不是按区间是否相交。这样 `non_overlapping` 下相邻日期恰好划分全部事件，跨 06:00 的事件只算在它开始的那一天。

带日期的结果改为按 `day ASC, first_message_id ASC, id ASC` 排序，keyset 的日期比较方向随之翻转。单日查询的 `day` 是常量，所以关闭 30 小时制时顺序与原来相同；30 小时制下次日凌晨的事件排在当日白天之后，读起来是时间顺序。不带日期的搜索仍是最新日期在前，也不做 JOIN。

### 4. `search_group_memory` 每次调用读当前配置

`src/context/group-memory/tools/read.ts:81` 在 `execute` 里解析当前 Chat 配置，取 `thirty_hour_clock` 与时区（`chat.timezone ?? config.timezone`），再算出窗口。工具描述保持不变，因为它属于缓存的 Agent 工具定义，热改配置后不会重建；模式说明放在结果里。30 小时制下，结果前加一行 `describeThirtyHourDay`（`:175`），写明这次覆盖的本地时段，并说明事件按首条消息归属、结果仍显示归档日期。否则次日日期的条目看上去会像误匹配。零命中时也带这一行，关键词放宽提示照旧。

### 5. Admin API 与面板

- `PUT /api/chats/:id/group-memory` 的 body 新增 `thirty_hour_clock`（`src/ingress/admin/chats.ts:45`）。`updateChatGroupMemory`（`:286`）的规则与 `idle_minutes` 一致：省略时保留旧值，`'off'` 删除字段、回到缺省，所以文件里不会留下 `"off"`。只切换开关的请求（`{ enabled: false }`）不会丢掉它。
- `packages/admin-surface/src/specs/chats.ts` 更新 summary，CLI `chat group-memory` 与反向 MCP 工具描述随之更新。
- `apps/admin-next/src/components/chats/group-memory-dialog.tsx` 在 idle 分钟下面加了「按日期搜索时使用 30 小时制」三选一 `RadioGroup`。每个选项的说明写明该档返回的时段；群聊记忆关闭时禁用，与 idle 输入框一致。标题旁的信息按钮套 Koi `Tooltip`（`:177`），解释 30 小时制来自日本放送业：深夜节目写作 25:00、26:00，放送日到次日 30:00 才结束。tooltip 还说明开启后怎样划分日期，以及只影响按日期搜索。Koi 规定 tooltip 不能承载必要信息，所以每档具体返回什么写在选项说明里，tooltip 只补来历和原理。
- Chats 表格的群聊记忆列在开启 30 小时制时追加「30 小时制」（`chat-table.tsx:120`）。
- 四个 locale（en、zh-CN、de-DE、ar）都补了文案。英文 tooltip 改用直引号：e2e 截图里弯引号 `’` 在面板字体下渲染成「day’ s」。

### 6. 文档

- `agent-doc/configuration.md`：热更新表与 `group_memory` 规则；
- `agent-doc/telegram-agent-flow.md`：两层披露一节写明窗口、归属与排序；
- `agent-doc/admin-panel.md`：端点 body 与视图字段；
- `agent-doc/verification.md`：测试契约；
- 用户指南 `apps/docs/content/docs/guides/memory.md`：新增「30 小时制」小节，含取值表。

生成的字段参考（`fields-telegram.md`，gitignored）自动列出新字段。

## 验证

测试按仓库「先写失败方式再写代码」的要求，在实现前写好：

- `test/group-memory/day.test.ts`：DST 春跳、秋拨日的 06:00，以及 Asia/Tokyo；
- `test/group-memory/tools.test.ts`：三档模式；06:00 两侧边界；Chat 时区；首条原文缺失；他 Chat 同 id 消息；排序；同一工具对象跨配置发布的热应用；不带日期的搜索；结果说明与审计行；
- `test/admin/chats.test.ts`：省略保留、`off` 删除、非法值 400、热应用；
- e2e `09-chats-group-memory`：hover 信息按钮看到 tooltip，等淡入完成后截图，再走三档保存、关闭后保留、改回关闭。

```bash
pnpm exec vitest run test/group-memory/day.test.ts test/group-memory/tools.test.ts test/group-memory/store.test.ts test/admin/chats.test.ts test/admin/group-memory.test.ts
# Test Files 5 passed (5), Tests 28 passed (28)

pnpm test
# 首次：Test Files 1 failed | 431 passed | 1 skipped (433); Tests 1 failed | 2137 passed | 9 skipped (2147)
# 失败项 test/docs/examples.test.ts：用户指南新增的 jsonc 片段不是完整对象；改成完整的 telegram.chats 片段后：
pnpm test test/docs/examples.test.ts   # 4 passed
pnpm test test/docs/search.test.ts     # 1 passed

pnpm run admin:build && pnpm run admin:test:e2e 09-chats-group-memory 01-routes
# 29 passed；截图 group-memory-30-hour-tooltip.png 在 Playwright outputDir（系统临时目录 surowan-admin-e2e-results/）

pnpm run check        # exit 0
pnpm run lint         # exit 0（先 lint:fix 修了 4 个文件的格式）
git diff --check      # exit 0
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两遍都 Verified 54 HTML/Markdown pages ... 176 HTTP resources；构建后 git status 只剩本次改动
```

Git Bash 会把 `DOCS_BASE_PATH=/` 改写成 Windows 路径，导致 `prepare.ts` 拒绝，所以 docs 这两遍在 PowerShell 里跑。

未执行：修正 jsonc 片段后没有重跑完整 `pnpm test`，只重跑了 docs 的两个测试文件，因为其余 431 个文件在首次全量里已通过，修正只动了一个 Markdown 片段。真实 Telegram 群里的回忆效果也没有人工验收。

## 提交

```txt
385c98ff Add an optional 30-hour clock to group memory date search
```
