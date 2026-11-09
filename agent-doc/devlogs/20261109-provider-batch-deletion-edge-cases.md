# Surowan - 20261109 Provider 批量删除边界修复

## 背景

对 `2b9f171f Add atomic batch model deletion` 做代码审阅（open-code-review 加人工核对），发现两个边界问题：

- mixed-catalog builtin 供应商（Pi 目录同时包含多种适配器，当前受支持的有 OpenRouter、Fireworks、GitHub Copilot）不再作为新建预设提供，但已有别名仍可配置。删光这类别名的模型后，`semantics.ts` 对空列表不做任何逐模型校验，配置照常写入并热应用。随后 `providerWrite` 刷新 Providers view 时，`configuredBuiltinApi` 依赖 `models[0]` 推断 api，列表为空时返回 `null`，`listProviders` 因此抛出 `provider_unsupported`（422）。删除已落盘却报失败，之后 `GET /providers` 也持续 422，面板无法再为该别名补回模型。
- Providers 页的选择可以跨供应商、跨分页累计超过 200 个，但服务端 `MAX_MODELS_PER_REQUEST = 200`。“删除所选”按钮仍可点，确认后整批返回 `invalid_body`，重试永远不会成功。

## 主要变更

- `src/ingress/admin/providers/read.ts`：模型列表为空的 mixed-catalog 别名在 view 中显示 `openai-completions`，与 `builtinModelApi` 对目录外 gateway id 的取值一致，保证该别名可以列出、也可以补回模型。补回模型后 api 仍按首个模型的目录条目推导。

  ```ts
  const first = provider.models[0];
  if (first === undefined) {
    return 'openai-completions';
  }
  ```

- 前端新增 `MAX_MODELS_PER_DELETE = 200`（`apps/admin-next/src/lib/api/providers.ts`）。选中数量超过上限时禁用“删除所选”并提示减少勾选，不拆成多次请求，以保持整批原子删除。
- `ModelList` 的 `selectedModelsInUse: boolean` 改为 `deleteSelectedBlocked: string | null`。“模型在用”和“超过上限”两种原因共用同一按钮禁用逻辑和提示位置；页面用 if 分支计算原因，没有写成嵌套三元。新增中英文文案 `selectedModelsOverLimit`。
- `agent-doc/admin-panel.md` 的 Providers 页说明补充 200 上限的前端行为。

## 验证

```bash
pnpm exec vitest run test/admin/providers-delete-models.test.ts -t "mixed-catalog"
# 修复前：expected 422 to be 200，同时日志出现 config_reloaded applied="providers.mixed.models[anthropic/claude-haiku-4.5]"，复现了“已写入却报 422”。

pnpm exec vitest run test/admin/providers-delete-models.test.ts
# 修复后 11 passed。新用例：OpenRouter 别名删空后响应与 GET /providers 均为 200、api 为 openai-completions，
# 文件仅 models 变为 []，运行时模型列表清空；补回 anthropic/claude-haiku-4.5 后 api 为 anthropic-messages。

pnpm exec vitest run test/admin/
# 47 files / 203 tests passed。

pnpm run admin:build
pnpm run admin:test:e2e 08-models 16-model-health
# 25 passed。新用例凑出 201 个模型并全选，按钮禁用且提示可见，未发出删除请求；
# 取消一个后变为 Delete selected (200) 且可用。保存截图 batch-deletion-limit.png。
# 首次运行未重新构建，E2E 读取的是旧 dist/，新用例失败；admin:build 后通过。

pnpm run check
pnpm run lint
# 通过（lint 首次报 e2e 中的 noNonNullAssertion 警告，改为 batchModel() 构造后清零）。

git diff --check
git diff --cached --check
# 通过。
```

## 未执行

完整 `pnpm test`（改动限于 admin 模块）、真实 Electron、Docker、Safari / Firefox。

审阅中同时发现 `deleteProvider` 未检查 Tool Model 引用。该问题早于本次改动：`semantics.ts` 会拒绝该写入，不会丢数据，只是错误码不是 409，本次未处理。

## 提交

```txt
b71afb5677579dc9f812dd0ea5482fe275777186 Fix batch model deletion edge cases
```
