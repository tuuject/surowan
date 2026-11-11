# Surowan - 20261111 模型添加少确认、切换立即生效

## 背景

PRD `doc/design/20261107-model-selection.md` 指出三处不顺手的地方：从 Models.dev 匹配到元数据后，仍有大量字段要管理员逐一确认才能保存（中转站的模型 id 只要列在别的供应商名下，价格、上限、思考档位就全部要确认）；切换模型后，正在运行的 Invocation 会用旧模型跑完，新模型要等下一次会话；添加模型的弹窗要先点一下才会拉取列表，「使用临时 key 拉取」也没人用。另外希望 Models.dev 地址可配置、热更新，并在面板较深的入口修改。

改动前：`resolveModelDrafts` 把 `cross-provider` 与 `fuzzy` 来源都视为「猜的」，所有字段（含价格、名称以外）都进 `needs_confirmation`；缺失字段不填默认值。全局与 Chat 模型切换只写配置并热应用，运行中的 Invocation 继续用启动时快照。

## 主要变更

### 1. 元数据确认规则（`src/platform/models/metadata.ts`）

- 新增 `KEY_FIELDS = ['input', 'context_window', 'max_tokens']`，只有它们可能进入 `needs_confirmation`：值缺失、只有 `fuzzy` 匹配支撑，或 `max_tokens > context_window`。
- `cross-provider`（id 精确命中别的供应商）视为准确匹配到模型，上限、多模态、思考档位直接采用。
- 价格由 `resolveCatalogCost` 决定且从不需要确认：Provider 自己的列表价 → `exact` 命中且有价 → 同一模型各部署按字段取最高价（新来源 `models.dev-highest-price`；`fuzzy` 时在全部归一化命中里取）→ 0（新来源 `default`）。`matchModelsDev` 为此返回 `deployments`。
- `reasoning` 无任何来源时填 `false`、来源 `default`；前端在草稿列表与编辑弹窗提示「按不支持思考添加」，不阻止保存。

### 2. 「Fetch models」打开即拉取（`apps/admin-next/src/components/models/model-picker-dialog.tsx`）

发现改用 `useQuery`，key 带上每次打开的 `formKey`，`enabled: open && mode === 'discover'`，迟到的响应落在没人读的旧 query 上；收到新列表时在渲染期按 `dataUpdatedAt` 替换草稿（沿用文件里已有的 adjust-state-during-render 写法，不加 `useEffect`）。临时 key / header 输入与切换按钮删除，只留「Fetch again」。新建 Provider 向导仍用临时模式（Provider 尚未保存）。前端 `isDraftFieldUnconfirmed` 只认服务端的 `needs_confirmation`。

### 3. `models_dev.api_url`

- `ConfigSchema` 新增可选 `models_dev: { api_url? }`，`validateSemantics` 用 `validateEndpoint`（允许 query）校验；`models_dev`、`models_dev.api_url` 进热更新白名单。
- `discover` / `lookupMetadata` 每次从运行中快照读地址（`modelsDevUrl`）。`loadModelsDevCatalog` 的缓存改为按地址分开的 Map，换地址下一次查询即生效，换回默认不会重新下载；过期条目在写入时清理。
- `GET/PUT /developer` 增加 `models_dev_url`（`null` 删除整个 `models_dev` 节）、`active_models_dev_url`、`default_models_dev_url`；Developer 页底部新增「Model details source」面板。

### 4. 切换模型立即生效（`src/ingress/admin/model-switch.ts`）

- `invocationsLeavingModel(orm, before, after, { excludeConfigHash })`：对每个 running Invocation 用 `resolveInvocationPolicy` 在切换前后各解析一次生效模型，不同才算受影响。全局切换因此不影响有独立覆盖的 Chat，只改 thinking 不触发。
- `PUT /model` 与 `PUT /chats/:id` 有受影响的 Invocation 且未带 `abort_running: true` 时返回 409 `model_in_use` + `running_invocations`，不写文件（`PUT /model` 在 revision 过期时先报 `config_conflict`）。带上后先 `writeAndApply`，再由 `abortInvocationsLeavingModel` 重新计算（排除已在新快照上启动的 run）并以 `model_switched` 中止，响应带 `aborted_invocations`。
- 已消费的批次随 run 以 `aborted` 关闭、不再回复也不重试；附着但未注入的批次走原有释放路径回队列，由新模型处理；长期任务不动。Context 不迁移，超出新模型预算时沿用 `ConversationContextStore.open` 的 `context_window` 重建。
- 前端新增 `ModelSwitchConfirmDialog`，Models 页保存（`saveRoles` 增加 `abortRunning`）、Providers 页「Use as Agent」、Chats 编辑弹窗三处在 `model_in_use` 时弹出，确认后带 `abort_running` 重发，取消则不保存。
- `control` 路由的依赖新增 `configStore`。Telegram `/model` 命令不在范围内，行为不变。

### 5. 文档与客户端说明

`agent-doc/admin-panel.md`（新增「模型切换立即生效」节，更新发现、确认规则、Developer 端点）、`agent-doc/configuration.md`、用户手册（`configure/models.md`、`guides/per-chat.md`、`configure/admin-developer.md`、`reference/config.md`）、`packages/admin-surface` 三条 summary、`skills/surowan-mcp` 与 `skills/surowan-utils` 的写操作说明同步。

## 验证

```bash
git diff --check
pnpm exec biome lint . && pnpm exec biome format .
pnpm run check
# 通过（runtime / cli / admin-next / docs）。本 shell 的 `pnpm run lint` 被外部输出包装干扰，直接执行同一组 biome 命令。

pnpm vitest run test/models test/admin/models-dev-source.test.ts test/admin/model-switch.test.ts test/admin/chats
# 全部通过。model-switch 用真实 BucketScheduler：拒绝时文件不变、run 仍 running；确认后 run 以 model_switched 中止，
# 开场 Bucket 为 aborted，附着未注入的 Bucket 由新 Invocation 接手且其快照解析为新模型；全局切换不中止有独立覆盖的 Chat。
# models-dev-source：两次改地址各下载一次镜像，清空后回到已缓存的默认目录且不再联网。

pnpm test
# 369 files / 1770 tests passed，542.26s（在 Chat 路由 abort_running 一致性小改之前运行；改后复跑 test/admin/model-switch 与 test/admin/chats*，7 files / 25 tests passed）。

pnpm run admin:build
pnpm run admin:test:e2e
# 290 passed。新增 08-models-switch（三个入口的确认 / 取消）、10-developer 地址往返；08-models、08-models-adding 改为打开即拉取、只对缺失关键字段确认。

DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两种 base 均通过，各验证 50 个 HTML/Markdown 页面与 164 个 HTTP 资源；构建后无额外文件改动。
```

## 未执行

真实 Telegram 群聊中切换模型的验收；真实 models.dev 与真实 Provider 的联网拉取。`configure` TUI 向导仍固定使用默认 models.dev 地址，未读取 `models_dev.api_url`。

## 提交

```txt
f40ed6a12e486d939c62cd5e0cf322e746667d3d Apply model switches immediately and simplify model metadata matching
```
