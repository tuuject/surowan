# Plastic Wan - 20261017 Harness 微调页与 agent 段全量热更新

## 背景

用户希望 `config.jsonc` 的 `agent` 段除 `provider`/`model` 外的字段都能在 Admin Panel 修改，并热更新到之后的新 Invocation，新页面叫「Harness 微调」。

改动前的状态：

- 热更新白名单（`src/platform/config-diff.ts` 的 `HOT_PATHS`）已覆盖大部分 agent 字段，但 `memory_ttl_warning_days` 与 `agent.context` 的 `retained_sends_target`、`retained_sends_max`、`hard_token_ratio`、`ref_ttl_hours`、`agent_cache_size` 仍是 restart 字段。
- 其中 GC 三个参数本来就从每次运行的配置快照读取（`AgentRuntime.#maybeCollect`），缺的只是白名单；另外三个在构造时被拷成常量：`ContextRefStore` 的 `ttlHours`、`ConversationRuntime` 的 `agentCacheSize`、`AdminServer` 的 `#memoryWarningDays`。
- 面板上没有编辑这些字段的入口；`thinking_level` 已在 Models 页，人格 Prompt 已在 Prompts 页。

决定：新页面不重复放 `thinking_level` 与 `system_prompt_file`，只在顶部链接到 Models / Prompts 页。

## 主要变更

### 1. 白名单补齐

`agent.memory_ttl_warning_days` 加入 `HOT_PATHS`（`src/platform/config-diff.ts:57`），`agent.context.` 改为 `HOT_PREFIXES` 前缀（`:76`），删除原先逐项列出的两个 context 字段。至此 agent 段全部字段都是 hot。

### 2. 启动时冻结的三个值改为读当前配置

```ts
// src/orchestration/agent-runtime.ts:200
const context = () => options.configStore.current().config.agent.context;
this.#contexts = new ConversationContextStore(options.store);
this.#refs = new ContextRefStore(options.store, { ttlHours: () => context().ref_ttl_hours });
// ...
  options.conversationRuntime ?? new ConversationRuntime({ agentCacheSize: () => context().agent_cache_size });
```

- `ContextRefOptions.ttlHours` 与 `ConversationRuntimeOptions.agentCacheSize` 从 `number` 改为 getter（`src/context/context-refs.ts:216`、`src/orchestration/conversation-runtime.ts:213`），`src/orchestration/runtime.ts` 与 `src/orchestration/replay.ts` 一并迁移，测试里的构造点同步改为 `() => …`，没有保留 number 形式的兼容入口。
- `AdminServer` 去掉构造期字段，改成每次请求读取的 `#memoryWarningDays()`（`src/ingress/admin/server.ts:329`）。
- 语义差异：引用 TTL 读的是当前发布的配置而不是 Invocation 快照，所以运行中 Invocation 在发布后新签发/续期的引用也用新 TTL，已签发引用保留原到期时间；缓存上限在下一次 `remember` 时按新值逐出。这两点写进了 `agent-doc/configuration.md` 热更新表。

### 3. `GET/PUT /api/harness`

新模块 `src/ingress/admin/harness-admin.ts`：字段表 `HARNESS_FIELDS`（`:30`）以 agent 下的点分路径为键，每个字段直接 `Compile` `ConfigSchema` 里对应字段的 schema 做边界校验，可选字段带「缺省时的含义」（布尔为 `false`，`memory_ttl_warning_days` 为 `DEFAULT_MEMORY_TTL_WARNING_DAYS`，`send_max_text_length` 为 `null`）。

```ts
// src/ingress/admin/harness-admin.ts:108
export function harnessEdits(file: RawConfig['agent'], values: ReadonlyMap<string, HarnessValue>): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const [key, value] of values) {
    const current = rawValue(file, key);
    const absent = FIELDS_BY_KEY.get(key)?.absent;
    if (current === undefined ? value === null || value === absent : current === value) {
      continue;
    }
    edits.push({ path: ['agent', ...key.split('.')], value: value === null ? undefined : value });
  }
  return edits;
}
```

