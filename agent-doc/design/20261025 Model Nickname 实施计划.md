# 20261025 Model Nickname 实施计划

产品意图以 [`doc/design/20261025-model-nickname.md`](../../doc/design/20261025-model-nickname.md)（用户已审核的 PRD）为准。本文是 AI 直出的实施文档，把 PRD 落到具体文件、函数与验收上；与 PRD 冲突时以 PRD 为准，判断当前行为仍以源码为最终事实。

## 1. 目标与不变量

- 模型条目新增可选 `nickname`。设置了昵称时，`/status`、`/model`、`/effort` 的命令输出只显示昵称，不显示 Provider 别名、Model ID，也不显示括号里的上游 `name`。
- 未设置昵称时保持现状行为（`provider / model`）。**不做告警、不做拦截、不做合成标号**：是否给模型设昵称由运维自行决定。
- `/model` 交互不变：列表 → `/model 序号` 切换，`/model page 页码` 翻页，`/model default` 清除本群覆盖；不支持按名称或昵称切换。
- 新增 prompt template 变量 `{{agent.nickname}}`，供运维在 global / group prompt 里约束模型自述身份。厂商级系统提示词与模型自带身份认知不处理（out of scope）。
- `/effort` 展示的该模型支持的思考强度列表（`supported`）与昵称无关，输出格式不变。

## 2. 现状与落点

| 需要改的地方 | 现在 | 文件 |
| --- | --- | --- |
| 模型配置字段 | 无 `nickname`，`Strict` 对象 | `src/platform/config/schema-model.ts:85` |
| `/status` 模型标签 | `${provider} / ${model}` | `src/orchestration/bot-commands/status.ts:76-79` |
| `/model` 菜单头 + 列表行 | 各自拼 `provider / model` | `src/orchestration/bot-commands/config.ts:301-315` |
| `/model` 切换 / default 回执 | 直接拼 `provider / model` | `src/orchestration/bot-commands/config.ts:146,149` |
| `/effort` 菜单头 | 直接拼 `provider / model` | `src/orchestration/bot-commands/config.ts:265` |
| `/effort` 错误回执 | 直接拼 `provider / model` | `src/orchestration/bot-commands/config.ts:195,207` |
| 可用模型列表条目 | `AgentModelOption` / `AgentModelCatalogEntry` 没有昵称字段 | `src/platform/models/switch.ts:14-32` |
| 配置条目查找 | `configuredModel()` 是私有函数 | `src/platform/config/index.ts:177-183` |
| Prompt 模板变量 | 只有 `agent.{provider,model}`、`vision.*`、`timezone` | `src/platform/prompt-template.ts:6-18` |
| 模板值构造 | 两处：Invocation 路径与 doctor | `src/context/builder/index.ts:208`、`src/doctor.ts:57` |
| Admin 模型表单 | 有 `id` / `name` 输入，无昵称 | `apps/admin-next/src/lib/model-form.ts`、`apps/admin-next/src/components/models/model-edit-dialog.tsx` |
| 用户文档 | 列出的模板变量没有昵称 | `apps/docs/content/docs/guides/personality.md:26` |

## 3. 实施步骤

### 3.1 Schema

`src/platform/config/schema-model.ts` 的 `ModelConfigSchema` 加：

```ts
nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
```

- 长度上限 64 与 `/model` 列表行宽兼容；不设唯一性校验。
- `Strict` 对象已声明 `additionalProperties: false`，字段必须显式加进来，否则 Admin 写入与配置文件校验都会失败。
- Admin 写入路径复用同一 Schema（`src/ingress/admin/providers/index.ts:35,52` 的 `ModelConfigSchema`），无需另改校验。

### 3.2 共用一个标签函数

新建 `src/platform/models/label.ts`（按仓库目录组织规则，模型子系统已是目录，入口仍为 `switch.ts`，标签是独立小模块）：

```ts
export function modelDisplayLabel(
  config: { readonly providers: FileConfig['providers'] },
  provider: string,
  modelId: string,
): string {
  return configuredModel(config, provider, modelId)?.nickname ?? `${provider} / ${modelId}`;
}
```

- 需要把 `src/platform/config/index.ts` 的 `configuredModel` 导出（从私有函数改为 `export function`），避免第二份配置遍历。调用方：`label.ts` 与本步骤的 prompt 值构造。
- 只接受已加载的 `RawConfig`；不读 registry、不发网络请求。

### 3.3 模型目录条目带昵称

`src/platform/models/switch.ts`：

- `AgentModelCatalogEntry` 与 `AgentModelOption` 各加 `readonly nickname?: string`。
- `listActiveTextModels()` 在 `candidate` 循环里读 `snapshot.config.providers[alias]?.models`，按 `candidate.id` 找到条目并带上 `nickname`；`exactOptionalPropertyTypes` 下用条件展开，不要写 `nickname: undefined`。
- `AgentModelSwitcher.list()` / `option()` 同步透传。

