# Surowan - 20261106 CLI 发布产物改为自包含 bundle

## 背景

`packages/cli`（发布名 `@tuuject/surowan-utils`）的运行时依赖 `@surowan/admin-surface` 是 `private: true` 的内部 workspace 包。用 bun 全局安装时解析失败：

```txt
$ bun i -g @tuuject/surowan-utils@canary
error: GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404
error: @surowan/admin-surface@^0.1.0 failed to resolve
```

这不是漏发。第一次修复（commit `7729e903`，canary `0.0.0-canary.44.1`）把它从 `dependencies` 移到 `devDependencies`、只保留 `bundledDependencies`，tarball 里确实带着 `node_modules/@surowan/admin-surface` 的 33 个文件，`npm install` 用这份副本正常。但 registry 上的 canary 44 在 bun 1.4.0 上仍然 404：

```txt
$ bun add @tuuject/surowan-utils@canary
error: GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404
error: @surowan/admin-surface@* failed to resolve
```

注意范围变成了 `@*`——bun 是在解析 `bundledDependencies` 里的名字，而不是 `dependencies`。也就是说只要包名以任何形式出现在发布 manifest 的依赖字段里，bun 就绕开 tarball 内的副本去 registry 取（`oven-sh/bun#27418`，未修）。本地 tarball 安装看不出来，只有 registry 安装暴露。结论：bundled dependency 方案在 bun 上不可用。

## 主要变更

### 1. esbuild 打包成单文件，发布 manifest 无依赖字段

新增 `packages/cli/build.ts`：清空 `dist` 后把 `src/bin.ts` bundle 成单个 `dist/bin.js`，`@surowan/admin-surface` 的代码直接内联，输出中不再出现该 import。

```ts
await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  charset: 'utf8',
  logLevel: 'info',
});
```

`packages/cli/package.json`：删除 `bundledDependencies`，`build` / `prepack` 都改为 `node build.ts`；`@surowan/admin-surface` 与 `esbuild@0.28.2` 只在 `devDependencies`（前者供类型检查与打包解析，后者供构建）。`bin` 仍是 `./dist/bin.js`，`files` 仍是 `["dist", "README.md"]`，包对外形态不变，只是 `dist` 从 12 个模块变成 1 个 118 KB 文件。

`packages/cli/tsconfig.json`：`tsc` 退化为类型检查（`noEmit`），移除 `declaration` / `outDir` / `rootDir` / `rewriteRelativeImportExtensions`；`allowImportingTsExtensions` 与 `noEmit` 搭配合法。`pnpm run cli:check` 不变。

### 2. 测试固定「manifest 不出现该包名」

`test/npm-release.test.ts` 上一版断言的是 `devDependencies` + `bundledDependencies` 形态，等于把在 bun 上失败的配置钉死。现在断言 `dependencies` 与 `bundledDependencies` 都不存在，`devDependencies` 里 `@surowan/admin-surface` 仍是 `workspace:^`。

### 3. 文档

- `packages/cli/README.md`：安装段说明产物是单文件自包含 bundle、manifest 无依赖，bun 上出现该 404 说明装的是 ≤ `0.0.0-canary.44.1` 的旧产物；构建说明从 `rewriteRelativeImportExtensions` 改为 esbuild bundle。
- `packages/cli/RELEASING.md`：记录为什么该包名不得出现在任何发布依赖字段、不得单独发布，构建必须走 `node build.ts`。

## 验证

```bash
# registry canary 44 在 bun 1.4.0 上复现（范围 @*，即解析 bundledDependencies）
bun add @tuuject/surowan-utils@canary
# error: GET https://registry.npmjs.org/@surowan%2fadmin-surface - 404

# 新产物：dist 只有 bin.js，bundle 内不再出现该 import
pnpm --filter @tuuject/surowan-utils build
grep -c "@surowan/admin-surface" packages/cli/dist/bin.js   # 0

# tarball 只剩 LICENSE / dist/bin.js / package.json / README.md，
# manifest 无 dependencies、无 bundledDependencies
pnpm --filter @tuuject/surowan-utils pack --pack-destination /tmp/packv2

# bun 全局安装（临时 BUN_INSTALL，不污染本机）+ 运行
BUN_INSTALL=/tmp/bv2install bun add -g /tmp/packv2/tuuject-surowan-utils-0.0.1.tgz
/tmp/bv2install/bin/surowan-utils commands
/tmp/bv2install/bin/surowan-utils doctor --json   # {"status":"ok",...}

# npm 全局安装 + 运行
npm i -g --prefix /tmp/nv2prefix /tmp/packv2/tuuject-surowan-utils-0.0.1.tgz
/tmp/nv2prefix/bin/surowan-utils commands

pnpm run cli:check       # tsc --noEmit 通过
npx tsc --noEmit         # 仓库根通过
pnpm test test/npm-release.test.ts test/cli
npx biome lint . && npx biome format .
```

未执行：registry 上的新 canary 安装（需要下一次 `main` push 暂存并经维护者 `npm stage approve` 后才能验证，本地 tarball 与 registry 安装的唯一差异就是 manifest 里的依赖字段，现已为空）；`pnpm run check` 全量与 Admin Panel e2e（未触及面板与 runtime）。

## 提交

```txt
Build the CLI into a self-contained bundle
```
