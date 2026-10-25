import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { longTasks, taskReceipts } from '../../src/store/schema/index.ts';
import { cleanupTestDirectories, ctx, initDb, seedInvocation } from './fixtures.ts';

afterEach(cleanupTestDirectories);

describe('LongTaskService', () => {
  test('a single-host instance completes only its own timers', async () => {
    const { store, conversationId, roomConversationId } = await initDb();
    const due = new Date(Date.now() - 60_000).toISOString();
    seedInvocation(store, 300n, conversationId);
    seedInvocation(store, 301n, roomConversationId);
    const telegramChat = ctx(conversationId, { hostKind: 'telegram', invocationId: 300n });
    const roomChat = ctx(roomConversationId, { hostKind: 'playground', invocationId: 301n });
    const all = new LongTaskService(store.orm);
    const telegramTask = all
      .invocationScope('alarm', telegramChat)
      .create({ payload: { kind: 'telegram' }, scheduledAt: due, timerResult: { kind: 'telegram' } }, new Date());
    const roomTask = all
      .invocationScope('alarm', roomChat, ['telegram', 'playground'])
      .create({ payload: { kind: 'room' }, scheduledAt: due, timerResult: { kind: 'room' } }, new Date());

    const roomOnly = new LongTaskService(store.orm, undefined, ['playground']);
    expect(roomOnly.nextDeadline()).toBeDefined();
    roomOnly.processDue(new Date());

    const stateOf = (taskId: bigint) =>
      store.orm.select({ state: longTasks.state }).from(longTasks).where(eq(longTasks.id, taskId)).get()?.state;
    expect(stateOf(telegramTask.taskId)).toBe('waiting');
    expect(stateOf(roomTask.taskId)).toBe('completed');
    // The scoped path writes the same receipt payload the unscoped one does.
    expect(
      store.orm
        .select({ resultJson: taskReceipts.resultJson })
        .from(taskReceipts)
        .where(eq(taskReceipts.taskId, roomTask.taskId))
        .get(),
    ).toEqual({ resultJson: JSON.stringify({ kind: 'room' }) });
    // The filtered instance no longer advertises the Telegram timer.
    expect(roomOnly.nextDeadline()).toBeUndefined();

    // Without a filter the same service completes it, exactly as serve does.
    all.processDue(new Date());
    expect(stateOf(telegramTask.taskId)).toBe('completed');
  });

  test('processDue completes timer tasks and calls wake', async () => {
    let woken = false;
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm, () => {
      woken = true;
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({
      payload: { summary: 'timer' },
      delivery: { bypassDailyBudget: true },
      scheduledAt: past,
    });

    tasks.processDue(new Date());
    expect(woken).toBe(true);

    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('completed');
    expect(task!.timerResultJson).toBeDefined();

    const receipt = store.orm.select().from(taskReceipts).where(eq(taskReceipts.taskId, created.taskId)).get();
    expect(receipt).toBeDefined();
    expect(receipt!.state).toBe('pending');
  });

  test('processDue skips future timers', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    const created = scope.create({
      payload: {},
      delivery: { bypassDailyBudget: false },
      scheduledAt: future,
    });
    tasks.processDue(new Date());
    const task = store.orm.select().from(longTasks).where(eq(longTasks.id, created.taskId)).get();
    expect(task!.state).toBe('waiting');
  });

  test('nextDeadline returns earliest waiting timer', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const t1 = new Date(Date.now() + 7200_000).toISOString();
    const t0 = new Date(Date.now() + 3600_000).toISOString();
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false }, scheduledAt: t1 });
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false }, scheduledAt: t0 });
    expect(tasks.nextDeadline()).toBe(t0);
  });

  test('nextDeadline returns undefined when no timers', async () => {
    const { store, conversationId } = await initDb();
    seedInvocation(store, 100n, conversationId);
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.invocationScope('alarm', ctx(conversationId));
    scope.create({ payload: {}, delivery: { bypassDailyBudget: false } });
    expect(tasks.nextDeadline()).toBeUndefined();
  });
});
