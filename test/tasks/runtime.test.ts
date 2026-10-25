import { afterEach, expect, test } from 'vitest';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { enterSleep } from '../../src/store/sleep.ts';
import { cleanupTaskRuntime, eventually, insertInvocation, setup, taskState } from './runtime-fixtures.ts';

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
