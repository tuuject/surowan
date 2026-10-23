import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { longTasks, taskReceipts } from '../src/store/schema.ts';
import { cleanupTestDirectories, ctx, initDb, seedInvocation } from './long-tasks-fixtures.ts';

afterEach(cleanupTestDirectories);

describe('LongTaskService', () => {
  test('scoped complete writes receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });

    const handle = tasks.scoped('test-plugin', conversationId);
    const ok = handle.complete(created.taskId, { result: 'done' });
    expect(ok).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('completed');
    expect(task!.finishedAt).toBeDefined();

    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt).toBeDefined();
    expect(receipt!.status).toBe('completed');
    expect(receipt!.state).toBe('pending');
    expect(JSON.parse(receipt!.resultJson!)).toEqual({ result: 'done' });
  });

  test('scoped complete is idempotent (CAS)', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const handle = tasks.scoped('test-plugin', conversationId);
    expect(handle.complete(created.taskId)).toBe(true);
    expect(handle.complete(created.taskId)).toBe(false);
  });

  test('scoped fail writes error receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const ok = tasks.scoped('test-plugin', conversationId).fail(created.taskId, { code: 'E_TIMEOUT' });
    expect(ok).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('failed');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.status).toBe('failed');
    expect(JSON.parse(receipt!.errorJson!)).toEqual({ code: 'E_TIMEOUT' });
  });

  test('scoped works cross-plugin isolated', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('plugin-x', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('plugin-y', conversationId).complete(created.taskId)).toBe(false);
  });

  test('scoped works cross-conversation isolated after creator invocation is deleted', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('plugin-x', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    store.db.prepare('DELETE FROM invocations WHERE id = 100').run();
    expect(tasks.scoped('plugin-x', 999n).complete(created.taskId)).toBe(false);
    expect(tasks.scoped('plugin-x', conversationId).complete(created.taskId, { late: true })).toBe(true);
  });

  test('getCompletion returns receipt bound to invocation', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: { data: 'x' }, delivery: { bypassDailyBudget: false } });
    tasks.scoped('test-plugin', conversationId).complete(created.taskId);

    // Seed an invocation for the receipt's FK.
    seedInvocation(store, 500n, conversationId);
    store.orm
      .update(taskReceipts)
      .set({
        state: 'claimed',
        invocationId: 500n,
        bucketId: 500n,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(taskReceipts.taskId, created.taskId))
      .run();

    const completion = tasks.getCompletion(500n, 500n);
    expect(tasks.getCompletion(500n, 100n)).toBeUndefined();
    expect(tasks.getCompletion(100n, 500n)).toBeUndefined();
    expect(completion).toBeDefined();
    expect(completion!.taskId).toBe(created.taskId);
    expect(completion!.pluginId).toBe('test-plugin');
    expect(completion!.payload).toEqual({ data: 'x' });
    expect(completion!.status).toBe('completed');
  });

  test('getCompletion returns undefined for non-receipt invocation', async () => {
    const { store } = await initDb();
    const tasks = new LongTaskService(store.orm);
    expect(tasks.getCompletion(999999n, 999999n)).toBeUndefined();
  });

  test('cancel via scoped works', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('test-plugin', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.scoped('test-plugin', conversationId).cancel(created.taskId)).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('cancelled');
    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt!.state).toBe('suppressed');
  });

  test('complete, fail, and cancel race writes one terminal receipt', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    const handle = tasks.scoped('alarm', conversationId);
    expect(handle.fail(created.taskId, { code: 'first' })).toBe(true);
    expect(handle.complete(created.taskId, { value: 'late' })).toBe(false);
    expect(handle.cancel(created.taskId)).toBe(true);
    expect(store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).all()).toHaveLength(1);
    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('failed');
  });

  test('wake occurs only after successful state changes', async () => {
    let wakes = 0;
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm, () => {
      wakes += 1;
    });
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(wakes).toBe(1);
    expect(tasks.scoped('other', conversationId).complete(created.taskId)).toBe(false);
    expect(wakes).toBe(1);
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(true);
    expect(wakes).toBe(2);
    expect(tasks.scoped('alarm', conversationId).complete(created.taskId)).toBe(false);
    expect(wakes).toBe(2);
  });
});
