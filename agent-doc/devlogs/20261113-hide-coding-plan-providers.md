# Surowan - 20261113 新增 Provider 菜单隐藏 Coding / Agent 订阅套餐

## 背景

Admin Panel 的新增 Provider 向导（`GET /provider-presets`）和 `configure` TUI 向导都从 `listBuiltinPresets()` 取内置预设。这个函数只按技术条件过滤 Pi 的 Provider 目录：目录非空、单一受支持 API、具体 base URL、API key 认证。所以 Pi 新带的几个订阅套餐也进了菜单：

- `kimi-coding`（Kimi For Coding）、`zai-coding-cn`（Z.AI Coding CN）。
- `zai`（Z.AI）：Pi 给它的 base URL 是 `https://api.z.ai/api/coding/paas/v4`，即 GLM Coding Plan 端点，按量付费的通用端点是 `/api/paas/v4`。
- `qwen-token-plan`、`qwen-token-plan-cn`、`qwen-token-plan-individual`：阿里云百炼 Token Plan，团队版条款限于兼容的 AI 编程与智能体工具里交互使用，禁止脚本或后端调用。
- `xiaomi-token-plan-ams`、`xiaomi-token-plan-cn`、`xiaomi-token-plan-sgp`：小米 MiMo Token Plan，面向 OpenClaw、Kilo Code 等 Agent 工具的订阅。

塑料碗由群消息唤起，可能全天运行，不是这些套餐面向的交互式编程工具。菜单里出现它们会让用户以为这样接入没问题，实际有违反条款、被封号的风险。用户要求把它们从菜单里拿掉，已经添加的不受影响。

`minimax` / `minimax-cn` 的 `/anthropic` 端点按量付费也能用，Coding Plan 只是换一把 key，所以保留。

## 主要变更

### 1. 预设菜单排除订阅套餐

`src/platform/builtin-providers.ts` 新增 `SUBSCRIPTION_PLAN_PROVIDERS` 名单，`listBuiltinPresets()` 先排除名单里的 id，再走原来的技术过滤：

```ts
export function listBuiltinPresets(): readonly Provider[] {
  return listBuiltinProviders()
    .filter(
      (source) =>
        !SUBSCRIPTION_PLAN_PROVIDERS.has(source.id) &&
        isSupportedBuiltinPreset(source) &&
        supportedBuiltinApi(source) !== null,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
```

面板和 TUI 共用这个函数，一处生效。`isSupportedBuiltinPreset()` 不变，所以 `check-config`、`resolveBuiltinModelApi()`、Provider 列表、改 key、模型发现和运行时都照常接受已配置的这类 alias。`POST /providers` 直接指定这些 id 也不拒绝：需求只要求从菜单移除，显式调用 API 不算误用。

### 2. 测试与文档

`test/admin/providers.test.ts` 的预设测试先写、先失败（`kimi-coding` 仍在列表中），实现后通过：

- 断言九个套餐 id 都不在 `/api/provider-presets` 里，`moonshotai`、`moonshotai-cn`、`minimax`、`xiaomi` 仍在。
- 对所有预设的 id、名称、base URL 做 `/coding|token[- ]?plan|copilot|codex/i` 特征匹配并要求为空，Pi 升级引入新的套餐预设时在这里失败，而不是悄悄进菜单。
- 新增「已配置的套餐 Provider 继续可用」：配置里放一个 `kimi-coding` alias，断言列表里的 `api`/`base_url` 正常、改 key 成功。

`agent-doc/configuration.md#provider` 补充菜单过滤规则、名单位置与「只过滤菜单」的边界。

## 验证

```bash
corepack pnpm exec vitest run test/admin/providers.test.ts
# 改动前：offers the builtin presets ... 失败（expected [...] to not include 'kimi-coding'）
# 改动后：6 passed

corepack pnpm exec vitest run test/admin test/models test/tui test/config
# Tests 331 passed (331)

corepack pnpm run lint          # 通过，No fixes applied
corepack pnpm run check         # 通过（tsc、cli:check、admin-next check、docs:check）
corepack pnpm run admin:build && corepack pnpm run admin:test:e2e 08-models-adding
# 3 passed
git diff --check                # 无输出
```

本机全局 `pnpm` shim 指向未安装的 Node 26.3.0，以上命令经 `corepack pnpm` 运行。未运行完整 `pnpm test`（改动只在预设过滤一个函数，受影响套件已覆盖）；未做真实 Telegram 验收。

## 提交

```txt
37e41e77 Hide coding and agent plan providers from presets
```
