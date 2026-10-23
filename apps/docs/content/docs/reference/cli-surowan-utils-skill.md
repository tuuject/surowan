---
title: 让外部 Agent 使用配套 Skill
description: 为外部 Agent 安装并运行 surowan-utils Skill。
---

# 让外部 Agent 使用配套 Skill


源码仓库根目录内置 `skills/surowan-utils/`，指导外部 Agent 先运行 `doctor` 验证凭据与连通，再定位 Invocation（可按关键词与公开消息时间用 `invocation list --search/--at/--from/--to` 搜索）、核对模型调用/工具/真实发送记录；只读核对可用 `config show`、`prompt get`、`models list`、`invocation prompts` 与 `invocation preflight`，并在明确授权后重放（含用 `--before-send` 限定窗口的切片重放、`--provider`/`--model`/`--thinking-level` 临时模型覆盖）或分层比较 global/group prompt。它不是 Bot 的只读 System Skill，无需放入服务器的 `system:///` 资源树。Skill 以 `SKILL.md` 为轻量入口，主题细节按当前任务加载子文档：审计流程见 `references/invocations.md`，重放的保真限制、授权要求与错误处理见 `references/replay.md`，不要一次加载全部内容。

**npm 包不内置 Skill，安装 CLI 也不会自动启用 Skill。** 推荐用 [skills CLI](https://github.com/vercel-labs/skills) 直接从 GitHub 安装；手工复制的步骤以 [Codex 的项目级目录](https://developers.openai.com/codex/build-skills)为例，其他宿主请使用其自己的 Skill 导入功能，不假定自动兼容。

1. 先按上文全局安装 CLI，运行 `surowan-utils --help` 确认命令可用。
2. 在准备用 Agent 排障的项目根目录安装 Skill：

   ```bash
   npx skills add tuuject/surowan --skill surowan-utils
   ```

   CLI 会询问装到哪些 Agent，也可用 `-a codex` 等直接指定；Codex 等读取的通用位置是 `.agents/skills/surowan-utils/SKILL.md`。

   不用 skills CLI 时，从源码仓库复制整个 Skill 目录（仓库根的 `skills/surowan-utils/`，`SKILL.md`、`references/` 与 `agents/openai.yaml` 都要保留）。若目标已存在，先比较内容再决定更新，不直接覆盖。未克隆仓库时，可从 GitHub 下载该目录；最终文件应位于 `.agents/skills/surowan-utils/SKILL.md`，不要多嵌套一层。克隆仓库后：

   ```powershell
   $source = '<仓库检出路径>\skills\surowan-utils'
   $target = '.agents/skills/surowan-utils'
   if (Test-Path $target) { throw 'Skill already exists; review it before updating.' }
   New-Item -ItemType Directory -Path '.agents/skills' -Force | Out-Null
   Copy-Item -LiteralPath $source -Destination $target -Recurse
   ```

   Bash / Zsh：

   ```bash
   test ! -e .agents/skills/surowan-utils &&
     mkdir -p .agents/skills &&
     cp -R /path/to/surowan/skills/surowan-utils .agents/skills/
   ```
3. 由操作员准备凭据：向 Agent 的命令执行环境安全注入 `SUROWAN_ENDPOINT` 与 `SUROWAN_API_KEY`，或由操作员在本机运行 `surowan-utils login` 保存到凭据文件。不要让 Agent 索取聊天中的明文 key，也不要让它读取或修改凭据。
4. 在 Agent 的 Skill 列表中确认 `surowan-utils`；未发现时重新打开会话。然后发出只读任务：

   > 使用 $surowan-utils 审计 Invocation 12345，说明为什么没有回复；先只查询，不执行重放。

Skill 要求 Agent 每次任务先运行 `surowan-utils doctor --json`，使用同一凭据与 endpoint；只有退出码 `0` 且 `status` 为 `ok` 才继续读取对应指南并执行查询或重放。`doctor` 失败时 Agent 停止并报告错误，提醒操作员在本机用 `login` 修复，不循环重试、不自动登录或改动凭据，也不从聊天或存储直接读取 key；`--help` 只用于客户端缺失或命令不匹配时的诊断。

Skill 默认先报告审计证据；重放需要明确确认目标、次数和可选的 global/group prompt 覆盖，且不会自动重试。重放从源开场批次的冻结公开消息与当时可证明存在的历史重建场景，使用当前 Chat 的 prompt、模型与工具定义，不依赖 Developer 报文录制；global/group 两层可临时覆盖，固定协议不可覆盖。切片重放（`--before-send`）把输入收窄到某次成功 Bot 发言之前的窗口，需 `--confirm-paid` 显式确认计费。它不恢复私有推理；默认重放不加入后续热注入，切片模式只拍平可证明在目标发送前已注入的批次。合成发送成功不等于生产发送成功。查询结果（含搜索命中的 `matched_messages` 摘要）也可能包含私密消息和 prompt，不要直接公开完整输出。

Skill 不随 CLI 升级自动更新：用 skills CLI 安装的运行 `npx skills update surowan-utils`；手工复制的是本地副本，同步源码仓库时一并更新（升级 CLI 命令如 `npm install -g @tuuject/surowan-utils@latest`）。宿主仍须允许命令执行和访问相应 endpoint，安装 Skill 本身不会授予权限。
