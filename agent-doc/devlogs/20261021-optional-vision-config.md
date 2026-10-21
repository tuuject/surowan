# Plastic Wan - 20261021 `vision` 配置段全字段可选与无视觉模型降级

## 背景

`agent` 段在 82eae7a 已改为全字段可选，但 `vision` 仍是必填段：`provider`/`model`/`max_output_tokens`/`max_concurrency`/`background_sticker_concurrency`/`prompt_version`/`daily_budget` 一个都不能少，`buildModelRegistry` 无条件 `requireModel` 视觉模型，`RuntimeConfiguration.visionModel` 是非空 `Model<Api>`。部署方即使主模型本身就是多模态、或暂时不需要读图，也必须配一个视觉模型。

需求：`vision` 可以是空对象、`null` 或整段省略，在配置校验层面合法；没有指定模型时降级处理。

改动前代码里并没有现成的 vision 降级路径（已有的是 `agent` 可选与 `image` 段非法即禁用），本次沿用 `agent` 可选的两层做法：文件层允许缺省，装配处用默认值解析成运行时实体值，只有 `provider`/`model` 这一对保持可选并统一决定「有没有视觉模型」。vision 没有可配置的 thinking/effort（分析调用固定 `reasoning: 'low'`），因此不涉及。

## 主要变更

### 1. Schema、默认值与模型对

`src/platform/config.ts`：新增 `VisionSectionSchema`，段内字段（含 `daily_budget.*`）全部可选，`vision` 本身可选且可 `null`：

```ts
// `vision` may be absent, null or a partial object, like `agent`: only the
// provider/model pair decides whether image analysis runs, and everything
// else resolves to VISION_DEFAULTS.
vision: Type.Optional(Type.Union([VisionSectionSchema, Type.Null()])),
```

`VISION_DEFAULTS` 取文档样例的数值（`max_output_tokens: 2_048`、`max_concurrency: 2`、`prompt_version: 1`、`daily_budget: { max_tokens: 200_000, max_images: 200 }`），`resolveVisionSection` 逐字段填充成 `VisionRuntimeConfig`，`RawConfig.vision` 改为该类型，`assembleRawConfig` 里装配。`activeVisionModel` 只在两半都写出时返回 `{ provider, model }`，是所有消费点共用的判断。

`validateFileConfig` 在模型对不完整时追加 warning；`validateSemantics` 只在模型对完整时做模型引用与 alias 校验，部分模型对（例如只写 `provider`）与 `agent` 一样合法并被视为未配置。

### 2. 注册表与运行时

- `src/platform/providers.ts:115`：无模型对时返回 `{ models, visionModel: undefined }`；`ConfigurationModels.visionModel` 改为 `Model<Api> | undefined`（`src/platform/runtime-config.ts`）。
- `src/capabilities/media/media.ts`：`#visionRun()` 返回 `VisionRun | undefined`；新增 `visionAvailable()`。`read_image` 在授权检查之后、开始 Tool Call 之前判断，无模型时以 `rejectToolCall(..., 'vision_unconfigured')` 记审计并抛出明确错误，不写 `media_analyses`；`analyzeStickerForIndex` 无模型时直接抛错。
- `src/capabilities/stickers.ts:168`：`runOne` 在无视觉模型时直接返回 `false`，Sticker 保持 `pending`，不累加 `failure_count`、不进入退避；worker 每 60 秒重查，热应用补上模型后自动恢复。

### 3. Prompt 与 doctor

- `src/context/context-builder.ts:280`：模板变量 `{{ vision.* }}` 在未配置时渲染为空串；图片处理说明拆成四种组合。多模态 Agent 仍直接接收新注入的图片，但说明改为旧图与 Sticker 无法再检查、`read_image` 不可用；text-only Agent 则说明图片与 Sticker 都无法检查。两种都要求不得声称看见了视觉细节。稳定段内容变化会按既有规则重建 Context。
- `src/doctor.ts:146`：无视觉模型时跳过 vision 探针，输出 JSON 新增 `vision` 字段（`<provider>/<id>` 或 `null`）。

### 4. 热更新 diff

`vision` 混合了热字段（`provider`/`model`/`max_output_tokens`）和重启字段，不能像 `mergeAgent` 那样整段照搬文件值。`src/platform/config-diff.ts:268` 新增 `mergeVision`：缺省或 `null` 的段按空对象合并，热字段随之删除，重启字段留到重启；合并结果为空且文件侧是缺省/`null` 时才沿用文件的形态。

### 5. Admin 面

- `listProviders` 的 `vision` 改为 `{ provider: string | null; model: string | null }`；删 Provider/模型的占用检查改可选链；`visionEdits` 的输出上限预检读 resolved 值。`PUT /vision` 写到 `null` 或缺失的段时，由 `writeConfigEdits` 既有的 `replaceNullParents` 新建该段。
- 前端 `VisionModelReference` 可空，In use 面板未配置时显示 `Not configured`，`model-manager` / `models.tsx` 的类型同步放宽。

### 6. 文档与测试

- 同步 `agent-doc/configuration.md`（`vision` 约束一节写明降级行为）、`agent-doc/admin-panel.md`、用户文档 `reference/config.md`、`configure/models.md` 与 `config.example.jsonc` 注释。
- 新增 `test/optional-vision.test.ts`（10 条）：`{}`/`null`/缺省合法且解析默认值、无 `visionModel`；部分模型对跳过校验；完整模型对仍校验；`read_image` 以 `vision_unconfigured` 拒绝并断言 `tool_calls` 行且 `media_analyses` 为空；Sticker 索引保持 `pending`/`failure_count = 0`；稳定 Prompt 文案与模板值；删除/恢复段的 diff 分类与候选；`visionEdits` 在 `null` 段上写入后重载得到视觉模型。
- `test/helpers.ts` 的 `TestRegistry.visionModel` 改可空，若干测试对文件层 `vision` 补非空断言或可选链。

## 验证

```bash
pnpm run check
# tsc --noEmit（runtime/cli/admin/docs）通过
pnpm run lint
# biome lint + format 通过（仅既有的 .claude/skills 断链 symlink 警告）
pnpm test
# 116 files，1478 passed / 2 skipped
npx vitest run test/docs-examples.test.ts test/optional-vision.test.ts test/config-diff.test.ts
# 文档与新测试补充后重跑：3 files，46 passed
pnpm run admin:test:e2e 08-models
# 12 passed
git diff --check
# 无输出
```

未执行：真实 `doctor` 与 Telegram 人工验收（无视觉模型时的真实对话与热补模型恢复）。

## 提交

```txt
95f138b Make the vision config section fully optional
```
