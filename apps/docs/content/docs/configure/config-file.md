---
title: 配置文件与密钥
description: 编辑严格 JSONC 配置，安全引用密钥并确认变更何时生效。
---

# 配置文件与密钥

Surowan 读取严格 JSONC：未知字段、无效模型引用和不合法的跨字段组合都会被拒绝。下载 [完整样例](__DOCS_BASE__/examples/config.example.jsonc) 和 [Prompt 样例](__DOCS_BASE__/examples/system-prompt.example.md)，不要把局部片段当作独立配置。

## 文件布局

Docker 部署中将这些文件放入同一个宿主机 `config/` 目录：

```text
config/
├── config.jsonc
└── system-prompt.md
```

`system_prompt_file` 和每群 `instructions_file` 相对**配置文件目录**解析；`data_dir` 与 `paths.*` 则按服务工作目录解析，容器请使用 `/data/...`。

## 引用密钥

配置不接受明文 Token 或 API key。使用环境变量、同目录 key jar，或固定 argv 命令引用：

```jsonc
{
  "telegram": { "token": { "env": "TELEGRAM_BOT_TOKEN" } },
  "providers": {
    "gateway": { "api_key": { "env": "SUROWAN_API_KEY" } }
  }
}
```

`{ "jar": "name" }` 只引用同目录 `key.json` 中的条目，不能将该文件提交、上传到文档站或交给 Agent 阅读。生产环境优先让 Compose、supervisor 或密钥管理器注入环境变量。

## 网络搜索（web_search）

```jsonc
{
  "web_search": {
    "engines": [
      { "id": "main", "provider": "tavily", "api_key": { "jar": "tavily" }, "note": "中文技术博客" }
    ],
    "url_filters": ["csdn"]
  }
}
```

整段可省略（不启用）；`enabled` 缺省为开启，关闭只需 `{ "enabled": false }`。每个引擎必须指定已注册的服务商，SearXNG 必须提供 `endpoint` 且不接受密钥；`results` 为 1–10（缺省 5），`timeout_seconds` 为 5–30（缺省 15）。`url_filters` 每行一个正则表达式，命中的结果会被丢弃。该段热更新：引擎、密钥与过滤规则的修改在下一次搜索调用生效，关闭功能或禁用所有引擎会让运行中的 Invocation 立即停止。完整说明见 [网络搜索](../guides/web-search.md)。

## 检查、应用与重启

每次编辑后先检查：

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
```

没有文件监视器。Prompt、Provider、全局/既有 Chat 的模型覆盖、`ignored_user_ids`、新增 Chat、`agent` 段的全部字段可以通过 Admin 的 **Apply config file**、Chats 页、Harness tuning 页或 `/model` 热应用；删除 Chat、Topic 范围、MCP、Admin、数据路径和多数其他字段必须重启。成员的 `/ignoreme`、`/unignoreme` 会保存自己的忽略设置并立即应用配置文件。`retention` 与备份路径只在下一次 `backup` 使用。

成功热应用看 `config_reloaded` 的 `active_hash` 与 `file_hash`；重启后看 `serve_started.config_hash` 与 `check-config` 输出是否相同。详细字段见 [配置参考](../reference/config.md)。

## 风险

Prompt 变化会让相关 Conversation 的 Context 在下一次运行时重建。先备份并评估对话影响，不要用配置热应用代替数据库迁移或恢复验证。
