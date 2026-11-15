# Surowan - 20261115 模型健康检查去掉「回复不符预期」，改为直接显示模型回复

## 背景

Admin Panel 供应商页的模型「测试」会给模型发一条固定 user 消息 `reply with extract content: ok`，原来按回复内容分三种状态：trim 后恰好是小写 `ok` 才是「正常」，其余正常结束的非空回复都标成黄色的「回复不符预期 / Unexpected reply」（`unexpected_response`），审计里也记成 `error` + `model_health_unexpected_response`。

问题是操作员看不到这条提示词。模型回 `OK!`、`ok.` 或一句问候是完全正常的反应，用户却看到一个警告色的「不符预期」，以为模型或连接坏了。模型说了什么本身就藏在可展开详情里，要多点一下才能看到。

约束：

- 健康检查只证明「这个模型能正常完成一次文本回复」，不验证指令遵循；失败的定义（请求失败、超时、空输出、非正常停止、返回工具调用）保持不变。
- 模型输出是不可信文本，前端只能当普通文本节点渲染，不能拼进 i18n 的 `<Trans>` 标记串。

## 主要变更

### 1. 后端只保留 `ok` / `error`

`src/ingress/admin/model-health.ts:31` 把 `status` 收窄为 `'ok' | 'error'`；正常结束且 trim 后非空即 `ok`，不再比对内容：

```ts
    } else {
      // Any normal reply passes: the operator never sees the fixed prompt, so a
      // model answering "OK!" instead of "ok" is healthy, not a failure. The
      // reply itself is returned for the operator to read.
      status = 'ok';
    }
```

`response_text` 照旧经 `SecretStore.redact` 后截断到 4096 字符返回。审计随之变化：这类回复的 `model_calls` 现在是 `state = 'success'`、`error_code = null`，`model_health_unexpected_response` 不再产生。HTTP 契约字段不变，只是 `status` 少了一个取值；`surowan-utils` / MCP 只透传 JSON，没有分支依赖它。

### 2. 前端在行内显示模型回复

`apps/admin-next/src/components/models/model-list.tsx`：

- 删掉 `unexpected_response` 的徽章色与文案。
- `ok` 行在耗时行下面新增一行 `模型回复 / Model reply <原话>`（`data-health-reply`），文本 trim 后作为普通子节点放进 `dir="auto"` 的 `<span>`，阿拉伯语界面下按内容自己的方向隔离；不用 `<Trans>`，避免模型输出里的尖括号被当成标记解析。
- 可展开详情只留给 `error`：服务商错误可能很长，仍然折叠；`ok` 行不再出现展开按钮。

四种语言的 `healthUnexpected` 换成 `healthReplyLabel`（`模型回复` / `Model reply` / `Modellantwort` / `رد النموذج`）。

### 3. 测试与文档

- `test/admin/providers-health.test.ts`：状态表改为断言 `' OK '`、`'Hello! How can I help?'`、含 secret 的回复都是 `ok` 且 `response_text` 原样（脱敏后）返回，空白与 `length` 截断仍是 `error`；同时断言逐条审计的 `state` 与 `error_code`。
- `test/admin/providers-health-limits.test.ts`：5000 字符的长回复现在是 `ok`，审计序列改为 `['error', 'success', 'error']`。
- E2E fixture 的 `health-unexpected` 模型改名 `health-chatty`（上游仍回 `hello`）；`16-model-health.e2e.ts` 断言它显示「OK」和 `Model reply hello`，`ok` 行没有展开按钮，失败行没有回复行、错误仍在展开详情里。
- `apps/docs/content/docs/configure/models.md` 与 `agent-doc/admin-panel.md` 同步状态定义与界面描述。

## 验证

```bash
git diff --check
# 通过
npx vitest run test/admin/providers-health.test.ts test/admin/providers-health-limits.test.ts apps/admin-next/src/locales/catalog.test.ts
# Test Files 3 passed (3); Tests 23 passed (23)（rebase 到 925c748f 后重跑同样通过）
pnpm run check
# exit 0（rebase 后重跑同样通过）
pnpm run lint
# exit 0，Checked 1461 files, No fixes applied
pnpm run admin:build && pnpm run admin:test:e2e 16-model-health
# 7 passed（16-model-health 与 16-model-health-lifecycle）
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两遍都 Verified 53 HTML/Markdown pages, search, examples, schema, provenance and 173 HTTP resources；构建后 git status 只有本次改动
npx vitest run test/docs/examples.test.ts test/docs/search.test.ts
# Tests 5 passed (5)
pnpm test
# Test Files 2 failed | 392 passed | 1 skipped (395)
# Tests 2 failed | 1940 passed | 9 skipped (1951)
```

两个失败与本次改动无关，和 `20261115-web-search-freshness.md` 记录的是同一对：

- `test/recurring-alarms/schedule.test.ts` › croner is imported only by the local-monolith schedule engine：Windows 路径分隔符 `\` 与期望的 `/` 不符，单独重跑仍失败。
- `test/group-memory/store.test.ts` › a keyword search reaches an entry older than thousands of non-matching ones：负载下超时，单独重跑通过。

未执行：真实 Provider 下的人工验收（在供应商页点「测试」，确认回复非 `ok` 的模型显示「正常」与模型原话）。

## 提交

```txt
08d371a7 Show the model reply instead of an unexpected-reply status in health checks
```
