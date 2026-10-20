# 2026-10-20 群聊主动回复概率调度

## 背景

塑料碗在活跃群里会对每个可触发批次开 Invocation，模型因此有更多机会主动插话。需要把「普通群聊消息」的参与改成带硬保底的概率调度，同时保留 @、Reply Bot、触发关键词与 Bot Command 的直接唤起语义。

## 变更

- `telegram.proactive_reply` 与 `telegram.chats[].proactive_reply` 新增四个可选字段：`enabled`、`base_probability`、`increment`、`hard_pity`，默认 `false / 0.2 / 0.1 / 8`，按字段合并；正数 Chat ID（私聊）配置会被 `check-config` 拒绝。
- `src/platform/proactive-reply.ts` 提供配置解析、概率公式与可注入随机数的抽样函数；`src/orchestration/proactive-reply.ts` 的 `ProactiveReplyGate` 在 Bucket 到期、创建或 attach Invocation 之前做一次决策。
- 决策顺序：先过现有 allowlist/暂停/agent/睡眠/participation 闸门；扫描该 Bucket 冻结消息，任一直接唤起（mention、reply_to_bot、trigger_keyword）则整批绕过且不读写计数；否则按 Chat 读取 `proactive_reply_state` 抽样。
- 未命中把 Bucket 记为 `skipped_budget` / `proactive_reply_skipped`，消息与 `bucket_messages` 保留，后续作为历史进入 Context；命中重置计数并正常创建/attach。
- 计数按 Chat 存在迁移 036 的 `proactive_reply_state`。指纹只含三个数值参数，变化后下一次抽样清零；仅开关 `enabled` 或重启保留。抽样与 Bucket 状态转换在同一 SQLite 事务内完成。
- 启动追赶同样经过该闸门；Bot Command 与任务回执不进入概率链路。
- Admin Chats 页新增「主动回复」列与星形编辑按钮，支持跟随全局、关闭与自定义；新增 `PUT /api/chats/:id/proactive-reply`，热应用。
- 日志新增 `agent_proactive_reply_bypassed` 与 `agent_proactive_reply_sampled`；不写长期审计表。
- 文档：`agent-doc/configuration.md`、`telegram-agent-flow.md`、`data-layer.md`、`admin-panel.md`、`verification.md`，以及用户手册新增「控制主动插话频率」并更新参考页。

## 验证

- `pnpm run check`
- `pnpm test test/proactive-reply.test.ts test/startup-catch-up.test.ts test/admin-chats.test.ts test/config-diff.test.ts test/scheduler.test.ts test/participation.test.ts test/admin-inspection.test.ts`
- `pnpm test`（全量）
- `pnpm run admin:build && pnpm run admin:test:e2e 09-chats`

测试覆盖默认关闭、概率递增与硬保底、命中/未命中计数、聚合批次一次抽样、批次内直接唤起、@/Reply/关键词/Bot Command、直接唤起不改变计数、按群隔离、重启恢复、参数变化清零、开关保留计数、attach 前抽样，以及私聊/暂停/participation 边界。
