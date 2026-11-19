import { afterEach, expect, test } from 'vitest';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { enterSleep } from '../../src/store/sleep.ts';
import {
  addPlaygroundConversation,
  cleanupTaskRuntime,
  eventually,
  insertInvocation,
  setup,
  taskState,
} from './runtime-fixtures.ts';

afterEach(cleanupTaskRuntime);

test('task service wake callback only nudges the existing scheduler', async () => {
  const { store, scheduler, conversationId } = await setup();
  let wakes = 0;
  const tasks = new LongTaskService(store.orm, () => {
    wakes += 1;
    scheduler.wake();
  });
  scheduler.start();
  try {
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { wake: true } });
    expect(wakes).toBe(1);
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    expect(wakes).toBe(2);
    await eventually(
      () => taskState(store, created.taskId)?.state === 'handled',
      'delivery through existing scheduler',
    );
  } finally {
    await scheduler.stop();
  }
});

test('pending default receipts wait for sleep, while bypass receipts can claim', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  const defaultTask = tasks.scoped('external-plugin', conversationId).create({ payload: { type: 'default' } });
  const bypassTask = tasks.scoped('external-plugin', conversationId).create({
    payload: { type: 'bypass' },
    delivery: { bypassDailyBudget: true },
  });
  expect(tasks.scoped('external-plugin', conversationId).complete(defaultTask.taskId)).toBe(true);
  expect(tasks.scoped('external-plugin', conversationId).complete(bypassTask.taskId)).toBe(true);
  enterSleep(store.orm, new Date());

  scheduler.processTasksDue(new Date());

  expect(taskState(store, defaultTask.taskId)?.state).toBe('pending');
  expect(taskState(store, bypassTask.taskId)?.state).toBe('claimed');
});

test('sleep holds a telegram receipt but a room receipt still claims', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  addPlaygroundConversation(store, 2n, 2n);
  const waiting = tasks.scoped('external-plugin', conversationId).create({ payload: { kind: 'wait' } });
  const room = tasks.scoped('external-plugin', 2n).create({ payload: { kind: 'room' } });
  tasks.scoped('external-plugin', conversationId).complete(waiting.taskId);
  tasks.scoped('external-plugin', 2n).complete(room.taskId);
  enterSleep(store.orm, new Date());

  scheduler.processTasksDue(new Date());

  // sleep: true waits out the window; sleep: false never observes it.
  expect(taskState(store, waiting.taskId)?.state).toBe('pending');
  expect(taskState(store, room.taskId)?.state).toBe('claimed');
});

test('during sleep the scheduler wakes only for a bypass receipt on a bypass-capable host', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  const waiting = tasks.scoped('external-plugin', conversationId).create({ payload: { kind: 'wait' } });
  tasks.scoped('external-plugin', conversationId).complete(waiting.taskId);
  enterSleep(store.orm, new Date());

  // sleepUntil is at least the minimum sleep away: no due deadline inside a minute.
  expect(scheduler.nextDelayMilliseconds()).toBe(60_000);

  const bypass = tasks
    .scoped('external-plugin', conversationId)
    .create({ payload: { kind: 'bypass' }, delivery: { bypassDailyBudget: true } });
  tasks.scoped('external-plugin', conversationId).complete(bypass.taskId);

  // The pending bypass receipt on Telegram (sleep + budgetBypass) counts as due.
  expect(scheduler.nextDelayMilliseconds()).toBeLessThan(5_000);
});

test('sleep skips queued telegram invocations, not room work or bypass deliveries', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  addPlaygroundConversation(store, 2n, 2n);
  const ordinary = insertInvocation(store, 10n, conversationId, 'queued');
  const roomQueued = insertInvocation(store, 11n, 2n, 'queued');
  const bypass = tasks
    .scoped('external-plugin', conversationId)
    .create({ payload: { kind: 'bypass' }, delivery: { bypassDailyBudget: true } });
  tasks.scoped('external-plugin', conversationId).complete(bypass.taskId);
  enterSleep(store.orm, new Date());

  // The loop's first pass claims the pending bypass receipt during sleep,
  // queues its delivery, and must not skip it: the receipt's host carries
  // budgetBypass. A claimed receipt left queued is otherwise crash residue.
  scheduler.start(new Date());
  await scheduler.stop();
  const delivery = store.db.prepare('SELECT invocation_id FROM task_receipts WHERE task_id = ?').get(bypass.taskId) as {
    invocation_id: bigint;
  };

  const states = (ids: readonly bigint[]) =>
    store.db
      .prepare(`SELECT id, state FROM invocations WHERE id IN (${ids.map(String).join(',')}) ORDER BY id`)
      .all() as { id: bigint; state: string }[];
  expect(states([ordinary, roomQueued, delivery.invocation_id])).toEqual([
    { id: ordinary, state: 'skipped_budget' },
    { id: roomQueued, state: 'completed' },
    { id: delivery.invocation_id, state: 'completed' },
  ]);
  expect(taskState(store, bypass.taskId)).toEqual({ state: 'handled', invocation_id: delivery.invocation_id });
});

test('timer completion becomes pending even while its chat has a running invocation, without claiming delivery', async () => {
  const { store, scheduler, tasks, conversationId } = await setup();
  insertInvocation(store, 9n, conversationId, 'running');
  const due = '2026-01-02T00:00:00.000Z';
  const created = tasks.scoped('timer-plugin', conversationId).create({
    payload: { subject: 'timer' },
    scheduledAt: due,
    timerResult: { fired: true },
  });

  expect(scheduler.processTasksDue(new Date(due))).toEqual([]);
  expect(
    store.db.prepare<[bigint], { state: string }>('SELECT state FROM long_tasks WHERE id = ?').get(created.taskId)
      ?.state,
  ).toBe('completed');
  expect(taskState(store, created.taskId)?.state).toBe('pending');
});
