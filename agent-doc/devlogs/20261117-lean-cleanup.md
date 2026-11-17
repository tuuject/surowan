# Surowan - 20261117 清理：合并重复实现、删除死代码、过时注释与 dotenv

## 背景

一次全仓审计列出了一批不影响行为、但每次重构都要顺手维护的东西：

- 群聊记忆整理（`src/context/group-memory/consolidate.ts`）与辞典融合（`src/plugins/dictionary/merge.ts`）各自抄了一份调用 Tool Model 的样板：`reasoningOption`、`requireModel`（模型已注册、接受文本、支持该 thinking level），以及「取第一个 `{` 到最后一个 `}`、`JSON.parse`、用 TypeBox validator 校验并拼出前五条错误」。两处只有错误类不同。
- `renderCurrentTime`、`trimChars`、分页参数解析各有两份。
- 全仓搜索（含测试、配置与字符串）零引用的文件和导出，分布在面板前端、运行时与 CLI 包。
- 10 月 26 日目录重组之后，28 处注释仍在用旧的平铺文件名（`send-tool.ts`、`config-diff.ts`、`replay.ts` 等），另有几处还把面板的构建工具写成 rsbuild。
- `src/platform/load-env.ts` 用 `dotenv` 读 `.env`，而运行时要求 Node.js ≥ 24，已经自带解析器。

约束是不改变运行时行为、HTTP 响应、错误码与错误文案。唯一的例外是 `.env` 解析，见第 5 节。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-c-lean-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. Tool Model 样板合并到 `src/platform/tool-model.ts`

新增 `requireToolModel`、`toolModelReasoningOption` 与 `parseToolModelJson`，错误类由调用方通过工厂传入，所以两处对外的错误类与文案逐字不变：

```ts
model = requireToolModel(options.models, options.selection, (message) => new GroupMemoryUnavailableError(message));
```

```ts
const parsed = parseToolModelJson(
  text,
  eventValidator,
  (message) => new GroupMemoryInvalidOutputError(message),
  'invalid events',
);
```

模型调用本体（请求、超时、`model_calls` 审计）没有合并：整理一侧有 repair 调用与 `claim_lost` 语义，融合一侧是单次 60 秒调用，两边的审计行结构与超时都不同，合并会改变行为。

### 2. 三组重复的小 helper

- `renderCurrentTime`：保留 `src/context/builder/format.ts` 的导出，`src/context/scene/` 改为导入它。
- `trimChars`：保留 `src/plugins/web-search/format.ts` 的导出，`request.ts` 改为导入。
- 分页参数：`src/ingress/admin/audit/shared.ts` 新增纯函数 `parsePageParam`（默认值、正则、上下界，错误由调用方给）。审计列表与 Playground 的 `parseLimit` / `parseOffset` 都委托给它，各自的默认值、正则、上限、错误类、状态码与文案保持原样。

### 3. 删除的死代码

每一项删除前后都做了全仓搜索，没有残留引用。

- 前端整文件：`apps/admin-next/src/components/error-boundary.tsx`、`hooks/use-mobile.ts`、`lib/compose-refs.ts`。
- 前端导出：`agentModelConfig`（连带 `modelConfigFor`）、`modelUsage`（连带 `ModelUsage`）、`usageQuery`、`getUsage` 及其专用类型、`setQueryClient`、`isCommentableEvent`。服务端的 `GET /api/usage` 保留，CLI 在用。
- 运行时与 CLI：`runningInvocationForConversation`、`AdditionalToolFactory`、`isEventWarningCode`、`ImConnectionStatus`、`ImSender`、`DictionaryConfig`、`ToolModelConfig`、`hasClientSignature`。
- `compareVersions` 只有测试在调用，生产代码从不比较两个版本；连同它专属的两条测试一起删除。`semver` 依赖保留，`selectTag` 仍在用。
- `src/adapters/local-monolith/runtime/serve.ts` 里 `bridge === undefined` 的永假分支。

