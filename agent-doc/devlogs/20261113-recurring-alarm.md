# Surowan - 20261113 循环闹钟：管理员定时注入可信提示词

## 背景

主动任务被认为是这类 Bot 的标配，例如每天早上八点问候，或每天下午六点出资讯简报。此前 Surowan 只有 Alarm 插件：群友让 Bot 记下的一次性提醒，由模型在对话中创建，到期后作为不可信回执注入。

PRD `doc/design/20261113-recurring-alarm.md` 确认的范围：

- 只有管理员能在 Admin Panel 新建，没有审批流程；管理员写的提示词是可信的。
- 执行周期可以写 cron，也可以用控件添加多条规则（分、时、日、月、星期，每个字段选「每」或「第」）。
- 到点触发与单次闹钟一样：不占每日预算，不受睡眠时段影响。
- Admin Panel 提供「立即执行一次」按钮。

实施计划在 `agent-doc/design/20261113 循环闹钟实施计划.md`。用户在对话中另外要求：cron 这一块放在 local-monolith 层，为以后上 Cloudflare 预留能力。

## 主要变更

### 1. cron 契约与引擎分层

`src/platform/recurring-schedule.ts` 定义方言、上限与引擎契约，不做 IO：

```ts
export interface RecurringScheduleEngine {
  /** Engine-level problems, such as a rule that never fires again after `now`. */
  validate(rules: readonly string[], timeZone: string, now: Date): RuleIssue[];
  /** The earliest occurrence of any rule strictly after `after`, at minute precision; null when none exists. */
  nextAfter(rules: readonly string[], timeZone: string, after: Date): Date | null;
}
```

方言由 `checkRuleDialect`（`src/platform/recurring-schedule.ts:125`）逐字段白名单固定：只放行数字、`*`、`,`、`-`、`*/N` 与 `a-b/N`，以及月份、星期的英文缩写；`L`、`W`、`#`、`?`、星期 `7`、秒段与年段一律拒绝。这样换一个引擎（例如 Cloudflare 侧）算出的时间不变。

`src/adapters/local-monolith/recurring-schedule.ts` 用 `croner@10.0.1` 实现契约，固定 `{ mode: '5-part', timezone, domAndDow: false, paused: true }`，只算时间，不让 croner 自己调度。它是全仓唯一引用 `croner` 的文件，由测试扫描源码断言。

### 2. 存储与到点物化（迁移 056）

`056_recurring_alarms.sql` 新建 `recurring_alarms`（定义，随 Conversation 级联删除）与 `recurring_alarm_firings`（每次处理或立即执行一行，部分唯一索引保证同一计划时间只落一行）。唤醒只依赖持久化的 `next_fire_at`。

`RecurringAlarmService`（`src/store/recurring-alarms/`）注册为 `LongTaskService` 的 timer source，没有改 Scheduler 的构造：

```ts
  processDue(now: Date): void {
    for (const source of this.#sources) {
      source.materializeDue(now);
    }
```

`fireScheduledOccurrence`（`src/store/recurring-alarms/occurrences.ts:151`）在一个 IMMEDIATE 事务里写触发记录、创建一个已经到期的 `recurring-alarm` timer 任务（`delivery.bypassDailyBudget = true`），再把 `next_fire_at` 推进到 `now` 之后。任务写入嵌套成 savepoint，任何一步失败都整笔回滚；失败的定义把 `next_fire_at` 置空并记 `recurring_alarm_failed`，避免 Scheduler 空转。同一轮 Scheduler 随即完成任务、领取回执，之后与 Alarm 回执同一条管线。

跳过规则：离线错过的多次合并成一次（`coalesced`），最早那次晚了 30 分钟以上记 `missed`；目标暂停、移除、Topic 不在白名单或 Agent 未配置完整时按回执同一判定跳过；上一次（定时或手动）还没投递完时记 `previous_pending`。目标判定从 `receiptCancelReason` 抽到 `src/store/delivery-target.ts:48`，两边共用。物化、唤醒与立即执行只算当前就绪的宿主，Telegram 停用或断线时不会先物化出一条回执、几小时后才投递。retention 清理触发记录时保留仍未投递的那一行。

### 3. 可信注入

`src/context/builder/admin-task.ts:22` 在 `plugin_id` 为 `recurring-alarm` 且 payload 通过 TypeBox 校验时，把 `<runtime_state>` 的完成说明换成管理员定时任务的说明，并输出 `<admin_scheduled_task>`：

