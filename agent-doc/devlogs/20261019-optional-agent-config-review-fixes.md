# Plastic Wan - 20261019 `agent` 可选化的审查修复

## 背景

`82eae7a` 把 `agent` 配置段改成全字段可选（见 `agent-doc/devlogs/20261019-optional-agent-config.md`）。随后用 open-code-review（`ocr review --commit 82eae7a`）审查该提交，得到 12 条意见：1 high、9 medium、2 low。逐条对照源码核实后，修复全部 high 与 medium；两条 low（全局三元组不全时 warning 措辞忽略了 Chat 覆盖、`invocation-queue` 跳过原因三元表达式的嵌套）未处理。

这些问题有同一个根源：段可以缺省、可以为 `null`、内部对象可以只写一部分以后，写入、热更新分类、Admin 视图和前端表单里仍有一些地方默认「段与三元组总是存在」。

## 主要变更

### 1. 全局无 Prompt 文件时保存 group prompt 被拒（high）

`src/ingress/admin/prompts-admin.ts`：全局没有 `system_prompt_file` 时，函数开头会把 `creationRelative` 设为 `prompts/agent.md`。group 分支换成群已有的 `instructions_file` 时没有清掉它，于是走到「仅创建时」的 `fileExists` 检查，对群自己的文件回 409 `prompt_file_exists`。现在选中已有群文件时一并清空：

```ts
if (fileChat !== undefined && fileChat.instructions_file !== undefined) {
  // The global creation state does not carry over to an existing group file.
  creationRelative = undefined;
  promptPath = resolve(configDir, fileChat.instructions_file);
}
```

### 2. `daily_budget` 内层字段可选

`src/platform/config.ts`：`daily_budget` 存在时 `max_tokens` 仍是必填，导致 `agent: { daily_budget: {} }` 过不了 schema。Harness 页写 `{"daily_budget.max_tokens": null}` 复位时，jsonc-parser 只删叶子，文件里留下 `"daily_budget": {}`，整文件校验同样失败。改为可选后两处一起解决，`resolveAgentSection` 本来就会回退到 `AGENT_DEFAULTS.daily_budget.max_tokens`：

```ts
daily_budget: Type.Optional(Type.Object({ max_tokens: Type.Optional(PositiveInteger) }, Strict)),
```

### 3. `agent: null` 下的嵌套写入

jsonc-parser 的 `modify` 无法在 `null` 节点下添加属性（实测抛 `Can not add index to parent of type null`），所以文件是 `agent: null` 时，Harness 写入和全局 Prompt 创建（`['agent', 'system_prompt_file']`）都会失败。修复放在共享写入口 `writeConfigEdits`（`src/adapters/local-monolith/config-file.ts:43`）：设值前沿路径把值为 `null` 的父节点先替换成 `{}`。所有配置写入都经过这里，不必在各调用方分别处理。

```ts
function replaceNullParents(text: string, path: JSONPath): string {
  let result = text;
  for (let depth = 1; depth < path.length; depth += 1) {
    const prefix = path.slice(0, depth);
    const tree = parseTree(result, [], { allowTrailingComma: true });
    if (tree !== undefined && findNodeAtLocation(tree, prefix)?.type === 'null') {
      result = applyEdits(result, modify(result, prefix, {}, { formattingOptions: FORMATTING }));
    }
  }
  return result;
}
```

### 4. 整个可选对象增删的热更新分类

`src/platform/config-diff.ts`：`HOT_PREFIXES` 只匹配 `agent.context.` 和 `agent.rate_limits.` 下的子路径，`HOT_PATHS` 也只列了 `agent.daily_budget.max_tokens`。以前这几个对象必填，只会在叶子路径上产生变化；改成可选后，「整段新增或删除」落在父路径 `agent.context` 等上，被判为 `restart`，候选配置保留旧值，直到重启。整段 `agent` 被删成 `null` 时，这些父路径也记成 restart，但候选实际已经删掉了它们，前后不一致。现在把 `agent.daily_budget`、`agent.context`、`agent.rate_limits` 加入 `HOT_PATHS`。`agent` 段内其余字段本来都是 hot，所以 `null` 分支不需要再改。

### 5. Admin Chats 视图的 `null` 契约

`src/ingress/admin/chats-admin.ts:197`：`resolveAgentSettings()` 会直接省略缺失的键，`agent: {}` 时 `defaults`、`effective` 序列化为 `{}`，不符合前端 `AgentModelReference` 的 `string | null` 契约：前端 `thinking_level !== null` 会把缺失当成已配置，标签显示 `undefined / undefined`。新增 `agentSettingsView`，三个字段统一 `?? null`，和 `listProviders()` 的做法一致。

### 6. 前端与 TUI

- `apps/admin-next/src/pages/chats.tsx`：全局三元组不全、Chat 选「继承」时，`selected` 为 `undefined`，校验会拒绝所有保存。现在只有生效配置写出了 thinking 档位时才检查模型是否支持；继承出来的不完整配置照常保存，结果是一个不开 Invocation 的合法 Chat。显式选了模型但模型不在列表里时仍然拒绝。
- `apps/admin-next/src/components/models/in-use-panel.tsx`：provider/model 缺失时显示 `Not configured`。thinking 档位未设时用占位 `Not set`，不再显示成 `off`。只支持单一档位的模型在未设档位时，选择器也不禁用，可以把缺的档位补上。新增 locale 键 `models.models.inUse.notConfigured` / `levelUnset`（en、zh-CN）。
- `apps/admin-next/src/components/models/tool-model-panel.tsx`：继承的档位为空时，初始档位取所选模型支持的第一个，而不是可能被拒绝的 `off`。所选档位不在模型支持列表里时，保存按钮禁用。
- `src/tui/configure.ts`：没有可解析的模型时始终提供全部 thinking 档位。原逻辑选过一次之后只剩当前那一档，以后改不回来。为测试导出了 `agentThinkingLevels`。

## 测试

新增 9 条，每条对应上面一个修复：

- `test/prompts-admin.test.ts`：无全局 Prompt 文件时保存已有 group prompt 成功，且不写入 `prompts/agent.md`。
- `test/optional-agent.test.ts`：`daily_budget: {}` 合法并解析出默认预算。
- `test/admin-harness.test.ts`：复位唯一的预算字段后回到默认值；`agent: null` 下写入会创建出这个段。fixture 新增可选 `transform`。
- `test/config-diff.test.ts`：整对象增删都是 hot，候选配置跟着变化；整段改成 `null` 不会留下 restart 项。
- `test/admin-chats.test.ts`：`agent: {}` 时 `defaults` / `effective` 为显式 `null`。fixture 新增可选 `transform`。
- `test/tui-configure.test.ts`：无模型时选过档位仍可选全部档位。

先撤掉源码修复跑一次：除 `tui-configure` 外（它依赖新导出），7 条新增测试全部失败，复现了原故障；恢复修复后全部通过。

## 验证

```bash
pnpm run check
# tsc --noEmit（src + cli + admin + docs）通过
pnpm run lint
# biome lint + format 通过
git diff --check
# 无输出
pnpm test
# Test Files 115 passed (115) / Tests 1454 passed (1454)
pnpm run admin:build
pnpm run admin:test:e2e 01-routes 08-models 09-chats 18-tool-model 15-prompts 19-harness
# 51 passed
```

未覆盖：前端「未配置」状态没有对应的 e2e 用例。e2e 夹具配置始终写全三元组，这部分前端改动目前只有类型检查和上面受影响套件的回归保护。

## 提交

```txt
4990561 Fix optional agent config edge cases from review
```
