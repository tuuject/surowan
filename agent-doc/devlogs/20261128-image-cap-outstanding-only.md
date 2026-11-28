# Surowan - 20261128 生图上限只统计未完成的任务

## 背景

事故报告 `agent-doc/investigations/2026-11-28-image-cap-and-cross-day-recall.md` 的 A1。

`image_generate` 原来每个 Invocation 最多提交 3 次。上限按「本 Invocation 创建过的 `image` 任务总数」计，已经出完图的任务也算在内。线上 `agent.context.idle_grace_seconds` 是 60，运行期间到期的 Bucket 会并入同一个 Invocation，所以同一位用户一次次提的修改都落在同一个 Invocation 里，第 4、5 次被拒。报错文案是 `image generation quota of 3 per invocation reached`，模型把它理解成额度耗尽，告诉用户额度用完了、不知道什么时候恢复，之后也没有再试。

这条上限没有出现在已审核的 PRD 里，数值和计法是照搬闹钟的（`d05ec359`）。闹钟会等很多天，也可以取消后重建，按总数计才限得住。生图约 20 秒就结算，照搬过来含义就变了。常量上方的注释写的是「Outstanding generations」，和实现也对不上。

约束：

- bridge 在 core 创建 generation（付费调用随之入队）之前预检，任务创建事务内再复查一次，两处必须用同一口径。
- 闹钟保持按总数计，不随本项改变。
- 被拒时不能创建任何 generation 行或任务。

先列出可能的失败方式：

1. 逐张修改仍然在第 4 次被拒，即事故本身。
2. 预检和事务复查的口径不一致：预检放行后事务拒绝，留下一个已经入队、没有任务的付费 generation。
3. 同时在跑的第 4 个没有被拦住。
4. 被拒时仍然建了 generation 行或任务。
5. 闹钟被一起放宽，取消一个之后又能多建一个。
6. 早先 Invocation 里还在等待的任务挡住了后来的 Invocation。
7. 报错文案仍让模型以为额度用完，或者以为请求已经排队、不用自己重新提交。

## 主要变更

### 1. 任务服务的配额带上计数口径

`CreateTaskInput.maxPerInvocation` 换成 `invocationQuota: { max, counts }`（`src/store/long-tasks/quota.ts`）：`counts: 'created'` 计本 Invocation 创建过的全部任务，`counts: 'waiting'` 只计仍处于 `waiting` 的任务。计数由 `invocationAtQuota` 完成，`LongTaskService.atInvocationQuota`（`src/store/long-tasks/index.ts:105`）是它的公开入口，任务创建事务内（`:237`）调用的也是这个方法：

```ts
export function invocationAtQuota(orm: Orm, pluginId: string, invocationId: bigint, quota: InvocationQuota): boolean {
  assertInvocationQuota(quota);
  const filters = [eq(longTasks.pluginId, pluginId), eq(longTasks.createdByInvocationId, invocationId)];
  if (quota.counts === 'waiting') {
    filters.push(eq(longTasks.state, 'waiting'));
  }
  // ...
  return count >= BigInt(quota.max);
}
```

闹钟的调用方迁移为 `invocationQuota: { max: ALARM_MAX_PER_INVOCATION, counts: 'created' }`，行为不变。旧字段直接删掉，没有留别名。

### 2. 生图预检与事务复查走同一个函数

`src/image/bridge/shared.ts:12` 的 `MAX_PER_INVOCATION = 3` 换成 `IMAGE_INVOCATION_QUOTA = { max: 3, counts: 'waiting' }`。`submission.ts` 删掉自己拼的计数 SQL，预检改为 `tasks.atInvocationQuota('image', …, IMAGE_INVOCATION_QUOTA)`（`src/image/bridge/submission.ts:167`），任务创建时传同一个常量（`:211`）。`SubmissionDeps.store` 不再使用，随之删除。

同一 Invocation 的工具调用是串行的，预检和任务创建之间不会有新任务插进来；改成只计 `waiting` 后，这段时间里计数只会因为生成结算而减少，所以预检放行后事务不会再拒，失败方式 2 不会发生。

### 3. 报错文案与工具说明

`src/plugins/image/image.ts:305` 的报错改为说明这是同时进行的上限、不是额度耗尽；这次请求没有被提交也没有排队，要等回执到达后自己再调用一次 `image_generate`；可以告诉用户稍后补上，不能说额度用完或功能不可用。审计的 `error_code` 仍是 `image_generate_quota_exceeded`，存量审计行和按它过滤的查询不受影响。

