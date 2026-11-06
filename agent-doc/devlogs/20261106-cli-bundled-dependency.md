# Surowan - 20261106 CLI 用 bun 安装时解析 admin-surface 404

## 背景

`packages/cli`（发布名 `@tuuject/surowan-utils`）把内部包 `@surowan/admin-surface` 以 bundled dependency 的形式打进 tarball，同时仍把它声明在 `dependencies`（`workspace:^`）。tarball 里确实带着 `node_modules/@surowan/admin-surface`，`npm install` 会用这份副本，但 bun 在解析阶段仍按 manifest 的 `dependencies` 去 registry 取同名包：

```txt
$ bun i -g @tuuject/surowan-utils@canary
error: GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404
error: @surowan/admin-surface@^0.1.0 failed to resolve
```

`@surowan/admin-surface` 是 `private: true` 的内部包，本来就不发布，所以这不是漏发；是 bun 不优先使用 tarball 内的 bundled 副本（`oven-sh/bun` 的相关 issue 仍开放，bun 1.4.0 复现）。同一 canary 在 npm 下安装正常，`surowan-utils commands` 可运行。

## 主要变更

### 1. admin-surface 只声明为 devDependency

`packages/cli/package.json`：把 `@surowan/admin-surface` 从 `dependencies` 移到 `devDependencies`，保留 `bundledDependencies`。monorepo 内 `tsc` 仍能解析它；发布的 manifest 不再有同名运行时依赖，bun / yarn 就不会去 registry 解析，运行时由 tarball 内的 `node_modules/@surowan/admin-surface` 提供（Node 会沿 `node_modules` 向上找到包内的嵌套副本）。

```json
"bundledDependencies": ["@surowan/admin-surface"],
"devDependencies": { "@surowan/admin-surface": "workspace:^" }
```

`pnpm-lock.yaml` 的 `packages/cli` importer 同步从 `dependencies` 改为 `devDependencies`。

### 2. 测试固定真正的不变量

`test/npm-release.test.ts` 原来断言 `manifest.dependencies` 等于 `{ '@surowan/admin-surface': 'workspace:^' }`，正好把故障形态钉死。改为断言 `dependencies` 不存在、`devDependencies` 带该包、`bundledDependencies` 仍包含它——即「不打进运行时依赖，但打进 tarball」。

### 3. 文档

- `packages/cli/README.md` 安装段说明 tarball 自带副本、各包管理器都能装，并写明 bun 上出现该 404 意味着装的是 ≤ `0.0.0-canary.43.1` 的旧产物。
- `packages/cli/RELEASING.md` 记录为什么它必须是 devDependency + bundledDependency，禁止改回 `dependencies` 或单独发布。

## 验证

```bash
# 修复前的 canary（0.0.0-canary.43.1）在 bun 1.4.0 上复现
bun add @tuuject/surowan-utils@canary
# error: GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404

# 修复后本地打包，tarball 仍带 33 个 admin-surface 文件，manifest 无 dependencies
pnpm --filter @tuuject/surowan-utils pack --pack-destination /tmp/packfinal

# bun 全局安装（临时 BUN_INSTALL，不污染本机）与运行
BUN_INSTALL=/tmp/bunfinal bun add -g /tmp/packfinal/tuuject-surowan-utils-0.0.1.tgz
/tmp/bunfinal/bin/surowan-utils commands   # 列出面板命令，import 了 admin-surface

# npm 同样安装并运行
npm i /tmp/packfinal/tuuject-surowan-utils-0.0.1.tgz && node node_modules/@tuuject/surowan-utils/dist/bin.js commands

pnpm run cli:check       # tsc 通过
pnpm test test/npm-release.test.ts test/cli
pnpm run lint
```

未执行：真实 registry 上的 canary 安装（需要新 canary 经维护者审批发布后才能验证）；`pnpm run check` 全量与 Admin Panel e2e（未触及面板与 runtime）。

## 提交

```txt
Keep admin-surface out of CLI runtime dependencies
```
