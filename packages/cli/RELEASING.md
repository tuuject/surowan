# 发布（维护者）

返回 [README](./README.md)。

## 自动化发布

`.github/workflows/npm.yml` 负责发布，独立于 Docker workflow（不等待 Docker gates）：

- `main` 的 push：版本 `0.0.0-canary.<run_number>.<run_attempt>.g<12 位提交 SHA>`，dist-tag `canary`。
- 严格 `vMAJOR.MINOR.PATCH` 的 tag（无前导零、无 prerelease、无 build 后缀）：tag 中的版本号即发布版本，dist-tag `latest`。
- 版本只在 CI 的一次性 checkout 内改写（在 `packages/cli` 执行 `npm version --no-git-tag-version`），不回写、不提交源码；稳定 tag 是稳定版本的唯一来源。
- `pnpm --filter @tuuject/surowan-utils pack` 之后，dry-run 与实际暂存使用同一个 tarball：先 `npm stage publish <tgz> --dry-run --access public --tag <dist-tag> --ignore-scripts` 检查内容，再以 `--provenance` 暂存同一文件。
- CI 只做 staged publishing：`npm stage publish` 把版本放进 registry 的待审批区，不对外可见；维护者需用 `npm stage list @tuuject/surowan-utils` 查看，`npm stage approve <stage-id>`（需 2FA）后才真正发布，或用 `npm stage reject <stage-id>` 丢弃。dist-tag 在暂存时就固定，审批时不能更改。每次 `main` push 都会暂存一个 canary，不审批就不会出现在 `canary` dist-tag 上。
- 认证使用 GitHub OIDC（job 持有 `id-token: write`）：不使用 `NPM_TOKEN`，不依赖 GitHub Environment。跑在 Node 24 上，发布前安装 npm 11.16.0（trusted publishing 要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0）。
- 只有 `tuuject/surowan` 的 push 能进入发布 job；版本 guard（`scripts/npm-release.ts`）再次校验事件、仓库与 ref，不支持的输入会被拒绝。
- 发布串行且不取消正在运行的任务；`queue: max` 最多保留 100 个等待任务，避免后续 main push 顶掉等待中的稳定发布。队满时 GitHub 会取消新增任务，须人工检查并重跑。

稳定发布由维护者手动打 tag 触发（以下仅为示例，不在本仓库自动执行）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

push 后到 Actions 日志确认暂存成功，用 `npm stage approve` 审批，再到 npm 包页面确认版本、dist-tag 与 provenance。几点注意：

- prerelease tag（如 `v1.0.0-rc.1`）虽会匹配 workflow 的 trigger，但会被版本 guard 拒绝，不会发布。
- Docker workflow 用 `GITHUB_TOKEN` 推送的 `v0.0.0-next-<UTC 时间戳>` tag 不会触发本 workflow。
- 每次稳定发布都会显式移动 `latest`，不会按版本大小跳过：在 `v2.0.0` 之后发布 `v1.2.4` 会把 `latest` 回退到 `1.2.4`。本 workflow 不区分旧维护线，打 tag 前必须确认这是预期。
- dry-run 检查 tarball 内容（npm 会顺带拒绝已存在的版本），但不验证 OIDC 与 trusted publisher 权限；这些只能在真实暂存时暴露。

## 首次发布 bootstrap

trusted publisher 只能配置到 npm 上已存在的包，因此第一次发布必须由对 `@tuuject` scope 有写权限的维护者在本机手工完成。不要把 token 写进命令或仓库。

1. 本机安装 Node.js ≥ 24，在仓库根目录安装依赖：

   ```bash
   pnpm install --frozen-lockfile
   ```

2. 运行静态检查与相关测试（跨模块改动再跑完整 `pnpm test`）：

   ```bash
   pnpm run check
   pnpm test test/invocation-cli.test.ts test/npm-release.test.ts
   ```

3. 打包到明确的输出目录（用绝对路径，避免相对路径歧义；产物名随版本变化）：

   ```bash
   pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
   # 形如 dist/npm/tuuject-surowan-utils-0.1.0.tgz
   ```

4. 先用 dry-run 检查 tarball 内容：

   ```bash
   npm publish ./dist/npm/tuuject-surowan-utils-0.1.0.tgz --dry-run --access public --tag latest --ignore-scripts
   ```

5. 交互式登录 npm 并确认本机账号（`npm whoami` 只确认本机身份，不是 OIDC/trusted publishing 的验证）：

   ```bash
   npm login --registry=https://registry.npmjs.org
   npm whoami
   ```

   账号需要 `@tuuject` scope 的写权限，并在发布时启用 2FA。

6. 确认 dry-run 内容无误后，发布同一个 tarball：

   ```bash
   npm publish ./dist/npm/tuuject-surowan-utils-0.1.0.tgz --access public --tag latest --ignore-scripts
   ```

   npm 的包名与版本组合不可复用，即使撤包也不能重发同版本。`0.1.0` 用过之后，既不能用它再次手动发布，也不能再用 `v0.1.0` tag 发它；后续稳定版本选择 `v0.1.1` 或 `v1.0.0` 这类未使用过的版本。

## 配置 trusted publisher

1. 首次手工发布成功后，在 npm 打开该包的 Settings → Trusted publishing → GitHub Actions，填写：
   - Organization or user：`tuuject`
   - Repository：`surowan`
   - Workflow filename：`npm.yml`（只填文件名，不能带 `.github/workflows/` 路径，必须带 `.yml`）
   - Environment：留空
2. Allowed actions 只开启 stage publish（npm 新配置的默认值），不开启 **Allow npm publish**：CI 只能暂存，真正发布必须由维护者 2FA 审批。本 workflow 用 `npm stage publish --tag <dist-tag>`，没有单独的 `npm dist-tag` 步骤。不要以 dry-run 推断权限已经满足，须在首次真实暂存并审批后核对目标 dist-tag。
3. trusted publisher 配置保存后不可编辑：填错只能删除后重建。

配置完成后，用一次真实的 `main` push 和一次稳定 tag 验证暂存、审批与 provenance——CI 里的 dry-run 覆盖不到这条路径。成功后建议：

- 在包 Settings → Publishing access 选择 **Require two-factor authentication and disallow tokens**；这仍然允许 OIDC/trusted publishing，只是关闭长期 token 发布。
- 对 `main` 分支与 `v*` tag 启用仓库保护，限制谁能修改发布 workflow、创建或移动稳定 tag。

官方参考：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[`npm trust` 前提条件](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
