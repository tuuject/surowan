# Surowan - 20261106 版本号解析改用 semver 库

## 背景

`src/platform/version.ts` 最初为了同时处理 Release / Staging / Develop 三种 Channel，自己写了一套版本正则解析与 `comparePrerelease` 比较逻辑。PRD 只要求「遵循 semver 规范」，仓库也从未引入 `semver` 依赖，结果是 SemVer 的核心规则（prerelease 标识符的数字/字母排序、数字标识符禁止前导零）由手写代码维护，与规范存在漂移风险。

本次把「解析 + Release 排序」交给 `semver` 库，Channel 判定与跨 Channel 优先级仍由本项目维护，因为那部分不是 SemVer 的语义。

## 主要变更

### 1. 用 `semver.parse` 解析版本

`src/platform/version.ts` 先移除 `v` 前缀，再调用 `semver.parse` 做规范校验并取得 `major` / `minor` / `patch` / `prerelease`，随后只根据 prerelease 文本判定 Channel：

```ts
const parsed = parse(withoutPrefix);
if (parsed === null) {
  return undefined;
}
const prereleaseText = parsed.prerelease.join('.');
```

Staging（`next-<14 位时间戳>`）、Develop（`develop[-<hash>]`，且基础版本必须为 `0.0.0`）与非法后缀拒绝的规则保持不变。

### 2. Release 排序改用 `semver.compare`

删除手写的 `comparePrerelease`，`compareParsed` 的 Release 分支直接调用 `compare(left.semver, right.semver)`；跨 Channel 时仍先比较基础版本，再按 `Release > Staging > Develop` 排序。Staging 的时间戳排序与 Develop 的 hash 排序保持原样。

### 3. 依赖与测试

- `package.json` 新增运行时依赖 `semver@^7.8.6` 与开发依赖 `@types/semver@^7.8.0`；`pnpm-lock.yaml` 同步，`sharp` 的传递依赖 semver 从 7.8.5 归并到 7.8.6。
- `test/version.test.ts` 增加 SemVer 规范中的完整 prerelease 优先级序列（`alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < 1.0.0`）、build metadata 不参与比较，以及带前导零版本被拒绝的断言。

按 SemVer 规范收紧校验后，`v01.2.3`、`v1.0.0-01` 这类版本不再被接受；`version` 文件声明非法版本时仍回退 Git 或固定 Develop 版本，行为不变。

## 验证

```bash
git diff --check
# 无输出

pnpm run lint
# biome lint + format 通过（1241 / 1238 个文件）

pnpm run check
# runtime / CLI / Admin / docs TypeScript 检查通过

pnpm exec vitest run test/version.test.ts
# 8 passed

pnpm test
# 366 files passed；1746 tests passed

node --input-type=module -e "import { parseVersion } from './src/platform/version.ts'; ..."
# v1.2.3 / v0.0.0-next-20261102190940 / v0.0.0-develop-deadbeef 解析正确，v1.2 与 v0.0.0-develop- 返回 undefined
```

Dockerfile 在构建期用 `node --input-type=module` 直接 import `parseVersion` 写入 `/app/version`，上面的冒烟命令复现了同一路径。

## 未执行

- 真实 `docker build`：本次只新增运行时依赖，镜像运行阶段会复制生产 `node_modules`，但未实际构建镜像验证。
- 真实 Telegram 验收：本改动只影响版本解析与出站 UA 字符串，不涉及 Telegram 链路。

## 提交

```txt
c5e81e0 Use semver library for version handling
```
