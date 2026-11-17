# Surowan - 20261117 PR 上跑 verify、Action 锁 SHA 与镜像依赖缓存层

## 背景

一次全仓审计列出了 CI 与镜像构建方面的四个问题：

- `.github/workflows/docker.yml` 的 `verify` job（lint、类型检查、全量 `pnpm test`、面板构建与 Playwright e2e）只在 push `main` / `develop` / `v*` 时触发。PR 上只有 `docs.yml` 的两个文档测试，坏测试要合进 `develop` 之后才会红。
- `docs.yml` 用一次 `pnpm test a b` 跑两个测试文件。vitest 对多个过滤器取并集，其中一个改名后不再匹配任何文件也会静默通过，`npm.yml` 的注释里早就写了这个坑。
- `npm.yml` 的每个 action 都锁了 commit SHA，`docker.yml` 与 `docs.yml` 却用浮动 tag，其中 `build` / `prune-next` 带 `contents: write` 与 `packages: write`，`prune-next` 还跑第三方 action。
- `Dockerfile` 的 builder 阶段（目标架构，arm64 走 QEMU）先全量 `pnpm install`，什么都不构建，再 `pnpm install --prod --ignore-scripts` 剪掉 devDependencies，并预装了没有消费者的 `python3 make g++`。

本次改动由 Devin（`swe-2-high`，T3 子线程 `surowan-audit-epic-d-ci-build-v1`）实现，主会话 review 与复验。

## 主要变更

### 1. `verify` 在 pull request 上运行

`docker.yml` 增加 `pull_request:` 触发。写权限相关的 job 全部显式限定事件，不再只靠 ref 间接保证：

```yaml
  docker-check:
    if: github.event_name == 'push' && github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/tags/v')
  build:
    if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))
  prune-next:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

`docker-check` 不在 PR 上跑：`docs.yml` 的 `image-smoke` 已经在每个 PR 上构建同一个镜像。并发分组在原有规则上加了一支，PR 按 `refs/pull/<n>/merge` 分组，同一 PR 的新推送取消旧 run；`develop` 仍共用一组，`main` 与 tag 仍每个 run 独占一组：

```yaml
concurrency:
  group: docker-${{ github.ref == 'refs/heads/develop' && github.ref || github.event_name == 'pull_request' && github.ref || github.run_id }}
  cancel-in-progress: true
```

fork 来的 PR 只有只读 token 且没有 secrets；`verify` 只用 checkout、pnpm、Node 与 Playwright 下载，两者都不需要。

### 2. `docs.yml` 两个测试文件分开跑

```yaml
      - run: pnpm test test/docs/examples.test.ts
      - run: pnpm test test/docs/search.test.ts
```

### 3. 所有 action 锁到 commit SHA

`docker.yml` 与 `docs.yml` 的每个 `uses:` 改成 `<sha> # vN` 形式。`actions/checkout`、`pnpm/action-setup`、`actions/setup-node` 复用 `npm.yml` 已有的 SHA；其余由 `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` 解析（都是 lightweight tag）。`pnpm/action-setup` 的 `v6` tag 在 `npm.yml` 锁定之后又移动过，这里有意与 `npm.yml` 保持同一个 SHA，交给 Renovate 一起升级。

### 4. builder 阶段：一次安装，联网部分放在可缓存层

首轮实现把第一次全量安装直接删掉，只留 `COPY . .` 之后的生产安装。review（ocr 与人工都指出）发现这会丢掉依赖缓存层：CI 用 `type=gha,mode=max` 层缓存，原来的全量安装在 lockfile 不变时是命中缓存的，后面的 `--prod` 只做剪枝；删掉之后每次源码变化都要在 QEMU 下重新下载全部生产依赖，常见路径反而更慢。

最终做法是 pnpm 的 Docker 分层方式：

```dockerfile
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch --prod

COPY . .
# ... COPY --from=assets ...
RUN rm -rf apps/docs && pnpm install --prod --frozen-lockfile --ignore-scripts --offline
```

`pnpm fetch --prod` 的层输入只有根 `package.json`、lockfile、`pnpm-workspace.yaml` 与 `patches/`，源码变化不影响它；最终安装带 `--offline`，只从 store 链接，缺包会直接让构建失败而不是去下载。选 `fetch` 而不是「只复制 manifest 的安装层」有两个原因：不用在 Dockerfile 里逐个列举 workspace manifest；`fetch` 不创建 `packages/*/node_modules`，所以 `COPY . .` 之后才出现这些目录，本地构建上下文里的宿主机 `node_modules` 无从覆盖它们（`.dockerignore` 只排除了根目录与 `apps/admin-next` 下的）。

builder 不再装 C 工具链：这个阶段唯一的安装带 `--ignore-scripts`，不会编译任何东西；`better-sqlite3` 用随包发布的 prebuilds，且构建脚本本来就被 `pnpm-workspace.yaml` 拒绝。assets 阶段与 runtime 阶段未动。

### 5. 文档

`agent-doc/verification.md` 的「CI 对齐」表与 `agent-doc/operations.md` 的 Docker 部署一节按新的触发条件、并发分组与 builder 层序更新。

## 验证

主会话亲自运行（在子 agent 的 checkout 内）：

```bash
git diff --cached --check && pnpm run lint
# 通过

git add -A && node scripts/file-token-limit.ts
# 无拒绝输出

# 10 个 action 逐个核对 SHA
git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag> 'refs/tags/<tag>^{}'
# 7 个新解析的 SHA 与 tag 当前指向一致；3 个复用 npm.yml 的 SHA，
# 其中 pnpm/action-setup v6 的 tag 已移动（见上）
```

子 agent 自报、主会话未重跑：

```bash
pnpm run check
# 通过

# 无 Docker 的分层等价验证：临时目录 + 全新 --store-dir
pnpm fetch --prod --store-dir ./store
# 381 个包进 store
pnpm install --prod --frozen-lockfile --ignore-scripts --offline --store-dir ./store
# 成功；require('better-sqlite3' / 'sharp' / '@node-rs/argon2') 输出 native ok；
# packages/image-service/node_modules 含 drizzle-orm / sharp / zod；
# vitest / typescript / @biomejs/biome / @rspress/core 不存在
# 改一个源文件并删掉全部 node_modules 后重跑同一条离线安装：仍成功，零下载
```

未执行：

- 开发机没有 Docker，镜像没有实际构建过：`docker build`（amd64 与 `--platform linux/arm64`）、fetch 层缓存命中、镜像内原生模块加载与 `check-config` 都没有跑。PR 上 `docs.yml` 的 `image-smoke` 会构建 amd64 镜像并做内容断言；多架构构建要等合入 `develop` 后的 `docker-check`。
- `actionlint` 未安装，两个 workflow 没有做静态检查。
- 触发条件与并发分组只做了推演，没有真实触发过 workflow；这个 PR 自身的 CI 就是第一次实跑。
- `pnpm test` 与 e2e：本次改动不涉及源码与测试，未跑。

## 提交

```txt
86713fed Run CI verification on pull requests and cache image dependencies
```
