---
title: 匿名统计
description: 可选的匿名使用统计：默认关闭，发送什么、不发送什么，以及如何开启或关闭。
---

# 匿名统计

Plastic Wan 可以向 PostHog 发送粗粒度的匿名统计，帮助维护者了解版本与部署的大致规模。**默认关闭**：没有明确同意就不会发送任何数据，也不会生成标识符。

## 开启或关闭

在 `config.jsonc` 中显式表态，或运行 `node src/cli.ts configure` 并选择「Configure anonymous telemetry」：

```jsonc
{
  "telemetry": { "consent": "granted" }
}
```

- `"granted"`：同意发送；`"denied"`：明确拒绝；省略该段等同于未决定，不发送。
- 设置环境变量 `DO_NOT_TRACK=1` 或 `PLASTICWAN_TELEMETRY=0`，无论配置如何都会强制关闭。
- 修改后需要重启。

## 发送什么

`serve` 启动后发送一次 `instance_started`，之后每 24 小时发送一次 `instance_heartbeat`。事件只包含：

| 属性 | 含义 |
| --- | --- |
| `version`、`node_major`、`platform`、`arch` | 版本、Node.js 主版本、操作系统与 CPU 架构 |
| `docker` | 是否运行在 Docker 中 |
| `chats`、`mcp_servers`、`invocations_24h` | 数量只以区间表示：`0`、`1`、`2-5`、`6-20`、`21-100`、`101-1000`、`1000+` |
| `has_group_chats`、`admin_enabled`、`image_enabled` | 是否使用群聊、管理面板与图片生成 |

## 不发送什么

Telegram 用户、群组与 Topic ID，用户名，消息与媒体内容，Prompt，模型或 Provider 名称，URL、主机名、路径，以及任何 Secret，都不会发送。

唯一的标识是随机生成的安装 ID，保存在本地数据库中；它不由 Bot Token、Chat 或主机信息派生。未同意（包括撤回同意）时，它会在下次启动时被删除。事件按匿名事件发送（不创建用户档案，不做 IP 地理定位）。每次发送的完整内容都会以 `telemetry_sent` 日志输出，可以随时核对；网络失败只记录 `telemetry_send_failed`，不影响 Bot 运行。