注意：`candidate` 来自 Pi 的注册表，**不带**配置文件里的自定义字段，昵称只能走配置读取。

### 3.4 命令输出

- `status.ts:76-79`：`modelLabel` 改用 `modelDisplayLabel(config, effective.provider, effective.model)`，`（继承全局）` 后缀逻辑不变。
- `config.ts:289-319` 的 `modelMenu`：
  - 菜单头同样用 `modelDisplayLabel`。
  - 列表行：有昵称时输出 `${index + 1}. ${nickname}`，无昵称时**完全保持现状** `${provider} / ${model}（${name}）`。不要输出「昵称（真名）」这种混排。
- `config.ts:146`：切换成功回执用 `modelDisplayLabel`；`config.ts:149` 的 `/model default` 回执同理。
- `config.ts:265`：`effortMenu` 的「本群模型」行改用 `modelDisplayLabel`；该函数目前收 `provider` / `modelId`，补传 `config` 或改为直接在调用处传已算好的标签，二选一但不要复制拼接逻辑。
- `config.ts:195,207`：`/effort` 两条错误回执改用同一标签。

`config.ts` 里三个命令都要用 `deps.configStore.current().config`；注意 `switchChatModel` 在写入后重新读了一次 `current()`（`config.ts:143`），回执要用**重新读取**的那份，否则昵称在同时热重载时会读到旧值。

### 3.5 Prompt 模板变量

`src/platform/prompt-template.ts`：

```ts
export interface PromptTemplateModel {
  readonly provider: string;
  readonly model: string;
  /** Display nickname; absent means "not configured". */
  readonly nickname?: string;
}
```

- `TEMPLATE_VALUES` 加 `'agent.nickname': (values) => values.agent.nickname ?? \`${values.agent.provider} / ${values.agent.model}\``，未设昵称时渲染 `provider / model`，与命令显示规则一致。
- `validatePromptTemplate` 会自动接受新 key（走同一张表），无需另改校验。

模板值构造的两个入口都要填昵称：

- `src/context/builder/index.ts:208`：`buildSystemPrompt` 目前从调用方拿 `agentModel: PromptTemplateModel`。**不要**给三处 caller（`agent-runtime/run.ts:61`、`replay/prepare.ts:76`、测试 fixture）都加参数；改为在 `buildSystemPrompt` 内部用 `configuredModel(config, agentModel.provider, agentModel.model)?.nickname` 补齐，`config` 本来就在参数里。这样 `PromptTemplateValues.agent` 的类型仍是 `PromptTemplateModel`，调用方零改动。
- `src/doctor.ts:57`：`renderDoctorAgentPrompt` 已有 `config`，同样补 `nickname`；未配置时仍是 `unconfigured`。

影响面提醒：`systemPromptHash` 由渲染后的整段 prompt 计算（`builder/index.ts:255`）。**只有**运维在模板里真的写了 `{{ agent.nickname }}` 时哈希才会变（并触发 Context 重启）；只加字段不改模板不影响任何已有部署。验证时确认这一点。

### 3.6 Admin Panel

- `apps/admin-next/src/lib/api/providers.ts` 的 `ProviderModelConfig` 加 `readonly nickname?: string`。
- `apps/admin-next/src/lib/model-form.ts`：
  - `ModelFormState` 加 `readonly nickname: string`。
  - `emptyModelForm` / `modelFormFromConfig` / `modelFormFromDraft` 三处都要初始化（draft 来源没有昵称，填空串）。
  - `modelFormToConfig`：`...(form.nickname.trim().length === 0 ? {} : { nickname: form.nickname.trim() })`，与现有 `name` 的写法一致。
  - 不需要新的 `ModelFormErrors` 字段：空串即「不设置」，超长由后端 Schema 拒绝；若前端要即时提示，加 `nickname?: string` 并在 `errors` 里按 64 校验，属于可选增强。
- `apps/admin-next/src/components/models/model-edit-dialog.tsx`：在 `model-name` 之后加 `model-nickname` 输入，label 走 locale。
- locale：`apps/admin-next/src/locales/{en,zh-CN}/pages/models.ts` 各加一个 key（跟随现有 `models.models.edit.name` 命名，例如 `models.models.edit.nickname`），中英文都要加，否则 e2e 页面文案断言会失败。
- Admin 其他视图继续显示真实 Provider / Model 名称（`src/ingress/admin/chats.ts:427-436` 的 `models[]`、`src/ingress/admin/control.ts:59-62` 的 current）：这些是运维界面，不改。

`mergeProviders`（`src/platform/config/diff-providers.ts:67`）用 `deepEqual` 比较整个模型条目，新增字段自动进入热更新判断，无需改动。

### 3.7 用户文档

