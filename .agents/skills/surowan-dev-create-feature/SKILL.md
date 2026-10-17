---
name: surowan-dev-create-feature
description: 在本仓库（surowan / Plastic Wan）开始任何新 feature 开发前的强制前置步骤：先从 origin/develop 拉取最新代码，再用 git worktree 在 ../<仓库文件夹名>.worktrees/feature/<feature 分支名> 建好工作树并切过去干活。用于 push 前的所有代码改动、修 bug、写测试、改文档；只要用户要求「开个 feature」「新开一个改动」「实现 xxx」「先拉最新 develop」「建 worktree」，或要动仓库里任何非只读文件，就先用这个 skill，即使用户没提 worktree 也要用。只读调查、跑测试、纯问答，以及已经位于 feature worktree 内的继续开发不需要。
---

# 创建 Feature Worktree 并开工

## 为什么

主目录 `~/Projects/<repo>` 是长期存在的基线 checkout；多个 feature 在同一个 checkout 上轮流切分支会互相踩脏、切分支丢状态。这个项目一致的做法是：**每个 feature 一个独立 worktree**，主目录不动。已有的工作树都长这样，直接沿用：

```text
~/Projects/plasticwan                                    # 主 checkout
~/Projects/plasticwan.worktrees/feature/bot-playground
~/Projects/plasticwan.worktrees/feature/compact-user-ids
```

新 feature 必须基于 `origin/develop` 的最新提交，而不是本地可能落后的 `develop`，避免一开始就落后、合并时才炸。

## 不适用

- 只读调查、跑测试、看代码、纯问答：不动文件，不开 worktree。
- 当前已经在某个 feature worktree 里开发（`git worktree list` 的输出中有当前分支）：那是本 skill 的产物，直接继续。
- 一次性的 hotfix、rebase、清理分支、发布准备：不属于「新 feature 开工」。

## 步骤

### 1. 确定 feature 名与仓库根

feature 名从用户的任务描述归纳（kebab-case，例如 `edit-active-time-in-admin-panel`）；用户已给名字就用用户的，`feature/` 前缀统一由本 skill 加，不要重复叠加。名字还没定就问一句。

并处理两种边界：

- 当前目录不是仓库根（`git rev-parse --show-toplevel` 报错或更深）时，先定位仓库根再动手。
- 仓库根自身是个 worktree（`.git` 是文件，`git rev-parse --git-common-dir` 指向主目录的 `.git/worktrees/...`）时，说明主目录已被别的 feature 占用；把工作基准切回主目录（`cd <主目录>` 或后续命令 `git -C <主目录>`），worktree 都挂在主目录旁边。

仓库文件夹名 `$NAME` 取仓库根的 basename；worktree 路径 = 仓库根父目录 + `$NAME.worktrees/feature/<feature 名>`（即 `../<仓库文件夹名>.worktrees/feature/<feature 名>`）。仓库根是主 checkout 时这就是字面路径；仓库根是 worktree 时兄弟目录名本来就等于 `$NAME.worktrees`，公式不变。

### 2. 先查重，再创建

功能开发中 skill 被反复触发是正常的，所以先判断，再决定建还是复用：

- `git worktree list` 里已经有这个分支 → `cd` 到它所在路径继续开发，别动该 worktree 的现有状态，也别重复 fetch。
- 分支不存在、且 worktree 路径为空 → 走第 3 步创建。
- 目标路径被非 worktree 的目录占用（用户自己建的、旧残留）→ 停下来报告路径与冲突，绝不删目录、绝不 `--force`。
- 分支已被别处签出（`git worktree list --porcelain` 能在某条 `branch refs/heads/...` 上找到它）→ 报告它属于哪个 worktree、让用户决定是继续用那个还是换个 feature 名，不要抢。

### 3. 新建 worktree

```bash
git -C "$REPO" fetch origin develop
git -C "$REPO" worktree add -b "feature/<name>" "$WORKTREE_PATH" origin/develop
```

这两条只读远端、只建新目录，不会碰主目录当前 checkout、不用 stash、也不用先切到 develop。

`git fetch` 失败（网络、鉴权）时**整个步骤中止**：报告失败，不要退回用可能落后的本地 `develop` 开工，也绝不静默继续。

如果本地 `develop` 领先 `origin/develop`（`git rev-list --count origin/develop..develop` > 0，或有未推送提交），明确告诉用户「这些提交不在此 worktree 里」——基于远端开分会丢东西，不要让它悄悄发生。

### 4. 切过去并准备

- `cd` 到 worktree，`git rev-parse --abbrev-ref HEAD` 确认分支正确。
- 按锁文件装依赖（本仓库是 pnpm：`pnpm install`，一般加 `--frozen-lockfile`）。每个 worktree 有独立的 `node_modules`，不装就跑 `pnpm test` 会得到假失败。
- 之后所有编辑、测试、提交都在 worktree 内进行，**不要碰主目录 checkout 的工作区**。

### 5. 汇报后继续

告诉用户：worktree 路径、分支名、base commit（`git rev-parse --short HEAD`），以及本地 develop 是否领先这类需要人知道的风险，然后直接开始用户的 feature 工作，不要停下来等确认。

## 反例（常犯）

- 跳过 fetch 直接 `git worktree add -b ... origin/develop`：用的是上次 fetch 的陈旧 ref，开头就落后别人几天的提交。
- 基于 `HEAD` / 本地 `develop` 建 worktree：用户要的是「最新 develop」，本地 ref 不一定最新。
- 在主 checkout 上切分支、stash、直接改代码：违背「一个 feature 一个 worktree」的约定，也会打断主目录上其它进行中的事。
- 绕过 worktree 在 `/tmp` 里 clone 一份：路径约定不一致，后续审计/清理都会漏掉它。
- 已有 worktree 或分支占用时直接报错放弃：应该复用并继续，或者停下来问，而不是换个名字硬建。
