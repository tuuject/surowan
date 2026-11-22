---
title: 模型元数据目录
description: models_dev.api_url 的作用、合法性约束、兼容的 JSON 格式与镜像、默认地址与热生效方式。
---

# 模型元数据目录

`models_dev` 只有一个用途：在面板里添加模型时，从这里查询上下文长度、最长输出、输入类型、思考档位与价格。它不影响运行中的模型——已经保存进 `providers[].models` 的元数据才是运行时唯一依据。

字段见 [`models_dev` 段字段参考](fields-models-dev.md)。

## 默认与写法

整段可省略。省略 `api_url`（或整段省略）时使用默认地址 `https://models.dev/api.json`。

```jsonc
{
  "models_dev": { "api_url": "https://models.example.com/api.json" }
}
```

`api_url` 也可以在面板「开发者」页的「模型参数来源」里填「目录地址」，那一栏旁边有「恢复默认」。

## 合法性约束

`check-config` 会拒绝这些写法：

- 不是绝对 URL，或协议不是 HTTP(S)。
- 带用户名/密码，或带 `#` 片段。
- 超过 2048 字符。

查询串是允许的：CDN 或网关常用 `?token=` 之类的静态查询参数。重定向不允许——目录必须直接返回内容，遇到 3xx 即失败。

## 必须兼容的格式

镜像必须返回与 models.dev 相同的结构：一个以供应商 id 为键的对象，每个供应商有 `id`、`name` 和以模型 id 为键的 `models`；模型里有 `id`、`name`，以及可选的 `reasoning`、`reasoning_options`、`modalities`、`limit`（`context`/`input`/`output`）、`cost` 等字段。

运行时的边界：

- 请求 30 秒超时，响应体上限 32 MiB，`accept: application/json`。
- 解析后要过一遍 Schema 校验；结构不符会得到「目录未通过校验」而不是某个字段缺失。
- 每个地址独立缓存 1 小时，并发查询共用同一次下载。改地址后新的查询立刻去新地址，切回旧地址还能命中它自己的缓存。

```jsonc
{
  "models_dev": { "api_url": "https://cdn.example.com/models.dev/api.json?tenant=internal" }
}
```

## 查不到时会怎样

查询失败不会让添加模型失败，只是少了一份元数据来源：

- 面板会提示目录来源错误（响应里的 `metadata_source_error`），Provider 自己的模型列表照常显示。
- 必须确认的项（上下文长度、最长输出、输入类型）仍要手工填写或确认，面板会标出「待确认」的项数。
- 价格查不到时写 0；能匹配到的价格可以直接用，之后也能在编辑弹窗里改。

## 生效方式

`models_dev` 与 `models_dev.api_url` 都是热字段：面板下一次查询模型元数据时使用当前发布的地址，不需要重启，也不需要重新保存 Provider。已经保存的模型条目不会因为换目录而被改写。

添加 Provider、拉取模型列表与健康检查的操作见[接入和更换模型](../guides/models.md)。
