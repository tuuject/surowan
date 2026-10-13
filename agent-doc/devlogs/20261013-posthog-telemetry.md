# Plastic Wan - 20261013 PostHog 匿名统计（opt-in）

## 背景

维护者希望了解部署的大致范围，同时必须保护用户隐私。此前仓库没有任何遥测，审计数据只写本地 SQLite。

## 主要变更

- `config.jsonc` 新增可选 `telemetry.consent`（`granted` / `denied`）。缺省即未决定，**不发送**；`DO_NOT_TRACK`、`PLASTICWAN_TELEMETRY=0` 强制关闭。
- `src/telemetry.ts`：`serve` 启动后发一次 `instance_started`，之后每 24 小时发 `instance_heartbeat`；直接 `fetch` PostHog `/capture/`（无新依赖），5 秒超时、不重试、失败不影响运行。
- 属性只有版本、平台、Docker 与区间桶（chat / MCP / 24h Invocation 数量）；不含任何 Telegram ID、内容、模型名或 Secret。事件带 `$process_person_profile: false` 与 `$geoip_disable: true`。
- 标识为随机 UUID（`app_state.telemetry_install_id`），未同意时每次启动都删除。
- `configure` 向导新增同意菜单；`telemetry` 字段不在热更新白名单，修改需重启。
- 每次发送的完整属性输出为 `telemetry_sent` 日志，便于审计。

## 待办

- `POSTHOG_PROJECT_KEY`（`src/telemetry.ts`）为空，维护者需填入 PostHog 项目的公开 key，并在项目设置中开启「Discard client IP data」；填入前即使用户同意也不会发送（`reason: no_project_key`）。

## 验证

`test/telemetry.test.ts` 覆盖：无同意不发送且无 ID、同意后载荷的属性白名单与不含 Chat ID / 数据目录、ID 稳定与撤回删除、环境变量优先、发送失败不抛出。
