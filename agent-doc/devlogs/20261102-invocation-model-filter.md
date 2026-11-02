# Surowan - 20261102 Invocation 按 agent 模型过滤

## 背景

审计 Invocation 时只能按 `state`、`host`、`chat`、公开消息关键词与时间收窄，无法回答「某个模型在一段时间里表现如何」。`model_calls` 已经逐次记录 `provider`/`model`，但列表端点没有把它变成过滤条件，建立模型基线只能翻详情逐条抄。

约束有三点：

- 一个 Invocation 可能同时有 `agent`、`vision_chat`、`vision_sticker` 与 `tool` 调用，模型可以不同。用户要的是「这次运行实际用的模型」，也就是 `role = 'agent'` 那一类。
- 模型 ID 由 Provider 原样定义（`vendor/model` 这类含斜杠、点号、大小写混合的形式），不能被收窄成 token 形状，也不能做模糊匹配。
- 列表是 keyset 分页且每行已有多个统计子查询，新条件必须复用 `model_calls_invocation_idx`，不能引入全表扫描。

## 主要变更

### 1. 服务端过滤条件

`ListQuery` 新增可选 `model`（`src/ingress/admin/audit/shared.ts:26`），`listQuery` 读取 `?model=`（`src/ingress/admin/http.ts:155`），`listInvocations` 在 `chat` 之后追加条件（`src/ingress/admin/audit/invocations.ts:75`）：

```ts
const model = optionalFilter(query.model);
if (model !== undefined) {
  if (model.trim().length === 0 || model.length > MAX_MODEL_FILTER_LENGTH || /\p{Cc}/u.test(model)) {
    throw new AdminQueryError(
      'invalid_model',
      `model must be 1 to ${MAX_MODEL_FILTER_LENGTH} characters without control characters`,
    );
  }
  // The agent model is what the invocation actually ran on; vision and
  // auxiliary calls belong to other models and never make a row match.
  conditions.push(
    sql`EXISTS (SELECT 1 FROM model_calls mc WHERE mc.invocation_id = i.id AND mc.role = 'agent' AND mc.model = ${model})`,
  );
}
```

空串与 `null` 走 `optionalFilter` 的「没有过滤」语义，保持旧响应形状；超过 256 字符、纯空白或含控制字符返回 400 `invalid_model`。比较是精确且区分大小写的字符串相等，`%`/`_` 不参与任何 LIKE 语义。

`EXISTS` 子查询按 `invocation_id` 关联，命中现有的 `model_calls_invocation_idx`；没有为本次过滤新增迁移或索引。`test/schema/index-plans.test.ts` 在 fresh 与 upgraded 两种数据库上断言实际列表 SQL 的查询计划没有 `SCAN mc`，同时覆盖「按模型过滤仍返回正确行集」。

### 2. CLI

`invocation list` 接受 `--model <id>`（`packages/cli/src/args/commands.ts:210`），本地校验复用与 replay 覆盖相同的边界（`packages/cli/src/args/values.ts:223`）：

```ts
export function parseModelFilter(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text.trim().length === 0 || text.length > MAX_MODEL_LENGTH || /\p{Cc}/u.test(text)) {
    throw usageError('invalid_model', `model must be 1 to ${MAX_MODEL_LENGTH} characters without control characters`);
  }
  return text;
}
```

`--provider` 与 `--thinking-level` 在 list 上仍然拒绝（`unexpected_option`），避免把「过滤历史模型」误读成「临时覆盖模型」。`runList` 把值原样放进查询串（`packages/cli/src/commands.ts:83`），不做大小写或路径转义以外的改写；`--help` 与 usage 同步。

### 3. Admin Panel

Invocations 页新增 Model 文本框（`apps/admin-next/src/pages/invocations.tsx:140`），沿用 `TextFilter` 的显式提交语义：输入后按 Enter 或搜索按钮才应用，X 清除。`ListFilters` 增加 `model`，`listPath` 的白名单键列表加上 `model`（`apps/admin-next/src/lib/api/core.ts:93`），因此它与 State、Host、Chat 一样进入查询键，切换即重置分页。en/zh 两个 locale 各加 `modelPlaceholder`。

### 4. 测试与文档

- `test/invocations/model-filter.test.ts`：只命中 `role = 'agent'`；视觉与 Tool Model 调用不算；精确且区分大小写（`gpt-4.1-mini`、`openai/gpt-4.1`、大写变体都不匹配）；与 `chat`/`state` 取交集；空值不过滤；超长/纯空白/控制字符返回 `invalid_model`；查询不写审计表。
- `test/cli/inspection-preflight-list.test.ts`：`--model` 与其他过滤一起原样转发，边界长度 256 可用。
- `test/cli/inspection-guards.test.ts`：空值、纯空白、超长、换行在发请求前以退出码 2 拒绝；`--provider`/`--thinking-level` 仍是 `unexpected_option`。
- `test/admin/audit.test.ts`：`GET /api/invocations?model=` 命中/不命中与 400 `invalid_model`。
- `apps/admin-next/e2e/02-lists-filters.e2e.ts`：真实后端下 Model 输入把列表收窄到两条有 agent 调用的种子行，未知模型显示空状态。
- 文档：`agent-doc/admin-panel.md`（过滤语义）、`agent-doc/verification.md`（测试行与命令）、CLI README/REFERENCE、`skills/surowan-utils` 的入口与 `references/invocations.md`、用户指南 `apps/docs/content/docs/configure/admin.md` 与 CLI 参考页。

## 验证

```bash
pnpm test
# 352 passed | 1 skipped（353 个测试文件）；1961 passed | 8 skipped（1969 个用例）

pnpm test test/invocations test/admin/audit.test.ts test/cli
# 24 files，153 passed | 6 skipped

pnpm test test/invocations/model-filter.test.ts test/invocations/search.test.ts test/schema/index-plans.test.ts
# 21 passed（重构后复跑）

pnpm run lint
# biome lint + format 通过（1169 / 1166 个文件）

pnpm run check
# tsc（runtime / cli / admin-next / docs）通过

pnpm run admin:build && pnpm run admin:test:e2e 02-lists-filters
# 22 passed（含新增 model filter 用例）
pnpm run admin:test:e2e 01-routes
# 23 passed

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, search, examples, schema, provenance and 116 HTTP resources (base /)
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# Verified 34 HTML/Markdown pages, ... 116 HTTP resources (base /surowan/)

git diff --check
# 无输出
```

真实 CLI 对本地桩服务冒烟（`node packages/cli/src/bin.ts`），实际发出的请求与退出码：

```txt
GET /api/invocations?state=completed&model=deepseek%2Fdeepseek-v4-flash   exit 0
{"error":"invalid_model","message":"model must be 1 to 256 characters without control characters"}   exit 2
```

未执行：真实 Provider 下跨模型的基线对比（本次只交付筛选能力，聚合仍是查询侧的工作）、生产规模数据库上的查询耗时观察。

## 已知限制

- 只匹配 `role = 'agent'`：只看视觉或 Tool Model 用量的行不会出现在结果里，这是有意的语义，不是漏匹配。
- 不支持前缀/模糊匹配，也没有模型下拉；模型 ID 需要精确输入，`models list` 只给当前 active 配置，不代表历史出现过的模型集合。
- 没有新增索引。当前 `(invocation_id)` 索引足以支撑相关子查询；如果按模型过滤成为高频入口且库很大，再评估 `(role, model)` 索引。

## 提交

```txt
3f2f6fe Filter invocations by agent model
```