### 4. 过时注释

只叙述「从哪个文件拆出来」的句子直接删掉；仍然成立的指向改成现在的文件名；`rsbuild` 改为 `vite`。只改注释。

### 5. `.env` 改用内置解析器（有一处行为变化）

`process.loadEnvFile` 只接受路径，而 `dotenv` 会剥掉文件开头的 BOM、把 CR 行尾归一化，直接换过去这两种文件会读错。实现改为读文件、去 BOM、归一化行尾，再交给 `node:util` 的 `parseEnv`（`loadEnvFile` 内部的同一个解析器），只写入尚未设置的变量：

```ts
contents = contents.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
for (const [key, value] of Object.entries(parseEnv(contents))) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
```

优先级不变（真实环境变量 > `.env.local` > `.env`），缺失的文件照旧静默跳过。`dotenv` 从根 `package.json` 与 lockfile 中移除。

**行为变化**：`dotenv` 额外接受 `KEY: value` 这种冒号写法，内置解析器只认 `KEY=value`，这样的行现在会被忽略。两个解析器的对照实测：

```txt
输入:  A: 1 / B=2 / C = 3 / D='x y' # c / E=a b # c
parseEnv: {"B":"2","C":"3","D":"x y","E":"a b"}
dotenv:   {"A":"1","B":"2","C":"3","D":"x y","E":"a b"}
```

另有两种不合法的行结果不同（子 agent 实测）：`Q="a"b` 与 `K="a\"b"`，两边的结果都没有意义。没有为这些写兼容层；`agent-doc/configuration.md` 写明了只接受 `KEY=value`。

主会话补了一条契约测试（`test/load-env.test.ts`）：CRLF 文件里的 `export` 前缀、双引号、单引号内的 `#`、行尾注释、空值、引号内多行、冒号写法被忽略，以及已设为空字符串的真实变量不被覆盖。

### 6. 小项

- `.gitignore` 与 `.dockerignore` 删掉不再有产出者的条目（`docs/plan`、`apps/docs/doc_build/`、`apps/admin-next/.output`）。
- `apps/admin-next/package.json` 的 `devDependencies` 声明 `sharp`、`@hono/node-server`、`drizzle-orm`：它的 e2e 文件直接 import 这三个包，此前只是碰巧能从工作区根解析到。版本与根一致，lockfile 里 `drizzle-orm` 仍是同一个实例。

## 验证

review：一轮 ocr，1 条意见（冒号写法不再被识别，medium）。属实，按上文处理：不模拟，写明并加测试。主会话另外重写了 `load-env.ts` 的注释（原注释在讲 dotenv 以前怎么做）。

主会话亲自运行（在子 agent 的 checkout 内，Windows）：

```bash
pnpm run lint && pnpm run check
# 通过

pnpm test test/load-env.test.ts   # 连跑 3 次
# 每次 4 tests passed

pnpm test
# Test Files  1 failed | 406 passed | 1 skipped (408)
# Tests  1 failed | 2010 passed | 9 skipped (2020)
# 唯一的失败是 test/recurring-alarms/schedule.test.ts 的 Windows 路径断言：
# 基线（8d5e82f8）上同样失败，与本次改动无关，由另一个 PR 修复

pnpm run admin:build && pnpm run admin:test:e2e
# 329 passed (2.7m)

git diff --cached --check && node scripts/file-token-limit.ts
# 无输出

# Node 24.18.0 上用同样的输入核对 parseEnv 的结果，与 26.5.0 一致
```

删除项逐个 `git grep -n -w`（排除冻结的历史文档与 lockfile）：零命中。

未执行：

- `docs:build` / `docs:verify`：本次没有改动 `apps/docs/` 与配置 Schema。
- 没有在 Linux 上跑；CI 的 `verify` 会跑全量。
- `doctor`、真实 Telegram 验收未跑。

## 提交

```txt
02596388 Merge duplicated helpers, drop dead code and replace dotenv
```
