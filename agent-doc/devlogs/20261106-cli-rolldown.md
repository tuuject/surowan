# Surowan - 20261106 CLI 构建切换到 Rolldown

## 背景

用户要求 `packages/cli` 使用 Rolldown，移除直接调用 esbuild 的构建方案。CLI 发布产物仍需自包含：private workspace 包 `@surowan/admin-surface` 必须编译进产物，不能成为需要从 registry 解析的运行时依赖。

检查还发现根目录 `cli:build` 调用带 `noEmit` 的 TypeScript 配置，只检查类型而不生成 README 所述的 `dist/bin.js`。

## 主要变更

### 1. Rolldown 生成单文件 CLI

`packages/cli/build.ts` 改用 Rolldown `build` API，保留构建前清理 `dist`，输入 `src/bin.ts`，使用 Node 平台与 `node24` 转换目标，输出 ESM `dist/bin.js`，以 `codeSplitting: false` 固定单文件分发。

`packages/cli/package.json` 将直接开发依赖 esbuild 替换为固定版本 `rolldown@1.2.16`，符合现有依赖最短发布年龄策略，无需增加例外。同步更新 `pnpm-lock.yaml`；锁文件中其它工具所需的传递 esbuild 依赖继续保留。

### 2. 统一构建入口与文档

根目录 `cli:build` 转发到 CLI workspace 的 `build`，与发布时的 `prepack` 使用同一个 Rolldown 构建脚本。`cli:check` 继续只检查类型。

同步 `packages/cli/README.md`、`packages/cli/RELEASING.md` 与 `agent-doc/operations.md` 的构建说明。本次没有配置字段、数据库、CLI 命令或 Admin API 行为变化。

## 验证

```bash
pnpm install --frozen-lockfile
# 通过；锁文件与现有依赖策略一致

pnpm run check
# runtime、CLI、Admin 与文档 TypeScript 检查通过

pnpm run lint
# lint 与格式检查通过

pnpm test test/invocations test/cli test/npm-release.test.ts
# 28 个测试文件、161 个用例通过

pnpm run cli:build
# 实际生成 packages/cli/dist/bin.js

pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
# prepack 成功，tarball 仅含 LICENSE、README.md、package.json 与 dist/bin.js

git diff --check
# 通过
```

额外将 tarball 解压到仓库外、没有 `node_modules` 的临时目录，使用 Node.js `26.13.0` 验证：

- `dist` 仅含 `bin.js`，保留 Node shebang；manifest 无 `dependencies` 或 `bundledDependencies`。
- `--help` 正常，`commands --json` 的 119 条命令与源码输出一致，非法命令保持退出码 2。
- `doctor --json` 通过现有本地 HTTP fixture，恰好请求 `/api/key` 与 `/api/invocations?limit=1`，不使用真实凭据或外部服务。
- 本地证据为 `dist/npm/tuuject-surowan-utils-0.0.1.tgz` 与 `dist/npm/smoke-result.json`，均为忽略产物；bundle 为 123864 字节，SHA-256 为 `88d7c8fe2b3c73fd30ed3c72c9977cc94aedecf2b71456e08b5dfa02a33da70e`。

代码提交后重新 fetch，`origin/develop` 没有新提交，无需 rebase。

未执行：Node.js 24 的独立运行验证、真实 registry 安装或发布；全量 `pnpm test`、Admin 浏览器 e2e 与文档站构建（本次仅修改 CLI 构建与对应说明）。

## 提交

```txt
97327cdd7b7a695c52f215637b38aae6b0fcc7f8 Build the CLI with Rolldown
```
