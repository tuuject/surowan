# Surowan - 20261113 群聊记忆：关键词零命中时提示放宽检索

## 背景

`search_group_memory` 按日期、关键词（匹配 summary，多个关键词至少一半命中）和 limit 查询群聊记忆。实际遇到过这样一次调用：

```json
{ "date": "2026-11-11", "keywords": ["吃", "饭", "麻辣香锅"] }
```

结果 `matches=0`，Agent 据此认定那天没有相关记录；用户明确要求不带关键词按整天查时，Agent 又找到了相关事件。问题不在数据缺失，而在模型把自己加的关键词过滤当成了「没有记录」的证据——摘要可能换了说法，关键词也常常是从前文对话里顺手带过来的。

改动前零命中只返回一句 `No group memories matched in this Chat.`，没有任何提示。约束：不改检索算法与匹配语义、不改工具 API、不自动重试、不把这条指导写进稳定 system prompt（会常驻占 token 并影响前缀缓存）。

## 主要变更

### 1. 零命中结果追加建议性提示

`renderSearchResult` 改为接收调用参数（`src/context/group-memory/tools/read.ts:155`）。只有关键词会造成过度过滤，所以只在「零命中且带关键词」时追加一句提示；带日期时建议只按该日期、去掉关键词再查，不带日期时建议减少或放宽关键词，不替模型编日期：

```ts
if (input.keywords === undefined) {
  return 'No group memories matched in this Chat.';
}
const broader =
  input.date === undefined
    ? 'consider retrying with fewer or broader keywords, or none'
    : `consider searching ${input.date} alone, without keywords`;
return [
  'No group memories matched in this Chat.',
  `Zero keyword matches does not mean nothing relevant was recorded: summaries may word it differently, and keywords carried over from earlier conversation are not required conditions. Before concluding there is no record, ${broader}.`,
].join('\n');
```

提示放在 tool result 里，沿用这组工具已有的「结果内附一句下一步提示」写法（命中时的 `Call read_group_messages ...`、`read_group_messages` 截断时的 `narrow the range`），而不是走 `agent.steer` 的 `harness_nudge` 通道——那条通道属于 runtime 回合钩子，工具拿不到，也没必要为一句结果文案引入新抽象。

保持不变的部分：

- 有命中时输出与原来逐字相同。
- 不带关键词的零命中（只给日期或什么都不给）仍是原来那一句，避免让模型重复同一个查询。
- 审计 `tool_calls.result_text` 仍是 `matches=<n>`，`details` 仍是 `{ count }`。
- 工具 description、参数 Schema 与稳定 system prompt 都没动。

### 2. 文档

`agent-doc/telegram-agent-flow.md` 群聊记忆「两层披露」一条补充了零命中提示的触发条件与不变量；`agent-doc/verification.md` 的 `group-memory/tools.test.ts` 覆盖说明同步更新。

## 验证

先写测试并确认在改动前失败（`Expected: "does not mean nothing relevant was recorded"`），再改实现。新测试 `test/group-memory/tools.test.ts` 覆盖：带日期 + 关键词零命中出现提示并给出同一日期；只带关键词零命中提示放宽关键词且文本里没有任何 `YYYY-MM-DD`；命中时没有提示；只带日期零命中返回原文案；四次调用的审计 `result_text` 依次为 `matches=0/0/1/0`。

```bash
pnpm exec vitest run test/group-memory/
# Test Files  12 passed (12) / Tests  56 passed (56)

pnpm run check
# tsc（packages/cli、根项目、docs）全部通过

pnpm run lint
# biome lint / biome format：Checked 1328 files / 1324 files，No fixes applied，exit 0

git diff --check
# 无输出
```

未运行：完整 `pnpm test`（改动限于群聊记忆工具的结果文案，没有其他测试或源码引用该字符串）；真实 Telegram 群聊中的模型行为验收。

## 提交

```txt
7ffa7973 Nudge a broader search when group memory keywords match nothing
```
