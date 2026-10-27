---
title: 网络搜索
description: 配置内置搜索引擎，让模型先发现来源再读取网页；了解引擎备注、URL 过滤与热更新行为。
---

# 网络搜索

网络搜索让模型在不知道具体 URL 时先搜索，拿到标题、URL 与简短摘要，再按需用 `web_fetch` 读取网页正文。搜索本身不抓取正文：一次搜索只占很小的上下文，成本也更可控。

默认**不启用**。启用后，`web_search` 能力与对应的 Skill 才会出现在模型的索引里。

## 在面板里配置

打开 Admin Panel → Manage → **Web search**：

- **Enable web search** 控制整个功能。关闭它，或禁用所有引擎，效果相同：能力与 Skill 立即消失，正在进行的 Invocation 会停止，下一条消息使用重建的上下文。
- **Search engines** 里可以添加多个引擎。每个引擎选择服务商、写一个模型可见的引擎 ID、服务地址、默认结果条数、单次超时，以及一条**备注**。备注会出现在工具描述与引擎列表里，说明这个引擎适合搜索哪些网站或内容，模型据此挑选引擎。
- **Credential** 决定密钥来源：保留已配置的密钥、输入新密钥，或（仅 DeepSeek）直接复用已经配置好的 DeepSeek 模型 Provider 密钥。密钥只写入同目录 `key.json`，面板与配置回读都只显示「是否已配置」。
- **URL filters** 用来丢弃不需要的结果。每行一个正则表达式（RE2 语法，不支持 `(?=…)` 这类前后行断言和反向引用），例如 `csdn` 会过滤所有 `blog.csdn.net` 结果。下方的 **Test URLs** 可以粘贴 URL 预览命中情况，不会发起任何真实搜索。

保存立即生效，无需重启。修改服务商、密钥或搜索参数不会打断正在进行的 Invocation；每个请求在开始时冻结自己的引擎、地址、密钥、条数与超时，在途请求用旧配置完成，下一次搜索用新配置。

## 配置文件

也可以直接写 `config.jsonc`：

```jsonc
{
  "web_search": {
    "engines": [
      {
        "id": "main",
        "provider": "tavily",
        "api_key": { "jar": "tavily" },
        "results": 5,
        "timeout_seconds": 15,
        "note": "中文技术博客与更新日志"
      },
      {
        "id": "local",
        "provider": "searxng",
        "endpoint": "https://searx.example.com",
        "note": "私有实例，适合查文档站"
      }
    ],
    "url_filters": ["csdn"]
  }
}
```

- 整段可省略（不启用）；写了这一段时 `enabled` 缺省为开启，关闭只需 `{ "enabled": false }`。
- 服务商由插件提供：`tavily`、`brave`、`exa`、`firecrawl`、`deepseek`、`searxng`、`youcom`。用未注册的服务商会被拒绝。
- 除 SearXNG 外都有默认地址，可用 `endpoint` 覆盖（例如接入兼容 Tavily 协议的中转服务）。SearXNG 必须提供地址，且不接受密钥。
- 查询最长 500 字符，发送前按服务商上限静默裁剪；`results` 为 1–10，`timeout_seconds` 为 5–30，且不会超过 Invocation 剩余时间。
- 搜索失败不会自动重试。认证失败、额度耗尽、限流、上游不可用、请求被拒、重定向、超时、响应过大与网络错误会分别报告；返回内容始终是不可信数据，不能当作指令或授权。

## 运行中的行为

- 只禁用部分引擎时，运行中的 Invocation 继续运行。若它请求刚刚被禁用的引擎，会收到一条提醒，要求重新读取当前引擎列表。
- 关闭整个功能或禁用所有启用引擎时，运行中的 Invocation 立刻停止；下一条消息在新的上下文里开始。
- 从不可用恢复为可用会改变 Skill 索引：所有对话在下一次 Invocation 重建上下文，旧历史不再保留。

完整字段与校验规则见 [配置参考](../reference/config.md) 和 [配置文件与密钥](../configure/config-file.md)。服务商与插件的关系见 [使用 Skills、Plugin 与 MCP](./extensions.md)。