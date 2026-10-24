---
title: CLI 参考
description: Surowan 的服务、配置校验、诊断、备份命令，以及用于保存凭据、检查连通、只读查看配置与 prompt、查询/导出/重放 Invocation 的 Admin API 工具客户端。
---

# CLI 参考

服务命令显式指定配置路径；下文的 Admin API 工具客户端改用 endpoint 与 API key。配置和密钥错误信息会尝试脱敏，但仍不要将完整日志公开。

## 服务与校验

```bash
node src/cli.ts check-config --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc
node src/cli.ts serve --config /path/to/config.jsonc --takeover
```

`check-config` 仅验证 JSONC、语义和引用，输出配置哈希，不连接外部服务。`serve` 启动服务；配置了 Telegram token 时同时连接 Telegram，没有 token 时 `serve_started` 的 `mode` 为 `disabled` 并继续提供管理面板与虚拟群聊。成功日志包含 `serve_started`。`--takeover` 仅用于替换持有同一数据目录锁的本地实例，会请求旧实例优雅退出，不能作为生产 supervisor 的替代。

## 真实诊断与备份

```bash
node src/cli.ts doctor --config /path/to/config.jsonc
node src/cli.ts backup --config /path/to/config.jsonc
```

`doctor` 会探测 SQLite、媒体依赖、Provider、Vision 与 required MCP，并在配置了 Telegram token 时执行 `getMe`；没有 token 时跳过 Telegram 探针，成功 JSON 的 `telegram_status` 为 `disabled`、`telegram_bot_id` 为 `null`。它会消耗 Provider Token，不要把它当离线检查。`backup` 执行保留清理、SQLite 备份与轮换；之后仍应在隔离环境验证恢复。

## 交互式配置

```bash
node src/cli.ts configure --config /path/to/config.jsonc
```

`configure` 只能在 TTY 中编辑已有、可加载的配置；它不是无人值守初始化器，也不适合让部署 Agent 自动调用。

## Docker 等价命令

```bash
docker compose run --rm plasticwan check-config --config /config/config.jsonc
docker compose run --rm plasticwan doctor --config /config/config.jsonc
docker compose run --rm plasticwan backup --config /config/config.jsonc
```

这些一次性命令不启动 `serve`，可与正在运行的服务共存；不要用 `docker compose run` 再启动一个 `serve`。

## Admin API 工具客户端（surowan-utils）

`surowan-utils` 的安装、凭据与首次使用见 [客户端安装与登录](cli-surowan-utils.md)；完整选项、请求/响应与失败行为见 [客户端参考](cli-surowan-utils-reference.md)；配套 Agent Skill 见 [外部 Agent 使用](cli-surowan-utils-skill.md)。
