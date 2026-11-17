# Surowan - 20261117 共用 Token 估算改为 CJK 感知

## 背景

改动前，runtime 里所有 Token 估算都是 `Math.ceil(text.length / 4)`。塑料碗主要跑在中文群里，一个汉字大约是一个 token，所以中文历史被估成真实大小的四分之一左右。读这个估算的地方都因此反应过慢：

- Context GC 的 token 压力判据（`hard_token_ratio`）；
- 进入收尾模式的 `context_stop_ratio` 阈值；
- 打开 Context 时判断保留历史是否超出模型窗口的 `maxRetainedTokens`；
- 工具注册表不得超过窗口 10% 的上限；
- 重放的输入预算检查。

起因是在讨论「上下文容量诊断」功能：打算把每一步新增的内容按估算比例分摊到 Provider 实际汇报的 token 增量上，这要求估算的**占比**靠谱。`length / 4` 会把占比扭向 ASCII 的工具 schema。用户决定不另起一套诊断专用口径，直接改共用的那个，并接受 GC 会因此更早触发。

估算规则参考 Magpie 网关的 `tokensOf`：ASCII 每 4 个字符 1 token，其余每个码点 1 token。

本次由 T3 委派 Pi（`magpie/auto/glm-5.3-flash`，thinking `max`）在子线程「Make the shared token estimate CJK-aware」里实现。测试文件由主会话先写好并原样放进任务说明，主会话负责 ocr 审阅、读 diff、独立复验和交付。

## 主要变更

### 1. 共用估算函数：`src/platform/token-estimate.ts:9`

```ts
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 0x80) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 4) + other;
}
```

按码点迭代，所以代理对（多数 emoji）算一个字符，孤立代理项也算一个而不是抛错或丢失。放在 `src/platform/`，没有业务依赖。

### 2. 所有 Token 估算迁到这个函数

- `src/context/codec.ts:277`：`estimateMessageTokens` 对落盘的消息 JSON 用共用估算，工具图片那一项（`⌈w/32⌉ × ⌈h/32⌉`）不变。这个值写进 `context_messages.est_tokens`。
- `src/orchestration/agent-runtime/support.ts:323`、`:327`：新增 `estimateToolDefinitionTokens` 与 `estimateToolRegistryTokens`，和字符数版本读同一个定义字符串；`validateToolRegistry`（`:344`）改为拿 token 估算和 `contextWindow * 0.1` 比较。
- `src/orchestration/agent-runtime/transcript.ts:212`：`estimateInputTokens` 接收工具定义的 token 数，不再除 4；调用方 `run-agent.ts:149` 与 `run-turns.ts:74` 同步。`AgentRun` 增加 `toolDefinitionTokens` 字段。
- `src/orchestration/agent-runtime/run-round.ts:115`、`:178`：注入批次与 `zzz` 暴露时的估算。
- `src/orchestration/agent-runtime/run.ts:85`：system prompt 的 token 估算，影响 `maxRetainedTokens`。
- `src/orchestration/replay/run.ts:191`：重放的 system prompt 与工具定义估算。

### 3. 没有改的部分

- **注入的字符预算仍按字符计**：`src/context/builder/render.ts` 的 `maximumCharacters`、注入器契约的 `remainingCharacters`、Memo Pad 与辞典注入都没有动，这是插件可见的接口。所以 `estimateToolRegistryCharacters`（`support.ts:336`）保留给这一处使用，`estimateTranscriptCharacters`（`transcript.ts:228`）仍返回 `tokens * 4`，注释改成「折算为 ASCII 等价字符」。副作用是中文 transcript 会让这份预算收得更紧。
- **不迁移旧数据**：已落盘的 `est_tokens` 保留旧值，随 GC 淘汰。
- **`run-hooks.ts` 的高水位没有动**：那里用 `message.usage.input` 抬高估算，而 pi-ai 的 `input` 不含缓存读写。这是另一个独立问题，本次没有处理。

### 4. 文档

`agent-doc/data-layer.md`、`agent-doc/telegram-agent-flow.md`、`agent-doc/product-knowledge.md` 说明了新的估算规则；`skills/surowan-dev-bake-product-knowledge/SKILL.md` 的测量命令改为导入 `estimateTextTokens`。

## 审阅

ocr 对首轮实现跑了一次，10 个文件 0 条意见，没有打回。主会话读 diff 时只改了两处文档措辞（去掉「迁移前」「不再按字符数除 4」这类描述历史的说法）。

## 验证

测试 `test/context/token-estimate.test.ts` 先于实现写成，覆盖：ASCII 取整与空串、CJK 与混合文本、代理对与孤立代理项、CJK 工具注册表超过 10% 被拒、CJK 批次落盘的 `est_tokens`、三批各 7,000 字的中文历史在 40,000 窗口（`hard_token_ratio` 0.5）下触发 GC 并断言 `head_seq`、`last_gc_at` 与 `context_gc` 审计事件。

主会话在子 agent 的 checkout 里亲自运行：

```bash
pnpm run lint
# exit 0
pnpm run check
# exit 0
pnpm test test/context/token-estimate.test.ts   # 连跑 3 次
# 每次 6 passed
pnpm test test/context test/agent test/replay test/config/reload.test.ts test/runtime/config-snapshot.test.ts test/tasks/context-budget.test.ts test/group-memory/store.test.ts
# Test Files 53 passed (53) / Tests 202 passed (202)
git diff --cached --check
# exit 0
node scripts/file-token-limit.ts   # 暂存后
# exit 0
pnpm test
# Test Files 1 failed | 408 passed | 1 skipped (410)
# Tests 1 failed | 2032 passed | 9 skipped (2042)
```

全量里唯一的失败是 `test/group-memory/store.test.ts` 的「a keyword search reaches an entry older than thousands of non-matching ones」，超时（5000ms 上限，实际 5241ms）。它和 `src/context/group-memory/` 都不导入本次改动的任何模块；单独连跑 3 次，1 次超时（5122ms）、2 次通过，是卡在默认超时边上的时序问题。同一台机器上 base（`e79ae226`）的全量基线里这个用例通过，失败的是另一个同样超 5 秒的 `test/playground/only.test.ts`。没有在 base 上单独重复这个用例来对比失败率。

全量测试在 rebase 之前跑的；rebase 带进来的唯一提交是 `a4fa653e`（新增一篇 PRD，没有代码），之后没有重跑。

只有子 agent 自报、主会话没有复现的：新集成测试在接线之前失败（工具注册表用例未抛错、`est_tokens` 为 1818、`last_gc_at` 仍为空）；改动没有让任何现有测试的数字需要调整。

未执行：`pnpm run admin:test:e2e` 与文档站构建（没有改 Admin Panel、admin API、locale、`apps/docs/` 或 `ConfigSchema`）；真实 Provider 下中文群的 GC 人工验收。

## 提交

```txt
41737adc Make token estimates CJK-aware
```
