---
title: 使用文档
description: 按你要完成的任务选入口：第一次部署、接模型和人设、接上 Telegram，或者查配置和接口。
---

# 使用文档

文档分三块，按问题选：

| 分类 | 什么时候看 | 入口 |
| --- | --- | --- |
| **用户手册** | 想完成一件事：部署、写人设、接 Telegram、调优、修问题 | [用户手册](guides/index.md) |
| **配置参考** | 想手改 `config.jsonc`，或查某个字段的含义、默认值和生效方式 | [配置文件入门](configuration/index.md) |
| **开发者参考** | 写脚本或工具，调用 HTTP 接口、MCP Server 或两套 CLI | [开发者参考](developer/index.md) |

## 常见任务

**刚拿到一台机器**

1. [安装与首次登录](guides/installation.md)：Docker 起来、配 HTTPS 反代、一次性码登录、接一个能用的模型（想直接交给 Coding Agent 通过 SSH 一条龙部署，看[AI 帮我部署](guides/ai-deploy.md)）。
2. [你的第一个人设](guides/first-persona.md)：写人格，在虚拟群聊里试。
3. [你的第一只 Bot](guides/first-bot.md)：建 Telegram Bot，允许一个群，完成第一次真实对话。

**已经在运行**

- 让本地 Agent 装好 CLI 和 Skill 帮你调优：[与 Agent 配合使用](guides/agent-assisted.md)

- 换模型或调整思考强度：[接入和更换模型](guides/models.md)
- 太吵、太慢、太贵：[按表现和费用调优](guides/tuning.md)
- 给不同群不同规则：[为不同群和话题设置边界](guides/chats.md)
- 不接 Telegram 先试功能：[用虚拟群聊试验人设和工具](guides/playground.md)
- 忘记密码、远程访问、管理密钥：[管理面板、密钥与访问安全](guides/admin.md)
- 升级、备份与恢复：[升级、备份与恢复](guides/maintenance.md)

**出了问题**

- 起不来、面板打不开、Bot 不回复：[排查启动失败和不回复](guides/troubleshooting.md)

## 关于本站

本站只包含公开文档与安全示例。示例里的 Token、API Key 与 Chat ID 都是占位值。运行中的 Bot、聊天记录、审计数据与管理接口不在其中。页面顶部标明这些文档对应的源码提交，请先与你部署的版本核对。
