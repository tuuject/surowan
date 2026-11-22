---
title: 网络搜索配置
description: web_search 的启用条件、内置服务商与默认地址、密钥与 endpoint、RE2 形式的 URL 过滤，以及热更新时的中断规则。
---

# 网络搜索配置

`web_search` 段让模型先用搜索引擎发现来源（标题、URL、短摘要），再按需用 `web_fetch` 读正文。搜索本身不抓取页面正文，所以一次搜索占的上下文很小。

默认不启用。启用后 `web_search` 能力与它对应的 Skill 会一起出现在模型的索引里；关掉时两者一起消失，模型连「可以搜索」的提示都看不到。

## 什么时候可用

三者同时成立时搜索才可用：

1. `web_search` 段存在；
2. `enabled` 不是 `false`（省略即开启）；
3. 至少有一个 `enabled` 不是 `false` 的引擎。

整段省略、写 `"enabled": false`、或者所有引擎都被禁用，效果完全一样：能力与 Skill 都不可见，模型调用会被直接拒绝（`search_disabled`）。

## 字段

| 字段 | 说明 |
| --- | --- |
| `enabled` | 可选，缺省为开启。写 `false` 是显式关闭。 |
| `engines` | 引擎列表，最多 32 项。 |
| `engines[].id` | 引擎标识，模型用它选引擎：小写字母开头，最多 32 位小写字母、数字或短横线。同一段内唯一。 |
| `engines[].provider` | 服务商标识，必须来自下表。未注册的服务商在加载时被拒绝。 |
| `engines[].enabled` | 可选，缺省为开启。 |
| `engines[].endpoint` | 服务地址。必须是不带凭据、查询参数与 `#` 片段的 HTTP(S) 地址；留空用服务商默认地址，没有默认地址的服务商必须填。 |
| `engines[].api_key` | SecretRef。是否必填取决于服务商，见下表。 |
| `engines[].results` | 每次搜索的默认条数，1–10，缺省 5。服务商自己决定分页时不允许写这个字段。 |
| `engines[].timeout_seconds` | 单次搜索超时，5–30 秒，缺省 15。实际超时不会超过 Invocation 的剩余时间。 |
| `engines[].note` | 可选，最长 1000 字符。写给模型看的备注，说明这个引擎适合搜什么。 |
| `url_filters` | 结果 URL 的过滤正则，最多 50 条，每条最长 512 字符。命中的结果直接丢弃。 |

### 内置服务商

| `provider` | 默认地址 | 密钥 | 查询上限 | 接受结果条数 |
| --- | --- | --- | --- | --- |
| `tavily` | `https://api.tavily.com/search` | 必填 | 400 | 是 |
| `brave` | `https://api.search.brave.com/res/v1/web/search` | 必填 | 400 | 是 |
| `exa` | `https://api.exa.ai/search` | 必填 | 500 | 是 |
| `firecrawl` | `https://api.firecrawl.dev/v2/search` | 必填 | 500 | 是 |
| `deepseek` | `https://api.deepseek.com/v1/tools/search` | 必填 | 128 | 是 |
| `searxng` | 无 | 不接受 | 500 | 否（实例自己决定） |
| `youcom` | `https://ydc-index.io/v1/search` | 必填 | 500 | 是 |

「查询上限」是发给服务商前的静默裁剪长度：工具的查询字段本身最多接受 500 字符，超过服务商上限的部分直接被截掉而不是报错；审计里同时记录原始查询（`requested_query`）与实际发送的查询。

### URL 过滤

`url_filters` 里的每条都是一个 [RE2](https://github.com/google/re2) 语法的正则表达式：

- 在整条 URL 里**任意位置**匹配，不需要锚点：`csdn` 会丢弃所有 `blog.csdn.net` 的结果，`/wiki/` 只丢弃路径含 `/wiki/` 的结果。
- 只对服务商返回的结果 URL 生效，不改写请求。
- 列表是「命中即丢弃」的拒绝表，不是白名单。
- 编译失败的正则会让整份配置加载失败，不会静默忽略。RE2 不支持前后行断言（`(?=…)`、`(?<=…)`）和反向引用，写这类语法同样会失败。

代价是线性的：正则同步运行在服务商返回的 URL 上，换成回溯引擎一个 `(a+)+$` 就能卡死整个进程，所以这里固定用 RE2。

## 生效方式

`web_search` 段是热更新，改完下一次应用生效，不需要重启：

- 每次搜索在开始时冻结自己的引擎、地址、密钥、条数与超时；在途请求用旧设置跑完，下一次搜索用新设置。
- 只禁用部分引擎不会打断运行中的 Invocation。它要是正好请求刚被禁用的引擎，会收到一条提醒，要求重新读取当前引擎列表。
- 从可用变成不可用（关掉开关、或禁用最后一个启用引擎）会**中止所有正在运行的 Invocation**（原因记为 `web_search_disabled`），下一条消息在重建的上下文里开始。原因很直接：Skill 索引变了，旧上下文不能再假装搜索能力还在。
- 从不可用恢复成可用同样会改变索引，所有对话在下一次 Invocation 重建上下文。

## 示例

```jsonc
{
  "web_search": {
    "engines": [
      {
        "id": "main",
        "provider": "tavily",
        "api_key": { "jar": "tavily" },
        "results": 5,
        "note": "中文技术博客与更新日志"
      },
      {
        "id": "local",
        "provider": "searxng",
        "endpoint": "https://searx.example.com",
        "note": "私有实例，查文档站比较稳"
      }
    ],
    "url_filters": ["csdn", "/wiki/"]
  }
}
```

面板里的对应页面是「网络搜索」，包含引擎编辑、密钥来源选择（保留、新密钥或选用 keychain 条目）和不发请求的 URL 过滤预览。

## 与其他段的关系

- `web_fetch` 负责读正文，它的三个开关在[网页读取配置](web-fetch.md)。
- 搜索失败不会自动重试；认证失败、额度耗尽、限流、超时、响应过大与重定向分别报告。
- 返回结果是不可信数据，不能当指令或授权，这一点与配置无关，始终成立。

字段类型与取值范围见[网络搜索字段参考](fields-web-search.md)。
