# Surowan - 20261115 默认把事实类问题当作有时效性，优先网络搜索

## 背景

用户问「最近有什么笔记本电脑推荐」这类问题时，模型常常直接凭训练知识回答，给出的型号和价格可能已经过时。web_search 能力已经存在，但稳定段对它只有 Skill 索引里的一行描述（"Search the web for sources when you do not know a URL…"），没有告诉模型什么时候应该先搜索；`SKILL.md` 的「When to use」也只写了「任务需要最新信息时」，由模型自己判断，结果往往判断成不需要。另外模型搜索时不带年份，搜索引擎容易把旧页面排在前面。

约束：

- 稳定段对一个 Conversation Context 逐字节稳定，改动会在下一次 Invocation 重建所有 Context；这是一次性代价，按惯例推进 `AGENT_PROMPT_VERSION`（上一次是 `11f8e13d` 在 `3-capabilities.md` 加成员资料一段时从 12 到 13）。
- 当前年份只能从每批注入的 `<runtime_state>` 里的 `current_time` 读取（`src/context/builder/format.ts:248`，`dateStyle: 'full'`，带年份）。稳定段不能写具体年份，否则会和 Context 稳定性冲突，跨年后也会误导模型。

## 主要变更

### 1. 稳定段新增「Web search」一段

`src/platform/prompts/3-capabilities.md:7`，写法沿用同文件「Group memory」段的「when … available」条件句：web search 关闭时 Skill 不在索引里，这一段对模型就是一条不适用的规则。

```md
Web search: when the web-search System Skill is listed, you SHOULD assume by default that a factual question is time-sensitive, because recommendations, products, prices, software versions, news, events, rankings, schedules, and people's current roles may all have changed since your training data. Before answering such a question you SHOULD search with web_search instead of relying on your own knowledge, and SHOULD put the current year from current_time in the query (for example "laptop recommendations YYYY", with YYYY replaced by that year) unless the user names another period. Small talk and stable knowledge such as definitions, math, or settled history need no search.
```

示例用 `YYYY` 占位而不是写死年份，理由见背景。闲聊和稳定知识明确排除，免得群聊里每句话都触发搜索。

没有选择把规则写进 Skill 的 `description`（它也会进稳定段，且随可用性自动隐藏）：description 是一行触发提示，放不下「默认假设」加年份规则，而且在索引列表里的显著程度不如单独一段。

### 2. Skill 正文补充年份规则

`src/plugins/web-search/skills/web-search/SKILL.md`：「When to use」加一句「除非问题属于稳定知识，否则默认它需要最新信息」；「How to call」开头加一条：时效性问题要把 `current_time` 里的年份（或用户点名的时段）写进查询，并说明原因（不带年份时引擎常把旧页面排在前面）。模型写查询时读的是这份文档，所以年份规则在这里重复一次。

### 3. 版本与文档

- `src/platform/agent-protocol.ts:4`：`AGENT_PROMPT_VERSION` 从 `13n` 升到 `14n`。
- `agent-doc/telegram-agent-flow.md`：稳定段一节补上 `3-capabilities.md` 现在包含的内容（顺带补上此前漏写的成员资料）；`web_search` 一节写明时效默认与年份规则。

## 验证

```bash
git diff --check
# 通过
pnpm run check
# exit 0（tsc、cli、admin-next、docs 四段都通过）
pnpm run lint
# exit 0，Checked 1461 files, No fixes applied
pnpm test
# Test Files 2 failed | 392 passed | 1 skipped (395)
# Tests 2 failed | 1940 passed | 9 skipped (1951)
```

两个失败都与本次改动无关：

- `test/recurring-alarms/schedule.test.ts` › croner is imported only by the local-monolith schedule engine：Windows 上路径分隔符是 `\\`，期望值是 `/`。`git stash` 后在 `61d88c49` 上单独跑同样失败。
- `test/group-memory/store.test.ts` › a keyword search reaches an entry older than thousands of non-matching ones：完整套件里超过 5 秒超时；带本次改动单独重跑两次都是 9 passed。

没有新增测试：改动只有稳定段和 Skill 文档里的文字，断言「提示词里有这句话」验证不了模型行为。

未执行：真实模型下的行为验收（在 Telegram 或 Playground 里问「最近有什么笔记本推荐」，确认模型先调用 `web_search`、查询里带当年年份）。

## 提交

```txt
bf5829a4 Prefer web search for time-sensitive questions
```
