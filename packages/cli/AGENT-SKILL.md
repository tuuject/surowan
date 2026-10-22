# 配套 Agent Skill

返回 [README](./README.md)。

源码仓库根目录的 [`skills/surowan-utils/SKILL.md`](../../skills/surowan-utils/SKILL.md) 给外部 Agent 使用：每次任务先运行 `surowan-utils doctor --json` 验证凭据与连通，再定位 Invocation、关联模型/工具/真实发送证据（只读核对可用 `config show`、`prompt get`、`models list`、`invocation prompts` 与 `invocation preflight`），最后在明确授权后重放（可带临时模型/thinking 覆盖）或分层比较 global/group prompt。它不是 Bot 的 `system:///` Skill，不需要服务器源码或数据库，也不增加 CLI 命令。

Skill 采用渐进披露：`SKILL.md` 是轻量入口，主题细节按当前任务加载子文档——审计流程在 `references/invocations.md`，重放的保真限制、授权要求与错误处理在 `references/replay.md`——不要一次加载全部内容。入口要求只有 `doctor` 以退出码 `0` 返回 `status: "ok"` 时才继续；失败即停止并请操作员用 `login` 修复（Agent 不代为执行、不重试、不读取或索取密钥），`--help` 只用于诊断 CLI 缺失或命令不匹配。

npm 包 **不再内置这个 Skill**；它随源码仓库根目录的 `skills/surowan-utils/` 分发。在目标项目根目录用 [skills CLI](https://github.com/vercel-labs/skills) 直接从 GitHub 安装：

```bash
npx skills add tuuject/surowan --skill surowan-utils
```

CLI 会询问装到哪些 Agent（也可用 `-a codex` 等直接指定），Codex 等读取的通用位置是 `.agents/skills/surowan-utils/SKILL.md`。不用 CLI 时，从源码仓库把整个目录复制到目标项目的根目录（以 [Codex 的项目级 Skill 目录](https://developers.openai.com/codex/build-skills) 为例）；如果目标已存在，先比较版本，不直接覆盖。未克隆仓库时，可从 GitHub 下载该目录（`SKILL.md`、`references/invocations.md`、`references/replay.md` 与 `agents/openai.yaml` 都要保留）。最终布局应为 `.agents/skills/surowan-utils/SKILL.md`，不要多嵌套一层目录。skills CLI 未覆盖的 Agent 按其自身 Skill 导入机制注册，不假定兼容 Codex 的目录。

重新打开 Agent 会话，确认发现 `surowan-utils` 后可请求：

> 使用 $surowan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

由操作员准备凭据：向 Agent 的命令执行环境安全注入 `SUROWAN_ENDPOINT` 与 `SUROWAN_API_KEY`，或由操作员在本机运行 `surowan-utils login` 保存到凭据文件。Agent 只运行 `doctor` 与查询命令，不自己读取、打印或修改凭据，也不要把 key 放入 Skill 或聊天。Skill 不随 CLI 升级自动更新：用 skills CLI 安装的运行 `npx skills update surowan-utils`，手工复制的在同步仓库更新时一并检查版本。是否允许注册、执行命令及访问网络，仍取决于宿主权限。
