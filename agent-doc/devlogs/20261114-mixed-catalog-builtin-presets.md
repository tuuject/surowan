# Surowan - 20261114 混合目录内置供应商进入预设菜单

## 背景

Admin Panel 的新增 Provider 预设菜单（`GET /provider-presets` 与 `configure` 向导共用 `listBuiltinPresets()`）此前要求供应商的整个 Pi 目录只有一种统一 API：`uniformBuiltinApi` 对混合目录返回 `null`，供应商就被过滤掉。pi 1.x 的 OpenRouter 目录同时携带 `openai-completions` 与 `anthropic-messages` 两类聊天模型，于是它虽然可以经手写配置正常使用，却始终不在菜单里。

用户不认可这个做法，给出了新的选择规则：供应商提供多种 API 时，按 `openai-completions` → `openai-responses` → `anthropic-messages` → `google-generative-ai` 的顺序取第一个目录里有的。这正好是 `SUPPORTED_PROVIDER_APIS` 的声明顺序。

运行时本来就是按模型派发的：`src/platform/providers.ts` 的 `builtinConfiguredModels` 对每个配置模型取它自己目录条目的 api，混合目录从来不影响运行。缺的只是「预设记哪个 api」这一层的取值规则。

## 主要变更

### 1. `preferredBuiltinApi` 取代统一 API 过滤

`src/platform/builtin-providers.ts` 新增：

```ts
export function preferredBuiltinApi(source: Provider): ProviderApi | null {
  for (const candidate of SUPPORTED_PROVIDER_APIS) {
    if (isSupportedProviderApi(candidate) && source.getModels().some((model) => model.api === candidate)) {
      return candidate;
    }
  }
  return null;
}
```

按 `SUPPORTED_PROVIDER_APIS` 的顺序取目录里第一个受支持的 adapter，混合目录不再返回 `null`。`listBuiltinPresets` 的过滤条件从 `supportedBuiltinApi(source) !== null` 换成 `preferredBuiltinApi(source) !== null`。`uniformBuiltinApi` / `supportedBuiltinApi` 保留，继续服务 `discoveryApi` 与 `configuredBuiltinApi` 这两个「单一目录才有意义」的展示路径（`src/ingress/admin/providers/read.ts:144`）。

实际进入菜单的增量只有三个：`openrouter`（目标）、`fireworks`、`github-copilot`，前两者的目录都混着 `openai-completions` 与 `anthropic-messages`。

### 2. 创建预检改为按模型解析

`src/ingress/admin/providers/write.ts` 的 `resolveNewProviderApi` 原来返回供应商级 api，混合目录在这里被 `has no single supported API adapter` 拒绝。现在它返回「模型 id → api」的解析函数：builtin 每个模型用 `builtinModelApi(source, model.id)` 预检（与运行时派发和 `validateSemantics` 的按模型规则一致），目录条目带不受支持 adapter 的模型在写文件前报 `invalid_model`；custom 供应商仍整体用声明的 adapter。

### 3. 临时模式发现与 TUI 向导跟进

预设开放后，向导「选预设 → 输 key → 发现模型」的临时模式请求（`discover.ts` 的 `discoveryRequest` 与 `lookupDescriptor`）和 TUI 的 `configureBuiltinProvider` / `editBuiltinProvider` 还在用统一 api 解析，OpenRouter 会在发现这一步被挡住。五处调用点全部换成 `preferredBuiltinApi`，错误文案去掉「single」。

### 4. `github-copilot` 补进订阅套餐排除名单

它此前恰好被「统一 API」过滤顺便挡住；优先级 fallback 让它重新合格，`test/admin/providers.test.ts` 的套餐特征 tripwire 立即拦截。它是 Copilot 订阅端点（`api.individual.githubcopilot.com`），与 `kimi-coding` 等同属全天跑群聊有封号风险的套餐，补进 `SUBSCRIPTION_PLAN_PROVIDERS`。目录里不受支持的 adapter 型供应商（`mistral` 等）和 OAuth-only / 占位 baseUrl 的（`google-vertex` 等）仍被 `isSupportedBuiltinPreset` 拒绝。

### 5. 文档与测试

`agent-doc/configuration.md` 的 Provider 预设段落记录了新的优先级规则与 `github-copilot` 的排除理由；`builtinModelApi` 对混合目录下未收录 id 的 gateway fallback（`openai-completions`）不变。测试更新：预设用例断言 `openrouter` 带 `api: openai-completions` 在列、`fireworks` 在列、套餐（含 `github-copilot`）不在列；新增「从混合目录预设创建 builtin 供应商」的用例走完整 POST → 文件落盘 → key jar 路径。

## 验证

```bash
pnpm run check
# 退出码 0
pnpm run lint
# 退出码 0
pnpm vitest run test/tui-configure.test.ts test/admin test/foundation test/providers.test.ts test/models
# 61 files passed, 314 tests passed
pnpm run admin:test:e2e 08-models
# 26 passed (26.1s)
pnpm test（全量，跑了两遍）
# 第一遍 4 failed / 第二遍 2 failed，失败集合在两遍之间漂移：
#   - test/recurring-alarms/schedule.test.ts「croner is imported only by …」：
#     Windows 路径分隔符（期望 `adapters/local-monolith/…`，实收 `adapters\…`），
#     在未改动的 develop 主 checkout 上同样失败，属存量问题，与本改动无关；
#   - test/admin/chats-participation.test.ts 一个用例 5s 超时，单跑与在
#     develop 上复跑均通过，是全量长时间运行下的偶发 flake。
```

未执行：真实 OpenRouter API key 的 Telegram 端到端验收（真实凭据不进 CI 与测试）。

## 提交

```txt
4f613041 Offer mixed-catalog builtin providers as presets with preferred API fallback
```
