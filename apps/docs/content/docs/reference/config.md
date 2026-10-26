---
title: 配置参考
description: 按配置节理解 Surowan 的必填项、覆盖关系与运行风险。
---

# 配置参考

下载机器可校验的 [JSON Schema](__DOCS_BASE__/config.schema.json) 和 [完整 JSONC 样例](__DOCS_BASE__/examples/config.example.jsonc)。Schema 是字段类型与范围的权威；本页解释任务中的组合关系，最终以目标版本的 `check-config` 为准。

## 顶层节

| 配置节 | 用途与要点 |
| --- | --- |
| `version` | 当前必须为 `1`。 |
| `data_dir`、`paths` | 运行锁、SQLite、媒体缓存与备份位置；Docker 使用 `/data/...`。修改需重启。 |
| `timezone` | 默认 IANA 时区；Chat 可单独覆盖。 |
| `telegram` | 可选段：Token 引用、Bucket、allowlist、Topic、管理员与参与策略。整段省略或没有 token 时 Telegram 停用，管理面板与虚拟群聊照常工作；段内 `chats` 可以是空数组。 |
| `providers` | 已启用 Provider 与模型定义；凭据使用 SecretRef。 |
| `agent` | 可选段：主模型、Prompt、全局 Token 预算、并发、Context 和发送限流，整段可省略；全部字段可热应用，模型与 Prompt 之外的字段可在 [Harness tuning](../configure/admin-harness-tuning.md#harness-tuning) 页编辑。 |
| `vision` | 可选段：图片/Sticker 模型、并发、独立 Token 与图片日预算，整段可省略或写 `null`/`{}`，其余字段有默认值。`provider` 与 `model` 缺一即「未配置」：多模态主模型仍能直接看到新消息里的图片，但 `read_image` 不可用、Sticker 后台索引暂停；补齐后热应用即恢复。 |
| `web_search` | 可选节：内置网络搜索。总开关、多个搜索引擎（服务商、地址、密钥、条数、超时、备注）与 URL 正则过滤；整段省略即不启用，所有字段热更新。模型只用它发现来源，正文由 `web_fetch` 读取。 |
| `admin` | 必填的本地管理面板；`enabled` 可省略，默认 `true`，修改后重启。显式关闭面板且 Telegram 停用时服务拒绝启动。 |
| `developer` | 可选调试设置；`record_model_payloads` 与 `record_agent_thinking` 均可省略，默认 `false`，可热应用。详见[Developer 页面](../configure/admin-developer.md#developer-调试开关)。 |
| `mcp` | 受限 stdio 或 Streamable HTTP Tool；修改后重启。 |
| `retention` | 在线保留天数与备份份数，仅下次备份使用。 |

## Telegram 可选与面板必填

不写 `telegram` 段，写了段但不写 `token`，或 `token` 引用的值为空（例如环境变量设成了空串），都是合法的 Telegram 停用状态：服务启动后没有 Telegram 连接，也不会处理任何 Telegram Chat；此时仍可通过[管理面板](../configure/admin.md)和 [Playground 虚拟群聊](../guides/playground.md)使用 Agent。Token 的 SecretRef 无法解析（环境变量未设置、key jar 无此项、命令失败）是配置错误，不是「停用」。

`admin` 段现在必填。`enabled` 可以省略，默认 `true`；显式关闭面板且 Telegram 停用时进程拒绝启动，因为此时没有任何可用入口。Telegram 处于网络异常或配置异常时不触发这条。

## 覆盖与隔离

全局 `agent.provider`、`model`、`thinking_level` 是默认值，三项缺一即「未配置」：Bot 照常启动但不发起任何 Invocation，补齐后恢复；Chat 同时指定 `provider` 和 `model` 时覆盖全局，`thinking_level` 可独立覆盖；Topic 使用所属 Chat 的模型设置。Chat 的 `participation.active_windows` 覆盖全局时段，关键词则追加到全局关键词；`proactive_reply` 则在全局与 Chat 两级按字段继承，默认关闭，见[控制主动插话频率](../guides/proactive-replies.md)。

Conversation、短期记忆和注意力窗口按 Chat + Topic 隔离；预算硬限制不是每群配额：主 Agent 日 Token 限制全局共享，Vision 有另一组全局限制。

`telegram.chats[].ignored_user_ids` 是当前 Chat 的忽略名单，包含唯一的正安全整数 User ID，支持热应用。成员可用 [`/ignoreme`、`/unignoreme`](../configure/telegram.md#自助忽略与恢复) 自行加入或取消，覆盖该 Chat 的全部 Topic；已有消息和 Context 不会追溯删除。

## SecretRef 与安全

敏感字段只能用 `{ "env": "NAME" }`、`{ "jar": "name" }` 或固定 argv 的 `{ "command": [...] }`。HTTP MCP 禁止重定向和 URL 凭据；stdio MCP 仅运行配置里的固定 argv。Prompt 不会获得额外权限。

## 生效规则

配置只在显式启动或应用时读取。Provider、模型、Prompt、`ignored_user_ids`、`participation`、`proactive_reply`、新增 Chat 与全部 Agent 字段可热应用；删除 allowlist Chat、MCP、Admin、路径和大多数结构变化要重启。详细操作见 [配置文件与密钥](../configure/config-file.md)，逐字段请下载 Schema。
