# 参与贡献

感谢你愿意改进塑料碗。提交 Issue 的注意事项见 [README](README.md#参与贡献)；本文面向要修改代码的人。

## 准备环境

先按[宿主机运行](apps/docs/content/docs/start/installation.md#宿主机运行)准备 Node.js 24+、pnpm 与媒体依赖，并完成依赖安装和本地配置。项目使用 TypeScript ESM，Node.js 直接执行 `.ts`，没有单独的编译步骤。

## 常用命令

```bash
pnpm run check   # 严格 TypeScript 检查（runtime / Admin / docs）
pnpm test        # 全部行为测试
pnpm run lint

# 两个独立的前端开发入口
pnpm run admin:dev   # 管理面板，127.0.0.1:5273，需配合运行中的 Bot/Admin 后端
pnpm run docs:dev    # 文档站，127.0.0.1:5274
```

生产管理面板通过 `pnpm run admin:build` 构建，由 Bot 服务托管。改动管理面板或其可见文案时，还要运行 `pnpm run admin:test:e2e`。完整的验证矩阵见 [agent-doc/verification.md](agent-doc/verification.md)。

`pnpm install` 会顺带把仓库自带的 Coding Agent Skill（`skills/`）链接到 `.agents/skills/` 与 `.claude/skills/`，并安装 `package.json` 的 `skills` 字段里锁定版本的外部 Skill；新增 Skill 或改了该字段后运行 `pnpm run skills:sync`。说明见 [agent-doc/operations.md](agent-doc/operations.md#coding-agent-skills)。

## 提交检查（pre-commit）

`.githooks/pre-commit` 拒绝超过 5,000 Token（按 `字节数 / 4` 估算，即单文件最多 20,000 字节）的文件，保证 Coding Agent 总能一次读完整个文件。`pnpm install` 实际安装依赖时由 root `postinstall` 把 `core.hooksPath` 指向 `.githooks`（没有 `.git` 的目录跳过，冲突只警告）；依赖已是最新时 pnpm 不跑 `postinstall`，已有 checkout 手动执行一次 `pnpm run hooks:install`。`core.hooksPath` 已指向别处，或默认 hooks 目录里已有非 `.sample` 的 hook 时，脚本不会覆盖，只报告冲突。

- 只检查本次提交的暂存内容（新增、修改、类型变更），不看工作区：未暂存的改动与未跟踪文件不影响提交，删除超限文件总能提交；`git commit -a` 与 `git commit <path>` 检查的是 Git 即将提交的那份 index。完成合并时只检查内容与 `MERGE_HEAD` 也不同的路径，即本次解决冲突或合并改写的文件。
- 不检查的文件：Git 判定为二进制的文件（`.gitattributes` 的 `binary` 或含 NUL 字节），以及 `scripts/file-token-limit.ts` 中 `IGNORED` 列出的锁文件、`*.gen.ts` 代码生成、`patches/*.patch`、shadcn 引入的 `apps/admin-next/src/components/ui/**`、全部 Markdown（`**/*.md` 与 `**/*.mdx`，含 `agent-doc/` 与系统 Prompt 分区；维护者决定文档不设上限、不为上限拆分），和整个 `agent-doc/`（`research/` 下的 `measurements.json`、`verification.json` 是脚本抓取的数据）。除此之外只有工具生成、无人手改的文件才能加入 `IGNORED`；手写文件超限就拆分。
- 拒绝时的错误信息列出每个超限文件的 Token 数、字节数与超出量，并按源码、测试与其他文件分别给出拆分步骤。

## 仓库结构

```text
src/                    Bot 运行时、调度、上下文、工具与 SQLite
apps/admin-next/        React 管理面板
apps/docs/              中文使用文档与安全配置示例
packages/image-service/ 图片生成核心包
agent-doc/              架构、配置、运维与维护者文档
scripts/                维护及验证脚本
skills/                 Coding Agent Skill 源（不是 Bot 的 System Skill）
test/                   行为测试
```

## 约定

编码风格、测试要求、提交信息格式和安全不变量统一写在 [AGENTS.md](AGENTS.md)；架构与数据流见 [agent-doc/](agent-doc/README.md)。提交 PR 时请说明行为变化、数据库/配置影响和验证结果。
