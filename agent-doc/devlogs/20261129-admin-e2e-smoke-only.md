# Surowan - 20261129 Admin Panel 浏览器 E2E 收敛为不绑文案的冒烟层

## 背景

`apps/admin-next/e2e/` 原有 70 个 Playwright spec、约 1.9 万行（含夹具）。其中 `getByRole` 1630 处、`getByText` 668 处，绝大多数定位钉在英文文案和 DOM 结构上。改动前的状态：

- 改一处按钮文字或调一次布局，就要回头重新验证并修改一批断言。近 60 天 `apps/admin-next/e2e` 有 169 次提交，面板源码 `apps/admin-next/src` 是 173 次。
- 这些断言只能证明「文字在 DOM 里」，对布局、流程和反馈的体验问题没有判断力，实际也没有拦住明显的体验问题。
- `.github/workflows/docker.yml` 的 `verify` job 用整套 E2E 卡镜像构建，#123 与 #133 都被同一处与改动无关的偶发失败拦过；`playwright.config.ts` 关着 trace 与截图，失败后没有现场。

用户的决定：移除针对界面细节的测试和绑定 i18n 文本的测试，vitest 测试全部保留。

约束：

- `e2e/server.ts`、`e2e/server-*.ts`、`e2e/helpers.ts`、`e2e/docs-locale*.ts`、`e2e/models-fixture.ts` 同时是 `pnpm run docs:screenshots` 与 `pnpm run admin:dev:mock` 的夹具，不能跟着删。
- 四个不开页面的 spec（`05-readonly-security`、`06-trust-boundary`、`14-api-keys`、`20-playground`）断言的是 Admin API 契约，删之前要确认 vitest 有同等断言。
- 留下的 spec 不能再依赖可见文字、无障碍名称或 locale。

## 主要变更

### 1. 只留三个 spec

`apps/admin-next/e2e/` 的 spec 从 70 个减到 3 个（13,635 行减到 640 行），删除 67 个 spec 和 10 个只为它们服务的辅助文件（`api-key-helpers.ts`、`chats-fixture.ts`、`decision-gate-fixture.ts`、`dictionary-fixture.ts`、`i18n-stress-helpers.ts`、`image-assets-fake.ts`、`model-health-fixture.ts`、`passkeys-fixtures.ts`、`playground-fixtures.ts`、`review-helpers.ts`）。`e2e/helpers.ts` 去掉了没有调用方的导出（`clickNav`、`toast`、`nextPage` 等 10 个）。夹具服务器没有改动。

- `00-auth.e2e.ts`：登录路径。全新实例匿名调 `POST /api/auth/setup` 得 401、session 接口不带 `setup_required`；一次性 web 码建出 `admin` 并登录；同一个码重放得 409 `pairing_code_used`；错误密码得 401 `invalid_credentials` 并留在表单、URL 不变；正确密码进入面板；会话撤销后回到登录表单。结果经 session API 断言。
- `01-routes.e2e.ts`：按文件内的路由表为每条路由和深链接生成一条用例，共 36 条。
- `30-dev-mock.e2e.ts`：`admin:dev:mock` 命令的生命周期，只把两处绑文案的页面步骤换成结构定位。

定位只用稳定属性：

```ts
const USERNAME_INPUT = 'input[autocomplete="username"]';
const PASSWORD_INPUT = 'input[autocomplete="current-password"]';
const CODE_INPUT = 'input[autocomplete="one-time-code"]';
const SUBMIT = 'button[type="submit"]';
const USE_CODE = '[data-testid="auth-switch-to-code"]';
```

前四个本来就在 `apps/admin-next/src/pages/auth.tsx` 里。切换到一次性码的按钮没有稳定属性，给它加了 `data-testid="auth-switch-to-code"`，这是本次唯一的 `src/` 改动。

### 2. 逐路由冒烟的判定

每条路由在生产构建产物与生产 CSP 下带已登录会话加载，断言 `main` 已渲染且非空、没有 `[data-route-error]`、没有 status ≥ 400 的 API 响应、没有发往 `/api/` 的写请求、没有跨源请求、没有 console error 和未捕获的页面错误。

「首屏加载完成」不靠文字判断，而是统计页面自己的 `/api/` 请求，等到至少有一个响应且连续两次采样都没有在途请求（`text/event-stream` 的常驻流不计）：

```ts
async function waitForFirstLoad(path: string, traffic: ApiTraffic): Promise<void> {
  let quietSamples = 0;
  await expect
    .poll(
      () => {
        quietSamples = traffic.inflight.size === 0 && traffic.responses.length > 0 ? quietSamples + 1 : 0;
        return quietSamples;
      },
      // ...
    )
    .toBeGreaterThanOrEqual(2);
}
```

