# Surowan - 20261113 开发流程 Skill 迁往 tuuject/skills

## 背景

`surowan-dev-create-feature`（worktree 开发、交付与 PR review）和 `surowan-dev-review-design-prd`（PRD 审阅）原本是本仓库 `skills/` 下的仓库 Skill。tuuject 的其他项目（如 tuuject/design）也要用同一套流程，所以把这两个 Skill 移到 [tuuject/skills](https://github.com/tuuject/skills)，各项目再用 skills CLI 安装。

`surowan-dev-bake-product-knowledge` 留在本仓库。它读写本仓库的用户手册和 `src/platform/prompts/`，还要在 Skill 自己的目录里维护 `references/provenance.md`。如果装成外部 Skill，这份记录会在下次同步时被覆盖。

## 主要变更

### 1. 共用版本（tuuject/skills `v0.1.0`）

Skill 改名为 `tuuject-dev-create-feature` 和 `tuuject-dev-review-design-prd`。流程本身没变，项目专属的内容改成运行时读项目 AGENTS.md：

- 集成分支：AGENTS.md 指定了就用它；没指定时远端有 `develop` 就用 `develop`，否则用远端默认分支。本仓库探测结果是 `develop`，tuuject/design 是 `main`。
- 验证命令、不入库的文件、提交与 PR 说明、devlog 目录和合并方式，都改为按 AGENTS.md 执行；AGENTS.md 没写时用 Skill 给出的默认做法。本仓库 AGENTS.md 已经写明了这些，所以对本仓库来说行为不变。原来写死的 PR 正文结构（参考 #56）改为沿用最近合并的 PR。

### 2. 本仓库改为外部 Skill 安装

`package.json` 的 `skills` 字段新增一项，用 tag 锁定版本：

```json
{
  "source": "tuuject/skills",
  "ref": "v0.1.0",
  "skills": [
    "tuuject-dev-create-feature",
    "tuuject-dev-review-design-prd"
  ]
}
```

`skills-lock.json` 新增两条记录及其内容哈希，同时删除 `skills/surowan-dev-create-feature/` 和 `skills/surowan-dev-review-design-prd/`。

### 3. 文档

- `agent-doc/operations.md` 补充说明这两个 Skill 的来源，以及要改流程本身应该去哪里改。另外改正了原文「`ref` 锁定 tag 或 commit」的说法：skills 1.7.2 用 `git clone --branch <ref>` 拉取，commit hash 不能当 `ref` 用。
- `agent-doc/design/` 里有三篇进行中的交接文档还在用旧 Skill 名派发任务，已改成 `tuuject-dev-create-feature`。

## 验证

```bash
pnpm run skills:sync
# Installed tuuject-dev-create-feature, tuuject-dev-review-design-prd from tuuject/skills
# 旧 Skill 的链接已清理；.claude/skills 现有 open-code-review、surowan-dev-bake-product-knowledge、
# surowan-mcp、surowan-utils，以及这两个 tuuject-dev-*

git diff --check
# 无输出

pnpm run lint
# 退出码 0；Checked 1328 files. No fixes applied.

pnpm run check
# 退出码 0
```

未运行：`pnpm test`，因为这次没有改源码和测试，只改了 Skill 文件、`package.json` 的 `skills` 字段和文档；`docs:build` / `docs:verify`，因为没有改 `apps/docs/`。

## 提交

```txt
ea62371a Install shared dev workflow skills from tuuject/skills
```