「没有排队、要自己再提交」这一句来自 Open Code Review 的第一轮意见：初稿允许模型对用户说「已排队」，但被拒的请求实际上没有进入任何队列。

工具 description、`image-generation` Skill 的 Quota 一节、中英文用户指南 `guides/image-generation.md` 与 `agent-doc/telegram-agent-flow.md` 的生图与长期任务两节同步改为「同时最多 3 个未完成」。

### 4. 拆分 `long-tasks/index.ts`

加上配额类型后，`src/store/long-tasks/index.ts` 超出 pre-commit 的 5,000 token 上限 148 个 token。按职责拆成两个兄弟模块，代码原样搬移：

- `quota.ts`：`TaskQuotaError`、`InvocationQuota`、`assertInvocationQuota`、`invocationAtQuota`。
- `settle.ts`：原来 `#finish` / `#cancel` 的方法体，改为接收 `orm` 参数的 `finishTask` / `cancelTask`。类里的私有方法只负责调用它们，有变更时唤醒 Scheduler。

`submission.ts`、`shared.ts` 与 `test/tasks/long-tasks.test.ts` 改为从 `quota.ts` 导入，没有留 re-export。拆分后 `index.ts` 约 16 KB。

### 5. 测试

新增 `test/image/agent-quota.test.ts`，通过 `execute.call image_generate` 走完整的工具、bridge 与审计链路：

- 同一 Invocation 内连续 5 轮，每轮等任务结算后再提交下一轮，5 次全部成功：5 次 provider 调用，5 个 `completed` 任务，5 条 `success` 审计行（失败方式 1）。改动前同一测试在第 4 轮报 `image generation quota of 3 per invocation reached`。
- provider 挂起时连交 3 个都被接受，第 4 个被拒：generation 行和任务都还是 3 个，审计为 `image_generate_quota_exceeded`，并检查文案（失败方式 3、4、7）。放行第一轮、任务结算后，第 4 个可以提交。

`test/image/agent-fixtures.ts` 的 provider 替身加了可选的 `hold`，用来让调用一直挂起；中止信号会释放它，免得收尾时卡住。调用序号在挂起前就取定，`plan` 不会因为期间又进来一个请求而读错下标（Open Code Review 第三轮意见）。

`test/tasks/long-tasks.test.ts` 覆盖两种口径：`created` 在任务完成、取消后仍然计数；`waiting` 在完成、失败、取消后各让出一个名额，5 个任务里同时等待的从不超过 2 个；早先 Invocation 的等待任务不影响后来的 Invocation；非法 `max` 与没有 Invocation 的调用被拒（失败方式 6）。`test/alarm/alarm.test.ts` 补了一段：用 `delete_alarm` 取消一个之后，第 4 个闹钟仍以 `alarm_quota_exceeded` 被拒（失败方式 5）。

## 验证

```bash
pnpm exec vitest run test/image/agent-quota.test.ts   # 改动前：2 failed（第 4 轮被拒）
git diff --check                                      # 通过
pnpm run lint                                         # exit 0
pnpm run check                                        # exit 0（tsc、cli、admin-next、docs）
pnpm test                                             # 496 files, 2630 passed（拆分 long-tasks 之后）
DOCS_BASE_PATH=/ pnpm run docs:build && DOCS_BASE_PATH=/ pnpm run docs:verify
DOCS_BASE_PATH=/surowan/ pnpm run docs:build && DOCS_BASE_PATH=/surowan/ pnpm run docs:verify
# 两遍都 Verified 148 HTML/Markdown pages；test/docs/*.test.ts 逐文件通过；构建后工作区没有多出文件
pnpm exec vitest run test/image/                      # 修正 fixture 序号之后：87 passed
```

Open Code Review（workspace 模式，Markdown 与测试文件按默认规则不在审阅范围内）：

- 第一轮，7 个源码文件，1 条 medium：报错文案不该让模型对用户说「已排队」。已修正。
- 第二轮，0 条。
- 第三轮（拆分之后），9 个文件，1 条 medium：fixture 在挂起后才读调用序号。已修正，之后没有再跑 OCR。

未运行：部署实例上的真实验收（Telegram 群里连续修改 4 张以上、同时提交第 4 个时模型的实际措辞）。

## 提交

```txt
c3fa209b Count only in-progress image generations against the invocation cap
```
