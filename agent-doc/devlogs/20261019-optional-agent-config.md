# Surowan - 20261019 `agent` 配置段全字段可选与三元组闸门

## 背景

此前 `config.jsonc` 的 `agent` 是必填段：`provider`/`model`/`thinking_level`/`system_prompt_file`/预算/并发/Context/限流一长串字段全是必填，文件层不存在「只跑基础设施、不配对话模型」的合法形态。

需求：`agent` 段所有参数可选；`provider`/`model`/`thinking_level` 三者缺一就不发起任何 Invocation；其余字段用一套合理默认值自动填充；`agent: {}`、`agent: null` 乃至整段省略在配置校验层面都合法。

关键约束是两层配置的分离：`FileConfig`（文件层）必须允许空和缺省，`RawConfig`（运行时层）的几十个消费者都按实体字段 dereference。所以做法不是把可空传染到运行时，而是在装配处插一层默认值解析，运行时照旧拿实体值，只有模型三元组保持可选并统一走闸门。

## 主要变更

### 1. Schema 与默认值解析层

`src/platform/config.ts`：`AgentSectionSchema` 把段内字段（含 `context.*`、`rate_limits.*`、`daily_budget`）全部改为可选，`agent` 本身变为可选且可 `null`：

```ts
// invocation can start — everything else resolves to AGENT_DEFAULTS.
agent: Type.Optional(Type.Union([AgentSectionSchema, Type.Null()])),
```

新增 `AGENT_DEFAULTS` 与 `resolveAgentSection`：文件层 section（含 `null`/`undefined`）逐字段填充成 `AgentRuntimeConfig`，`RawConfig.agent` 因此除三元组、开关类与 `system_prompt` 外依旧全是实体值：

```ts
export const AGENT_DEFAULTS = {
  daily_budget: { max_tokens: 1_000_000_000 },
  max_concurrency: 4,
  context_stop_ratio: 0.8,
  history_messages: 20,
  context: {
    retained_sends_target: 20,
    retained_sends_max: 30,
    hard_token_ratio: 0.6,
    ref_ttl_hours: 72,
    idle_grace_seconds: 0,
    max_wall_clock_seconds: 1_800,
    agent_cache_size: 32,
  },
  rate_limits: {
    sends_per_window: 100,
    window_seconds: 300,
    turns_per_injection: 24,
  },
} as const;
```

模型身份拆成 `AgentSettings`（三个可选字段的 `Pick`）与 `ActiveAgentSettings`（`Required`）；`completeAgentSettings` 返回 `undefined` 表示「不能开会话」。`resolveAgentSettings` 维持「Chat 覆盖逐项合并全局」的语义，因此全局未配、某 Chat 配齐三元组时该 Chat 照常运行——这是有意保留的行为。

### 2. 校验与加载

- `validateFileConfig`：三元组不完整时追加 warning（照常启动），不再是 error；模型引用校验只在 `provider`/`model` 都给出时执行；`validateAgentThinkingLevel` 对不完整三元组直接放行。Context/限流的交叉约束（`retained_sends_target < retained_sends_max`、`hard_token_ratio <= context_stop_ratio`、`idle_grace_seconds`/`max_wall_clock_seconds` 相互关系）改为对 resolved 后的生效值校验。
- `src/adapters/local-monolith/config.ts` 的 `resolvePrompts`：`system_prompt_file` 缺省时代入空 Prompt（Core Agent Protocol 本就固化在代码里），给了文件路径才做非空与模板校验。

### 3. Invocation 闸门

`src/orchestration/invocation-queue.ts` 四条路径统一拦：到期 Bucket（`#queueBucket`）、attach 到运行中 Invocation（`#attachBucket`）、完成回执投递（`#receiptCancelReason`）、启动补偿（`finishStartupCatchUp`）都在 Chat 存在检查后加一道——

```ts
// Without a complete provider/model/thinking_level no invocation may ever
// start: close the bucket as skipped and leave the reason for audit reads.
if (completeAgentSettings(resolveAgentSettings(current, chatConfig)) === undefined) {
  this.#markBucketSkipped(bucket.id, now, 'agent_unconfigured');
```

与 `chat_removed`/`chat_paused`/`sleeping` 同级，`skipped_budget` + `error_code = 'agent_unconfigured'` 留在审计里可查询。`agent-runtime` 与 `replay` 里各有一道同构防线（reload 把三元组热改成不完整时，启动前 abort / 前置检查拒绝），`configuredAgentModels` 跳过不完整三元组，模型注册表只注册能真正启动的模型。

### 4. 消费点与 Admin 面

- `resolveToolModel` 返回 `ToolModelSelection | undefined`（继承来源没了就是没有）；merge-preview 端点在无 tool model 时回 502 `tool_model_unavailable`；`model-switch` 的 `current()`/`thinkingLevel()` 可空，`model()` 抛「未配置」。
- Admin 视图字段改 nullable：`listProviders` 的 `agent`/`tool_model`、dictionary 的 `toolModelView`、`#modelState.thinking_level` 在缺省时回 `null`；`thinkingLevelEdits` 在无 provider/model 时按 `unknown_model` 拒绝；前端 `AgentModelReference`/`ToolModelView` 改 `string | null`，Models/Chats/In-use 面板按未配置渲染。
- `prompts-admin`：全局 Prompt 无 `system_prompt_file` 时保存会创建 `prompts/agent.md` 并把字段写回 `agent.system_prompt_file`；`harness-admin` 每个字段声明 `absent` 默认值，写 `null` 即删字段回默认（因此 `{"history_messages": null}` 从「拒绝」变成合法的复位写）。
- `config-diff` 的 `mergeAgent` 容忍两侧 section 缺省/`null`，候选按文件层原样保留缺省；`doctor`、bot 命令、`tui/configure` 全部按「未配置」展示。

### 5. 测试

- 新增 `test/optional-agent.test.ts`（6 条）：`agent: {}`/`null`/缺省合法并解析出默认值、部分三元组跳过模型校验、不完整三元组下到期 Bucket 以 `agent_unconfigured` 关闭、Chat 覆盖补齐三元组后照常开 Invocation。
- `test/helpers.ts` 新增 `FixtureConfig`：fixture 总是写全 `agent`，transform 仍可按必填字段操作；一批测试对文件层 section 的访问补了非空断言。
- 两个断言随行为变化更新：`admin-harness` 的 `{"history_messages":null}` 改为验证类型错误拒绝；`docs-examples` 的字段参考路径随 union 分支渲染改名。

## 验证

```bash
pnpm run check
# tsc --noEmit（src + test + admin + docs 全量）通过
pnpm run lint
# biome lint + format 通过
pnpm test
# 全量一次：1444 passed / 2 failed（admin-harness 的 null 拒绝断言、
# docs-examples 的字段路径断言，均为行为变化后的过时预期，已更新）
# 修正后针对性重跑全部通过；新增 optional-agent.test.ts 6 条通过
```

## 提交

```txt
82eae7a Make the agent config section fully optional
```
