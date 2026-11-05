---
name: surowan-dev-create-feature
description: 本仓库（surowan / Surowan）的 git worktree 工作流，覆盖三件事：一是开始任何新 feature 开发前的强制前置步骤——先从 origin/develop 拉取最新代码，再在 ../<仓库文件夹名>.worktrees/feature/<feature 分支名> 建好工作树并切过去干活；二是实现需求时做完后的交付——验证、git commit、写 devlog、git push、用 gh 开 PR；三是 review、修改、合并 PR——无论是本仓库分支还是外部贡献者 fork 的 PR，都在 ../<仓库文件夹名>.worktrees/review/pr-<N> 检出审阅，fork PR 先审执行面再装依赖跑测试，合并锁定 review 过的 head。用于 push 前的所有代码改动、修 bug、写测试、改文档；只要用户要求「开个 feature」「新开一个改动」「实现 xxx」「先拉最新 develop」「建 worktree」「review / 看看 PR #N」「合并这个 PR」「处理外部贡献」，或要动仓库里任何非只读文件，就先用这个 skill，即使用户没提 worktree 也要用。只读调查、跑测试、纯问答，以及已经位于 feature worktree 内的继续开发不需要。
---

# Surowan 的 Worktree 工作流：Feature 开工与 PR Review

本文件的步骤是**新 feature 开工**；如果任务是实现一个需求，做完后接着走[实现需求：做完即交付](#实现需求做完即交付)，一直到开出 PR。review、修改或合并 PR（本仓库分支与外部 fork 都算）读 [references/review-pr.md](references/review-pr.md)，它沿用这里的路径约定与查重规则。

## 为什么

主目录 `~/Projects/<repo>` 是长期存在的基线 checkout；多个 feature 在同一个 checkout 上轮流切分支会互相踩脏、切分支丢状态。这个项目一致的做法是：**每个 feature 一个独立 worktree**，每个被 review 的 PR 也一个，主目录不动。已有的工作树都长这样，直接沿用：

```text
~/Projects/surowan                                    # 主 checkout
~/Projects/surowan.worktrees/feature/bot-playground
~/Projects/surowan.worktrees/feature/compact-user-ids
~/Projects/surowan.worktrees/review/pr-51             # PR review，detached 在 PR head
```

新 feature 必须基于 `origin/develop` 的最新提交，而不是本地可能落后的 `develop`，避免一开始就落后、合并时才炸。

## 不适用

- 只读调查、跑测试、看代码、纯问答：不动文件，不开 worktree。（review PR 虽然不改文件，但要检出 PR 的代码，走 review 流程。）
- 当前已经在某个 feature worktree 里开发（`git worktree list` 的输出中有当前分支）：那是本 skill 的产物，直接继续；做完仍走「实现需求：做完即交付」。
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

## 实现需求：做完即交付

用户要的是「实现某个需求」（新功能、修 bug、按 PRD 落地等，产出要合回 develop）时，worktree 只是开头：改完后按下面的顺序一路走到开 PR。「实现 xxx」这句话本身就授权了本节的 commit、push 与开 PR，不必逐步再问；**合并 PR 不在授权内**，仍等用户明确说。

不走本节：试验或探索性改动、用户说了先别提交、`doc/design` 例外（直接在 develop 上做），以及 PR review（按 [references/review-pr.md](references/review-pr.md)）。

### 1. 验证

按 AGENTS.md「Testing Guidelines」跑：`git diff --check`、`pnpm run lint`、`pnpm run check`、受影响测试；跨模块改动跑完整 `pnpm test`；动了 Admin 前端、admin API 或面板文案跑对应 `pnpm run admin:test:e2e <套件>`；动了文档站或会进生成文档的 Schema/示例跑 `docs:build` 与 `docs:verify`。行为变了就同步 `agent-doc/` 对应主题文档。失败先修；修不好就停在这里报告，不要带着失败往下提交。

### 2. 提交代码

- 只 `git add` 本次改动的路径，不用 `git add -A`；`dev-data/`、`key.json`、SQLite、媒体缓存、备份不入库。
- 标题是简短英文祈使句（如 `Add configurable empty-text send strategies`），结尾带当前会话要求的 commit attribution。
- 依赖有变化时 `pnpm-lock.yaml` 一起提交。

一个需求通常一个代码提交；明显独立的几块可以拆开，devlog 仍只写一篇。

### 3. 对齐最新 develop

`git fetch origin develop`；`origin/develop` 有新提交就 `git rebase origin/develop`，然后重跑受影响的验证。冲突拿不准怎么解就停下报告。这一步必须在写 devlog 之前：devlog 记录的是最终提交 hash，rebase 会改掉它。

### 4. 写 devlog

用 `write-devlog` skill 写 `agent-doc/devlogs/<YYYYMMDD>-<feature 名>.md`（日期取当天），记录背景、主要变更、验证结果（含未执行的检查）与第 2 步的提交 hash，单独提交为 `docs: add <改动简述> devlog`。不回改旧 devlog。

### 5. Push

```bash
git push -u origin "feature/<name>"
```

只有分支此前推送过、且第 3 步 rebase 过时，才用 `--force-with-lease` 推这个 feature 分支；其他被拒的情况（远端有别人的提交等）报告给用户，不要 `--force`。任何情况都不直接推 `develop` 或 `main`。

### 6. 开 PR

先查重：`gh pr list --head "feature/<name>" --state open`。已有 PR 就只靠 push 更新，必要时 `gh pr edit` 补充说明，不再新开。否则把正文写进 scratchpad 文件再创建：

```bash
gh pr create --base develop --head "feature/<name>" --title "<代码提交标题>" --body-file <scratchpad>/pr-body.md
```

正文用中文，沿用仓库已有 PR 的结构（可参考 `gh pr view 56`）：

```markdown
## 行为变化

## 配置与数据库影响

## 验证

（实际跑过的命令与结果；最后一行写「未执行：……」，如真实 Telegram 验收）

## 提交

- `<hash>` <代码提交标题>
- `<hash>` docs: add <改动简述> devlog
```

结尾带当前会话要求的 PR attribution。正文不要写裸 `@名字`。

### 7. 汇报

告诉用户 PR 链接、提交列表、验证结论与未执行项。不合并、不删 worktree、不删分支。

## PR Review 速览

完整步骤见 [references/review-pr.md](references/review-pr.md)。最容易出错的几条先记住：

- 检出：`git fetch origin develop "+pull/<N>/head:refs/remotes/origin/pr/<N>"`，核对它等于 `headRefOid` 后在 `../$NAME.worktrees/review/pr-<N>` 建 detached worktree，钉在 `headRefOid`；不在主 checkout 上 `gh pr checkout`，不放 `/tmp`。
- 外部 fork 的代码不可信：先读 `package.json`、锁文件、`pnpm-workspace.yaml`、`scripts/`、`.githooks/`、`.github/`、测试配置与 `skills/` 的 diff，确认无害后才 `pnpm install` 和跑测试。
- PR 上的 CI 不跑全量 `pnpm test` 和 Admin e2e，合并前要在本地跑。
- 发评论、approve、推送到 fork、合并都是对外动作，用户明确授权后才做；合并用 `gh pr merge <N> --merge --match-head-commit <headRefOid>`。

## 反例（常犯）

- 跳过 fetch 直接 `git worktree add -b ... origin/develop`：用的是上次 fetch 的陈旧 ref，开头就落后别人几天的提交。
- 基于 `HEAD` / 本地 `develop` 建 worktree：用户要的是「最新 develop」，本地 ref 不一定最新。
- 在主 checkout 上切分支、stash、直接改代码：违背「一个 feature 一个 worktree」的约定，也会打断主目录上其它进行中的事。
- 绕过 worktree 在 `/tmp` 里 clone 一份或建 worktree：路径约定不一致，后续审计/清理都会漏掉它。
- 已有 worktree 或分支占用时直接报错放弃：应该复用并继续，或者停下来问，而不是换个名字硬建。
- 实现需求后只汇报改动就收工，留下未提交的 worktree：用户要的是一个能审的 PR。
- 先写 devlog 再 rebase：devlog 里的提交 hash 随即失效。

## 例外情况

对于纯粹是增加和修改 `doc/design` 的需求，可以直接在 `develop` 分支做。但是不含 `main` 分支。
