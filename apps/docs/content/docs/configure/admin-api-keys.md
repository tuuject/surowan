---
title: API 密钥
description: 创建、修改权限、轮换与撤销 CLI、MCP Server 与评估工具使用的 API key。
---

# API 密钥


在面板的 **Manage → API keys**（`/api-keys`）页面创建、修改权限、轮换与撤销密钥；操作需要管理员登录 Session，API 密钥本身不能管理密钥。密钥用于 `surowan-utils`、MCP Server 与评估工具，MCP 配置见 [MCP Server](mcp-server.md)，CLI 安装与用法见 [CLI 参考](../reference/cli-surowan-utils.md)。

## 权限模式

新建时用下拉框四选一；已创建的密钥只能修改模式或 rotate，不能改名。`read_all` 始终开启。

| 模式 | 能做什么 |
| --- | --- |
| **只读** | 全部审计读取、脱敏配置与 Prompt 视图、模型列表、Invocation 查询/媒体导出/重放预检。不改变状态，也不产生外部费用 |
| **读 + 改** | 只读能力 + 改配置、Chat、Prompt、Memo Pad、辞典、群聊记忆、告警、Playground 输入等写操作。不执行计费操作 |
| **读 + 耗** | 只读能力 + Invocation 重放、Provider 健康检查、生图、辞典合并预览、Playground Release/Retry 等计费操作。不修改配置或状态 |
| **全部** | 以上全部。生图与 Playground Release/Retry 等同时改变状态又消耗资源的操作需要这一档 |

账号与凭据整类排除：无论密钥拥有什么模式，都不能修改管理员密码、管理 Passkey、新增/删除管理员账号，也不能颁发、吊销、修改或查看 API key。这些操作只留给浏览器面板与服务端 `surowan` 命令行。

## 页面操作

- 列表显示 **Name**、**Prefix**、**Mode**、**Created**、**Last used**、**Status**（**Active** / **Revoked**）与 **Actions**，任何时刻都不回显明文；从未使用过的密钥在 **Last used** 显示 **Never used**。
- 点 **Create API key** 填写 **Name**（1–80 字符）并选择模式，再点 **Create key**。成功后 **Save your API key** 弹窗显示一次完整明文，可点 **Copy API key** 复制；点 **Done** 或关闭弹窗、切换页面、刷新后都无法再查看。
- **Change mode** 只改权限，密钥值不变；**Rotate** 为同一密钥签发新值，旧值立即失效，名称与模式保留。
- 点行内 **Revoke** 后需在确认框点 **Revoke key**；撤销立即生效且不可恢复，密钥行与元数据保留，**Status** 变为 **Revoked**。
- 页面不把明文写入浏览器 `localStorage`/`sessionStorage` 或查询缓存，列表接口也不返回它。复制失败时弹窗保留文字并提示手动复制。
- 如果数据库里的权限组合被直接改坏（例如只能写不能读），该密钥无法通过鉴权；列表把这一行显示为 **Invalid permissions**，保存一个合法模式即可修复。服务启动时控制台与 Warnings 页也会给出常态警告。

## 请求语义

- 请求带 `Authorization: Bearer pwk_<your-key>` 时服务器不再读取浏览器 Cookie；有效 Session 也不能把密钥权限升级成完整面板权限。
- 无效、已撤销或权限非法的密钥统一返回 401 `unauthenticated`；有效但权限不足返回 403 `forbidden`，消息会说明缺少哪项权限。
- 列表里的 `last_used_at` 在每次密钥通过校验时更新，包括随后因权限不足被 403 的请求；401 不更新。
- `GET /api/key` 返回当前密钥的身份与权限；MCP 的 `surowan_key_show` 是同一能力的工具。
- 未知路径对密钥返回 403 而不是 404，避免枚举面板。
