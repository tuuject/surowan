# Surowan - 20261120 Admin E2E 入口自动安装 Playwright 浏览器

## 背景

Playwright 的浏览器版本由锁文件里的 `@playwright/test` 决定。本机缓存 `~/Library/Caches/ms-playwright` 只有 `chromium_headless_shell-1243`，`@playwright/test` 升到 1.64.0 后需要的是 1248。于是 `pnpm run admin:test:e2e` 的所有用例都在 `browserType.launch` 失败，报错为 `Executable doesn't exist`。

文档原来只写「首次运行前安装 Chromium」，但每次升级 Playwright 都会再出一次这个问题，换任何机器或 agent 都会踩到。用户要求持久化解决。

CI（`.github/workflows/docker.yml`）有单独的 `playwright install --with-deps chromium` 步骤，所以不受影响。

## 主要变更

### 1. `test:e2e` 先确认浏览器

`apps/admin-next/package.json`：

```json
"test:e2e": "playwright install --only-shell chromium && playwright test"
```

- **只装 headless shell**：套件只跑 headless，`--only-shell` 只装 headless shell，避免再下载完整 Chromium。
- **参数透传**：`pnpm run admin:test:e2e <spec>` 的参数由 pnpm 追加在脚本末尾，仍然落在 `playwright test` 上。
- **CI**：CI 的 `--with-deps` 步骤负责 Linux 系统依赖，保留不动；入口里的安装随后是空操作。

没有选的方案：

- `postinstall`：会让 Docker 构建和不跑 e2e 的 CI job 也下载浏览器。
- `globalSetup` 里检查浏览器：只能报错，不能自愈。
- 改用系统 Chrome：本地与 CI 的浏览器会不一致。

### 2. 文档

- `agent-doc/verification.md`：删掉「首次运行前安装 Chromium」这一行，在环境前置说明里写明新行为。
- `apps/admin-next/README.md`：删掉同一行，补一句说明。

## 验证

```bash
PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:9 pnpm exec playwright install --only-shell chromium
# 浏览器已装：exit 0，real 0.80s；下载源不可达也通过，说明已装时不联网
PLAYWRIGHT_BROWSERS_PATH=<空的临时目录> pnpm run admin:test:e2e 01-routes
# 自动下载 chromium-headless-shell v1248 与 ffmpeg v1013，然后 28 passed
pnpm run lint
# No fixes applied
git diff --check
# 无输出
```

CI 上的效果要等这个 PR 的 workflow 跑完才能确认。

## 提交

```txt
420ff5ce Install the Playwright browser before admin E2E runs
```