- `apps/docs/content/docs/guides/personality.md:26`：模板变量清单加 `{{ agent.nickname }}`，并说明未设昵称时渲染 `provider / model`、可用于约束模型自述身份。
- `apps/docs/content/docs/configure/models.md`：说明模型条目可选 `nickname`，以及它对 `/status`、`/model`、`/effort` 输出的影响。
- `apps/docs/examples/config.example.jsonc`：不必加（可选字段），如需示例就加在一个已存在的模型条目上。
- 改完跑 `pnpm run docs:build` 与 `pnpm run docs:verify`（`DOCS_BASE_PATH=/` 与 `/surowan/` 各一遍），结束确认 `git status --porcelain` 为空。

## 4. 测试

### 4.1 必改（现有断言写死真名）

| 文件 | 断言 |
| --- | --- |
| `test/bot-commands/service-model.test.ts` | `1. agent / agent-model（Agent Model）`、`本群模型: agent / agent-model（继承全局）`、切换与 default 回执共 12 处 |
| `test/bot-commands/service-effort.test.ts` | `本群模型: agent / agent-model`、`本群模型: vision / vision-model` 等 |
| `test/bot-commands/service.test.ts` | `/status` 的 `本群模型: agent / agent-model（继承全局）` 等 |
| `test/bot-commands/service-admin.test.ts` | 只断言含「本群模型」，无需改 |

### 4.2 必加

- `test/bot-commands/service-model.test.ts`：给 fixture 的某个模型设 `nickname`，断言
  - 列表行只出现昵称，**不出现** `provider`、`model`、上游 `name`；
  - 菜单头与切换回执只出现昵称；
  - 未设昵称的模型仍输出 `provider / model（name）`；
  - `/model 序号` 在有昵称时仍按列表位置切换（昵称不影响序号）。
- `test/bot-commands/service-effort.test.ts`：昵称生效时菜单头与不支持级别的错误回执都不含真名；`可选:` 行保持原样。
- `test/bot-commands/service.test.ts`：`/status` 在本群覆盖与继承全局两种情况下都显示昵称。
- `test/models/switch.test.ts`：`list()` / `option()` 透传 `nickname`。
- prompt 模板：覆盖 `{{ agent.nickname }}` 两条分支（有昵称渲染昵称；无昵称渲染 `provider / model`），以及 `validatePromptTemplate` 接受新 key。放在现有 prompt 模板测试所在目录（`test/prompts/`）。

### 4.3 Admin e2e

`pnpm run admin:test:e2e 08-models`：模型编辑对话框渲染出昵称输入，保存后 `GET /providers` 返回该字段（`08-models-editing.e2e.ts` 覆盖编辑回写，`08-models.e2e.ts` 覆盖列表渲染）。新增字段若改变对话框布局，先跑这一套。

## 5. 验证清单

```bash
pnpm run lint
pnpm run check
pnpm test
pnpm run admin:test:e2e 08-models      # 动了 Admin 表单或 locale
pnpm run docs:build && pnpm run docs:verify   # 动了 apps/docs
```

手工核对（纯读代码/脚本，不写进 `pnpm test`）：配置里给一个模型设昵称后，`grep -n "provider} / "` 那 7 处输出点全部走 `modelDisplayLabel`，没有遗漏的拼接。

## 6. 边界与风险

- **只改展示层**：定位、切换、校验仍用真实 `provider` / `model`。`AgentModelOption` 的两个字段不能删，`ConfigReloader.setChatModel` 依赖它们。
- **昵称不唯一**：按序号切换，重名只影响回执可读性；不要为此加唯一性校验（会让配置文件写入顺序敏感）。
- **不要动 `name`**：`name` 是 models.dev 等上游元数据，`/model` 列表的括号、Admin 列表、`AgentModelOption.name` 都在用；把它当昵称会牵动元数据处理链路。
- **不要改 Pi 的 `Model` 对象**：昵称只存在配置文件里，Pi 的注册表不承载自定义字段，`switch.ts` 的 `candidate` 没有它。
- **`systemPromptHash` 只在模板真的引用昵称时变化**，见 §3.5。
- **未设昵称时的裸奔是产品决定**，PRD 已明确不做告警/拦截。不要在 `check-config` 或 `doctor` 里加提示。
- **`/effort` 的思考强度列表**保持现状输出，不要把 `supported` 也脱敏。
- 厂商级系统提示词与模型自带身份认知无法约束，属 out of scope；`{{ agent.nickname }}` 只是给运维一个可用的抓手。

## 7. 文档同步

落地后：

- 本文件移到 `agent-doc/design/archived/` 并在 `agent-doc/README.md` 的归档索引里加一行。
- 若 `/status`、`/model`、`/effort` 的行为描述出现在 `agent-doc/telegram-agent-flow.md` 或 `agent-doc/configuration.md`，同步补昵称规则；模板变量清单若在 `agent-doc/` 有副本也一并更新。
- 按 `write-devlog` 流程写一条 devlog，记录提交 hash 与验证证据。