```ts
  return JSON.stringify({
    scheduled_for: renderCurrentTime(payload.time_zone, new Date(payload.occurrence_at)),
    missed_occurrences: payload.coalesced,
    prompt: payload.prompt,
  })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
```

校验失败时退回原本的 `<untrusted_task_receipt>`。立即执行与到点触发渲染完全一样，模型看不出是手动的。信任关系由 `<runtime_state>` 那句话声明，核心协议的 system prompt 没有改，以免升级时重建所有 Context。`loadPlugins` 拒绝 `recurring-alarm` 这个插件 id（`src/plugins/plugin.ts:234`），否则插件能借这个 id 让自己的任务数据被当成管理员指令。`renderCurrentTime` 从 `render.ts` 移到 `format.ts`。

### 4. Admin API、CLI 与 MCP

`src/ingress/admin/routes/recurring-alarms.ts` 提供列表、可选目标（附全局默认时区）、详情（最近 50 条触发记录）、周期预览、增改删与 `POST /recurring-alarms/:id/run`。新建、编辑与立即执行要求 API key 同时有写权限与付费操作权限，并在 admin-surface 中带 `confirm: 'paid'`；删除只要写权限。编辑按循环闹钟自己的 `revision` 乐观锁，不检查目标是否可投递，暂停的 Chat 也能改或停用。白名单 Topic 还没有 Conversation 时在新建的同一事务里补建。`packages/admin-surface` 登记 `recurring-alarm` 系列命令，CLI 增加 `--enabled` 过滤，`skills/surowan-mcp` 同步工具索引。

### 5. 面板页面

`/recurring-alarms`（Agent data 分组）列出标题、目标、规则、按闹钟时区显示的下次触发、启用开关与最近一次结果，行内可查看详情、编辑、立即执行、删除。新建/编辑对话框在「规则」与「Cron」之间切换，两者编辑同一份 cron 列表（`apps/admin-next/src/lib/cron-builder.ts`）；预览在规则或时区停止改动 300ms 后由事件处理器触发刷新，没有用 `useEffect`。规则控件改用 `fieldset`，因为 Koi `Field` 会把同名标签加到它里面每一个控件上。e2e 后端（`apps/admin-next/e2e/server-boot.ts`）接入了服务。

### 6. 文档

`agent-doc/telegram-agent-flow.md`、`data-layer.md`、`admin-panel.md`、`architecture.md`、`verification.md` 与 `AGENTS.md` 描述了新行为；用户指南新增 `apps/docs/content/docs/guides/recurring-alarms.md`。实施计划末尾的「落地时的调整」记录了与计划的出入。

## 验证

```bash
pnpm run check
# 通过（tsc、cli、admin-next、docs）

pnpm run lint
# Checked 1324 files in 162ms. No fixes applied.

pnpm test test/recurring-alarms
# 4 files / 52 tests passed：方言与 DST、物化幂等、错过合并、跳过原因、停用/删除抑制、宿主就绪、
# 失败回滚、retention、真实 Scheduler + AgentRuntime 下的可信注入、Admin API 权限

pnpm test
# 第一轮：2 个失败用例是 test/foundation/foundation.test.ts 写死「最新迁移 = 55」，已更新
# 最终：383 files / 1883 tests passed

pnpm run admin:build && pnpm run admin:test:e2e
# 第一轮：24-i18n 的导航数量断言（26 → 27）与新增菜单项未更新，已修
# 最终：296 passed；32-recurring-alarms 产出 recurring-alarm-run-now.png

DOCS_BASE_PATH=/ pnpm run docs:build && pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && pnpm run docs:verify
# 均通过：Verified 51 HTML/Markdown pages ... 167 HTTP resources；构建后 git status 不变
```

未执行：

- 真实 Telegram 验收：建一个循环闹钟，观察到点在群里发言，以及睡眠中、预算耗尽时照常触发。
- 产品知识索引没有重烘焙：改动 `src/platform/prompts/2-product-knowledge.md` 也会改变 system prompt 哈希、重建所有 Context。新指南可经 `list_documents` 找到。

## 提交

```txt
1b0c7495 Add a portable recurring schedule contract with a croner engine
374f3b49 Store recurring alarms and materialize their occurrences as timer tasks
35d9e2b6 Deliver recurring alarm occurrences as trusted admin tasks
c6beb2b6 Expose recurring alarms through the Admin API, CLI and MCP surface
8c8ea44e Add the recurring alarms page to the Admin Panel
0a08a5c1 Document recurring alarms for agents and users
d7eb68ff Hold recurring alarms while their host is not ready
bb5a838d Count the recurring alarms page in the navigation e2e
```
