# Surowan - 20261111 模型昵称与命令展示收敛

## 背景

`/status` 与 `/model` 会直接显示 Provider 别名和模型 ID。部分 Provider 是供赞助者使用的中转服务，群友看到名称后会反复询问来源，解释成本很高。PRD 要求给模型条目增加可选 `nickname`，设置后命令只显示昵称，完全不暴露 Provider、模型 ID 与上游 `name`；未设置时保持现状，不做告警或拦截。昵称只影响展示，定位、切换与校验仍使用真实 `provider` / `model`。

## 主要变更

- `ModelConfigSchema` 增加可选 `nickname`（1–64 字符），Admin 写入复用同一 Schema；`configuredModel` 从 `src/platform/config/index.ts` 导出，供展示层读取条目。
- 新增 `src/platform/models/label.ts` 的 `modelDisplayLabel`：有昵称返回昵称，否则返回 `provider / model`。`/status`、`/model` 菜单头与切换回执、`/effort` 菜单头及两条错误回执都改走它，不再各自拼接。
- `AgentModelOption` / `AgentModelCatalogEntry` 增加可选 `nickname`；`listActiveTextModels` 与 `AgentModelSwitcher.list()` / `option()` 从配置条目透传。`/model` 列表行在有昵称时只输出 `序号. 昵称`，无昵称时保持 `序号. provider / model（name）`。
- 新增 `{{ agent.nickname }}` 模板变量；未设昵称时渲染 `provider / model`。`buildSystemPrompt` 与 doctor 的模板值都从配置补齐昵称，调用方零改动。只有模板真的引用该变量时 `systemPromptHash` 才会变化。
- Admin 模型编辑对话框新增昵称输入（`#model-nickname`），Draft 来源初始化为空串，保存时空串即省略该字段；中英文 locale 同步。Admin Panel 其它视图继续显示真实名称。
- 用户文档补充昵称配置、命令显示规则与模板变量；`agent-doc/configuration.md`、`telegram-agent-flow.md` 同步行为描述，实施计划移入 `agent-doc/design/archived/` 并登记索引。

## 验证

```bash
pnpm vitest run test/bot-commands test/models test/prompts
# 18 files / 95 tests passed，包含昵称列表行、切换与 default 回执、/status 两种模式、/effort 菜单与错误、switcher 透传、模板两条分支。

pnpm run admin:build
pnpm run admin:test:e2e 08-models
# 23 passed；08-models-editing 单独复跑 12 passed，含新增的昵称输入与 GET /providers 回读。

pnpm test
# 367 files / 1765 tests passed，445.49s。
# 首次全量运行仅 test/docs/examples.test.ts 失败：新增 jsonc 片段缺少模型必填字段；补齐后该测试 4 passed，并复跑全量通过。

pnpm exec biome lint .
pnpm exec biome format .
pnpm run check
# 通过；本 shell 的 `pnpm run lint` 被外部输出包装干扰，直接执行同一组 biome 命令确认无问题。

DOCS_BASE_PATH=/ pnpm run docs:build
DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build
DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 49 个 HTML/Markdown 页面与 161 个 HTTP 资源。

git diff --check
# 通过。
```

## 未执行

真实 Telegram 命令验收；真实 Provider 调用与 `doctor` 联网检查。

## 提交

```txt
23ed97a0d8ab0e9760efe6d9b0e824115d446a01 Add model nicknames to commands and prompts
```