只写与文件不同的字段（无改动写入会让 `writeConfigEdits` 失败，也避免把缺省值写进文件）。`AdminServer.#harness`（`src/ingress/admin/server.ts:1735`）沿用 Developer 页的模式：先校验 If-Match revision，没有编辑时直接返回视图与空 `apply`，否则走 `ConfigReloader.writeAndApply`。跨字段规则不在端点重复实现，由整文件 `loadConfig` 校验后返回 422 `config_invalid`。`PUT /harness` 加入 `agent-doc/admin-panel.md` 写端点白名单。

### 4. Harness tuning 页

- 路由 `/harness`（`apps/admin-next/src/routes/harness.tsx`），侧边栏 Manage 组 Prompts 之后，图标 `SlidersHorizontal`；新 locale 区 `harness`（en「Harness tuning」/ zh-CN「Harness 微调」）。
- `apps/admin-next/src/lib/harness.ts` 放字段分组与边界元数据、`draftOf`/`parseDraft`：数字以字符串编辑，按边界本地预校验并只提交改动项。
- 坑：保存 mutation 起初在表单组件内部，而表单以 `revision` 为 key 重新挂载。写入成功但应用失败时文件 revision 变了，表单重建把错误提示一起冲掉，e2e 的 `updated but not applied` 断言因此失败。修法是把 mutation 提到页面层（`useHarnessSave`，`apps/admin-next/src/pages/harness.tsx:23`）作为 prop 传入。
- `useProviderWrite` 的刷新集合加入 `harnessQuery`，其它配置写入后本页同步刷新。

### 5. 测试

- `test/admin-harness.test.ts`：视图缺省值、多字段热应用（`restartRequired` 为空、可选字段从文件删除、记忆 `long_ttl` 判定随新值变化）、无改动不写文件、边界/类型拒绝不落盘、跨字段 422、revision 冲突与缺失。
- `test/runtime-config-snapshot.test.ts`：发布 `ref_ttl_hours: 1` 后第二次运行的 `reply:11` 在 `context_refs` 落盘为 1 小时，`reply:10` 保留原 TTL。
- `test/conversation-runtime.test.ts`（新）：上限从 3 调到 1 后下一次缓存逐出到 1。
- `test/config-diff.test.ts` 新热字段分类；`test/admin-api-keys.test.ts` 断言 API key 访问 `/api/harness` 为 403。
- `apps/admin-next/src/lib/harness.test.ts`；e2e 新增 `apps/admin-next/e2e/19-harness.e2e.ts`，`01-routes` 加 `/harness`。

### 6. 文档

`agent-doc/configuration.md`（热更新表与运行期读取例外）、`agent-doc/admin-panel.md`（写端点白名单、「Harness tuning 页」一节）、用户指南 `apps/docs/content/docs/configure/admin.md`、`configure/config-file.md`、`reference/config.md`。

## 验证

```bash
pnpm run check
# runtime / cli / admin-next / docs tsc 全部通过
pnpm run lint
# biome lint . 与 biome format . 均无错误（中途一次 lint:fix 修了 8 个文件的格式）
git diff --check
# 无输出
pnpm test
# Test Files  109 passed (109)
#      Tests  1388 passed (1388)
pnpm run admin:test:e2e 10-developer 08-models 19-harness 01-routes
# 37 passed
```

`19-harness` 首次运行有 1 个失败（应用失败后错误提示消失，见「主要变更 4」），修复后通过；另看了桌面全页截图核对布局。

未运行：Admin E2E 全量套件（留给 CI）；真实 `serve` + Telegram 环境下热应用后的 GC、引用到期与缓存逐出行为。

## 提交

```txt
08908e1 Add Harness tuning page for hot-reloadable agent settings
```
