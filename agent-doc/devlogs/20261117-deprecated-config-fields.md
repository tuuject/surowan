# Surowan - 20261117 三个旧配置字段改为软废弃

## 背景

同一个 PR 里的上一篇日志（`20261117-serve-retention-config-cleanup.md` 第 3 节）把 `agent.memory_ttl_warning_days`、`agent.send_empty_text_fallback_enabled` 与 `vision.background_sticker_concurrency` 从 Schema 里删掉了。配置 Schema 是严格的，未知字段会被拒绝，所以还写着这些键的实例升级后会直接启动失败；示例配置以前自带 `background_sticker_concurrency: 1`，受影响的部署不会少。

用户在审 PR 时改了决定：升级不应该让实例起不来。要求是软废弃：字段仍然有效但可选，完全不起作用，标记为已废弃；管理面板显示常态警告；启动时在命令行输出警告。

本篇记录这次修正，取代上一篇第 3 节「删除三个兼容字段」的结论；上一篇其余内容（`serve` 内置保留清理、迁移前副本轮换、删除一次性脚本）不受影响。

仓库里已有一个做法完全相同的先例 `mcp.servers[].required`，这次照它的结构实现，没有另造机制。

本次改动由 Devin（`swe-2-high`，同一个 T3 子线程 `surowan-audit-epic-e2-retention-config-scripts-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. 字段回到 Schema，带废弃标注

`src/platform/config/schema-sections.ts`，类型与原来一致：

```ts
    memory_ttl_warning_days: Type.Optional(
      Type.Integer({
        minimum: 1,
        deprecated: true,
        description: 'Deprecated: still accepted but has no effect; remove the field.',
      }),
    ),
```

`scripts/docs/prepare.ts` 新增对 `deprecated: true` 的渲染，生成的字段参考页在这三个字段下输出「**已废弃**：字段仍被接受但无任何效果，请删除。」

### 2. 一处定义，两种警告

新增 `src/platform/config/deprecated.ts`，`DEPRECATED_CONFIG_FIELDS` 是废弃字段的唯一清单（路径，以及有替代写法时的提示），`deprecatedConfigFields(file)` 返回配置里实际出现的那些。

- **加载警告**：`validateFileConfig` 把出现的字段写进 `warnings`。`check-config` 在输出的 `warnings` 数组里打印它，`serve` 启动时把同一个数组记成 `config_warnings` 日志事件。
- **面板常态警告**：`assembleRawConfig` 把出现的字段路径放进 `RawConfig.deprecated_fields`，`standingWarnings` 据此给出新警告码 `config_fields_deprecated`（`standing`、`developer`、`warning`）。常态警告每次读取时按当前生效的配置推导，不落库，字段删掉并应用后就消失。面板卡片列出字段路径，出现旧兜底开关时多显示一行替代写法，四个 locale 都有文案。

### 3. 完全不起作用

`resolveAgentSection` 在展开文件配置前先把两个 agent 废弃键剔掉，`resolveVisionSection` 不读 `background_sticker_concurrency`，所以它们不会出现在运行时类型、`configurationView` 或 Harness 页里。

**行为变化**：`send_empty_text_fallback_enabled: true` 不再等价于 `send_empty_text_strategy: "random_text"`。没有显式写策略的实例，空文本发送会从「随机兜底」变回默认的 `reject`。加载警告、面板卡片与升级说明都写明了替代写法。

### 4. 热应用

三个路径在 `src/platform/config/diff-merge.ts` 里归为热字段：增删它们不要求重启，除了警告之外不改变任何东西。

### 5. 文档

`apps/docs/content/docs/operations/upgrade.md` 的条目从「升级前必须删掉，否则启动失败」改为「被接受、被忽略、会警告，建议删掉」，并写明上面的行为变化。`agent-doc/configuration.md` 新增废弃字段机制的说明，`agent-doc/admin-panel.md` 的常态警告列表加上新警告码。

## 验证

按用户的固定做法，修正轮不再跑 AI review，由主会话读 diff 并复验。

主会话亲自运行（在子 agent 的 checkout 内，Windows）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test test/config/boundary.test.ts test/config/reload.test.ts test/admin/harness.test.ts test/warnings.test.ts   # 连跑 3 次
# 每次 4 files / 51 tests passed

pnpm test
# Test Files  1 failed | 407 passed | 1 skipped (409)
# Tests  1 failed | 2024 passed | 9 skipped (2034)
# 唯一的失败是 test/recurring-alarms/schedule.test.ts 的 Windows 路径断言，基线上同样失败

DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_SITE_ORIGIN=https://docs.example.com DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 两次都是 Verified 53 HTML/Markdown pages ... 173 HTTP resources
# 生成的 fields-agent.md 里「已废弃」出现 2 次，fields-vision.md 里 1 次

pnpm run admin:build
pnpm --filter surowan-admin-next exec playwright test 04-writes --repeat-each 5
# 60 passed（含新的常态警告用例 ×5）

pnpm run admin:test:e2e
# 329 passed, 1 failed：31-sticker-sets.e2e.ts:46
pnpm --filter surowan-admin-next exec playwright test 31-sticker-sets --repeat-each 8
# 24 passed

git diff --cached --check && node scripts/file-token-limit.ts
# 无输出
```

全量 e2e 里失败的那一条是 `31-sticker-sets` 的「Sticker set added」toast 断言：用例先后两次添加同一个贴纸集，第一条 toast 还没消失时第二条出现，定位器匹配到两个元素。本次没有改动贴纸集相关的任何文件，单独重跑 8 遍全部通过，此前五次全量 e2e 也都通过，判断为已有的时序不稳定，没有在这里处理。

用示例配置加上三个废弃键跑 `check-config`：

```txt
{"status":"ok", ... ,"warnings":["deprecated configuration fields have no effect and should be removed: agent.memory_ttl_warning_days, agent.send_empty_text_fallback_enabled, vision.background_sticker_concurrency; agent.send_empty_text_fallback_enabled: set agent.send_empty_text_strategy to \"random_text\" to keep the old fallback behaviour"],"image_enabled":true}
```

未执行：

- 没有单独启动 `serve` 去看 `config_warnings` 日志行；它打印的是 `check-config` 用的同一个 `warnings` 数组，代码路径本次未改。
- 面板卡片只在英文 locale 下做了浏览器断言，其余三种语言只有键值齐全的类型检查。
- `doctor`、真实 Telegram 验收未跑。

## 提交

```txt
ef69c368 Keep the three legacy config fields as deprecated no-ops
```
