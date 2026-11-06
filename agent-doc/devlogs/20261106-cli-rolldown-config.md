# Surowan - 20261106 CLI 使用 Rolldown 原生配置

## 背景

用户明确要求使用 Rolldown 自己的配置文件，移除 `packages/cli/build.ts` 的程序化构建入口。

## 主要变更

- 将 `packages/cli/build.ts` 替换为 `packages/cli/rolldown.config.ts`，通过 `defineConfig` 导出配置；不再直接调用 `build` API 或手工删除输出目录。
- CLI workspace 的 `build` 使用 `rolldown -c`，`prepack` 使用 `pnpm run build`，仓库根 `cli:build` 继续转发到同一入口。
- 配置使用 `output.dir: 'dist'`、`entryFileNames: 'bin.js'` 与 `cleanDir: true`，保留自包含单文件 ESM、Node.js 24 转换目标与关闭代码拆分的发布契约。当前 Rolldown 的清理需配置 `output.dir`；仅设置 `output.file` 时会留下旧文件，已通过残留文件探针验证。
- 将配置文件纳入 CLI TypeScript 检查，同步安装、发布、运维说明与测试注释中的构建入口引用。

不新增依赖、配置字段或数据库迁移，不修改 CLI 命令与 Admin API 行为。

## 验证

```bash
pnpm install --frozen-lockfile
# 通过，锁文件无变化

pnpm run check
pnpm run cli:check
# 全仓库检查通过；最终配置的 CLI 类型检查通过

pnpm run lint
git diff --check
# 通过

pnpm test test/invocations test/cli test/npm-release.test.ts
# 28 个文件、161 个用例通过

pnpm run cli:build
pnpm --filter @tuuject/surowan-utils pack --pack-destination "$PWD/dist/npm"
# 两条入口均通过 Rolldown CLI 加载配置；预先放置的残留文件均被清理
```

tarball 仅含 LICENSE、README.md、package.json 与 dist/bin.js。解压到仓库外、没有 `node_modules` 的临时目录后，Node.js 26.13.0 下的 `--help`、119 条面板命令与源码一致性、非法命令退出码 2、本地 HTTP fixture 的 `doctor` 两次只读请求均通过。

证据保存在忽略产物 `dist/npm/tuuject-surowan-utils-0.0.1.tgz` 与 `dist/npm/smoke-result.json`。`dist/bin.js` 为 123864 字节，SHA-256 为 `88d7c8fe2b3c73fd30ed3c72c9977cc94aedecf2b71456e08b5dfa02a33da70e`，与程序化入口生成的文件一致。

代码提交后重新 fetch，`origin/develop` 无新增提交，无需 rebase。

未执行：Node.js 24 独立运行验证、真实 registry 安装或发布；全量 `pnpm test`、Admin 浏览器 e2e 与文档站构建（本次仅修改 CLI 构建配置与对应说明）。

## 提交

```txt
ff4a34182496d0349cc7236cf58448e237e11145 Use the Rolldown CLI configuration
```
