---
title: API 密钥
description: 创建、查看与撤销 CLI 与评估工具使用的 API key。
---

# API 密钥


在面板的 **Manage → API keys**（`/api-keys`）页面创建、查看与撤销密钥；操作需要管理员登录 Session，API 密钥本身不能管理密钥。密钥用于 CLI 与评估工具，安装与用法见 [CLI 参考](../reference/cli.md)。

- 列表显示 **Name**、**Prefix**、**Created**、**Last used**、**Status**（**Active** / **Revoked**）与 **Actions**，任何时刻都不回显明文；从未使用过的密钥在 **Last used** 显示 **Never used**。
- 点 **Create API key** 只需填写 **Name**（1–80 字符），再点 **Create key**。成功后 **Save your API key** 弹窗显示一次完整明文，可点 **Copy API key** 复制；点 **Done** 或关闭弹窗、切换页面、刷新后都无法再查看，请立即存进密码管理器或部署环境变量。
- 页面不把明文写入浏览器 `localStorage`/`sessionStorage` 或查询缓存，列表接口也不返回它。复制失败时弹窗保留文字并提示手动复制。
- 点行内 **Revoke** 后需在确认框点 **Revoke key**；撤销立即生效且不可恢复，密钥行与元数据保留，**Status** 变为 **Revoked**，不再提供撤销操作。

密钥的能力范围是只读检查与 Invocation 读/重放：允许查看当前配置与 global/group prompt 的脱敏视图、比较磁盘配置、列出当前 active 配置中可接受文本输入的已配置模型（`GET /api/models`，不探测 Provider）、读取 Invocation 场景将使用的当前两层 prompt、运行免费的重放预检、下载该 Invocation 快照授权的媒体，以及读取 Invocation 列表/详情并发起重放；它不能读取其它审计（Overview、Messages、Contexts、记忆等）、不能修改配置，也不能管理密钥。请求带密钥时服务器不再使用浏览器 Cookie，因此用密钥访问其它接口不会因为面板已登录而放行。列表里的 `last_used_at` 在每次密钥通过校验时更新；撤销后立即失效。明文遗失只能撤销后重建。请把密钥当密码对待，不要粘贴进聊天、日志或提交到仓库。
