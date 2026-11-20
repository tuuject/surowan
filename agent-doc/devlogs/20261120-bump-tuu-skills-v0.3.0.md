# Surowan - 20261120 共用 Skill 升级到 tuuject/skills v0.3.0

## 背景

本仓库从 [tuuject/skills](https://github.com/tuuject/skills) 安装 `tuu-create-feature` 和 `tuu-review-design-prd`，之前锁定的是 `v0.2.0`。agent 把代码逻辑把关之后，人真正要亲自确认的往往是界面看起来、用起来的样子。对着一段外观描述做验收，读得慢，描述也未必和实际一致。`v0.3.0` 把这一步改成交图和视频。

## 主要变更

### 1. `tuu-create-feature` 的界面验收

`v0.3.0` 只改了 `tuu-create-feature`，`tuu-review-design-prd` 的内容哈希不变：

- 交付流程新增「界面改动：截图与录屏」一步：静态外观给同场景的改前改后截图，交互改动派 QA subagent 录屏，汇报和 PR 的「界面」一节直接放图。
- 截图与录屏用项目里维护的脚本：AGENTS.md 写了就用；没写先在仓库里找，找不到再新建并登记到 AGENTS.md。产物不入库。
- 改前截图在动界面代码之前拍。漏拍或 review PR 时，在 `../<仓库>.worktrees/baseline/<feature 名或 pr-N>` 建 detached worktree，钉在合并基点补拍，拍完删掉。
- 细节在 `tuu-create-feature/references/ui-acceptance.md`。

本仓库 AGENTS.md 还没有登记截图 / 录屏命令。按新流程，下一个改 Admin Panel 界面的需求会先在现有的 Playwright 设施（`apps/admin-next`）里找可复用的部分，找不到就新建脚本，并登记到 AGENTS.md。

### 2. 锁定新 tag

`package.json` 的 `skills` 字段把 `tuuject/skills` 的 `ref` 从 `v0.2.0` 改为 `v0.3.0`，`pnpm run skills:sync` 同步更新了 `skills-lock.json`：两条记录的 `ref` 都改了，`tuu-create-feature` 的 `computedHash` 也变了。

## 验证

```bash
pnpm run skills:sync
# Installed tuu-create-feature, tuu-review-design-prd from tuuject/skills
# .claude/skills/tuu-create-feature/references/ 下有 review-pr.md、ui-acceptance.md

git diff --check
# 无输出

pnpm run lint
# 退出码 0；biome lint 与 biome format 均 No fixes applied.

pnpm run check
# 退出码 0
```

未运行：`pnpm test`，这次没有改源码和测试；`docs:build` / `docs:verify` 也没跑，因为没有改 `apps/docs/`。

## 提交

```txt
7b4f6588 Bump shared skills to tuuject/skills v0.3.0
```