旧的 `01-routes` 只覆盖 29 条路由。路由表补上了 `/dictionary`、`/reviews`、`/search-settings`、`/image-settings`、`/image-generate`、`/image-generations` 及其详情深链接。共享夹具不跑图片服务，`/api/image*` 的读取会得到 503，所以五条图片路由用 `page.route` 回答这几个读取请求，其余路由都由真实夹具服务器回答。

另有一条不开页面的守卫用例，对照 `apps/admin-next/src/routes/` 的文件名检查路由表，新增路由不登记冒烟就失败：

```ts
test('every file under src/routes/ has a smoke entry', () => {
  const files = readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.tsx') && file !== '__root.tsx');
  // ...
  expect(missing, `route files with no entry in ROUTES: ${missing.join(', ')}`).toEqual([]);
});
```

### 3. 四个纯 API spec 的契约补进 vitest

逐条对照四个 spec 的断言，已有同等 vitest 断言的不重复写，缺的补上，共 6 条新用例和 `test/playground/only.test.ts` 里的 3 处断言：

- `test/admin/admin.test.ts`：静态包的 `script-src 'self'`、`connect-src 'self'`、`x-frame-options: DENY`、`x-content-type-options: nosniff`。
- `test/admin/auth.test.ts`：已登录时 `POST /api/invocations` 与 `PUT /api/overview` 得 405 `method_not_allowed`；跨源 `POST /api/wake` 在会话检查之前得 403 `bad_origin`（匿名与带会话各一次）。
- `test/admin/inspection.test.ts`：只读 key 读 `source=file` 的配置与两份 prompt；只读 key 与 Cookie 并存时的读面，以及 Memo Blob 的 401 与 404。
- `test/admin/playground.test.ts`、`test/admin/playground-rooms.test.ts`：只读 key 能列房间、建房得 403 且消息含 `lacks write`；房间列表带标题、详情的待处理计数。
- `test/playground/only.test.ts`：Release 结算后的 `send_state: 'success'` 与 `input_state: 'released'`。

### 4. 失败现场与文档

`apps/admin-next/playwright.config.ts` 改为 `trace: 'retain-on-failure'`、`screenshot: 'only-on-failure'`，产物仍写到仓库外的 `outputDir`。CI 没有上传这些产物，`.github/workflows/docker.yml` 未改动。

`AGENTS.md` 的 Testing Guidelines 改了三条：首选在 vitest 里端到端驱动真实组件；浏览器 E2E 只是冒烟层，不为文案、布局、样式或交互细节新增，断言不得依赖可见文字、无障碍名称或 locale；面板前端改动跑 `admin:build` 与 `admin:test:e2e`，只改文案或 locale 键值不需要改任何测试。`agent-doc/verification.md`、`agent-doc/operations.md`、`agent-doc/admin-panel.md`、`CONTRIBUTING.md` 与 `apps/admin-next` 的两份 README 同步：被删 spec 的引用，vitest 有同等断言的改指 vitest 文件，没有的删除。

### 5. 不再有自动保护的范围

被删 spec 里只在浏览器层断言的内容现在没有自动回归：各页面的表单交互与草稿、并发保存的冲突提示、弹层过渡、窄屏与暗色布局、RTL 与长文本压力、Passkey 的浏览器端 WebAuthn 流程、Invocation 实时刷新的页面表现。它们的服务端契约仍由 `test/admin/` 等 vitest 套件覆盖；界面表现靠 `pnpm run docs:screenshots` 的截图与人工走查。

## 验证

```bash
git diff --check
# 无输出

pnpm exec biome lint . && pnpm exec biome format .
# 退出码 0

pnpm run check
# 退出码 0

pnpm test
# Test Files  496 passed (496)
# Tests  2637 passed (2637)

pnpm run admin:build
# 退出码 0

pnpm run admin:test:e2e
# 45 passed (17.1s)
```

子任务执行时另外跑过：`pnpm run admin:test:e2e 00-auth 01-routes --repeat-each=3`（123 passed）；临时删掉路由表里的 `/dictionary`，守卫用例报 `route files with no entry in ROUTES: dictionary.tsx`；`DOCS_SHOTS_ALLOW_INCOMPLETE=1` 下的文档截图 `models` 场景通过且没有改动已跟踪的 PNG。

未运行：`pnpm run docs:build` 与 `pnpm run docs:verify`（没有改动 `apps/docs/`、`scripts/docs/` 或 `ConfigSchema`）；完整的 `pnpm run docs:screenshots`；CI 上的 `verify` job。

## 提交

```txt
219ec46f Slim admin E2E to a text-free smoke layer
```
