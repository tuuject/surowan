import { afterEach, expect, test } from 'vitest';
import { enterSleep } from '../src/store/sleep.ts';
import {
  addConversation,
  cleanupTaskRuntime,
  deferred,
  eventually,
  insertInvocation,
  setup,
  taskState,
} from './task-runtime-fixtures.ts';

afterEach(cleanupTaskRuntime);

test('receipt invocations outrank ordinary work, serialize topics of one chat, and run across chats', async () => {
  const starts: bigint[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const { store, scheduler, tasks } = await setup(
    (config) => {
      config.telegram.chats[0] = { id: 123456789, topic_ids: [10, 20] };
      config.telegram.chats.push({ id: 987654321 }, { id: 777777777 }, { id: 888888888 });
      config.agent!.max_concurrency = 2;
    },
    async (invocationId) => {
      starts.push(invocationId);
      const gate = gates.get(invocationId.toString());
      if (gate !== undefined) {
        await gate.promise;
      }
      return { state: 'completed', reason: 'done' };
    },
  );
  store.db.prepare('UPDATE conversations SET message_thread_id = 10 WHERE id = 1').run();
  addConversation(store, 1n, 2n, 123456789n, 20n, 'supergroup');
  addConversation(store, 2n, 3n, 987654321n, 0n);
  addConversation(store, 3n, 4n, 777777777n, 0n);
  addConversation(store, 4n, 5n, 888888888n, 0n);
  const blockerA = insertInvocation(store, 8n, 4n, 'queued');
  const blockerB = insertInvocation(store, 9n, 5n, 'queued');
  gates.set(blockerA.toString(), deferred());
  gates.set(blockerB.toString(), deferred());

  try {
    scheduler.start();
    await eventually(() => starts.length === 2, 'initial concurrency blockers');

    const ordinarySameChat = insertInvocation(store, 10n, 2n, 'queued');
    const ordinaryOtherChat = insertInvocation(store, 11n, 3n, 'queued');
    gates.set(ordinaryOtherChat.toString(), deferred());
    const receipt = tasks.scoped('external-plugin', 1n).create({ payload: { priority: true } });
    tasks.scoped('external-plugin', 1n).complete(receipt.taskId);
    const [receiptInvocation] = scheduler.processTasksDue(new Date());
    if (receiptInvocation === undefined) {
      throw new Error('Expected receipt invocation');
    }
    gates.set(receiptInvocation.toString(), deferred());

    gates.get(blockerA.toString())?.resolve();
    gates.get(blockerB.toString())?.resolve();
    await eventually(() => starts.length === 4, 'receipt and cross-chat ordinary launches');
    expect(starts.slice(2)).toContain(receiptInvocation);
    expect(starts.slice(2)).toContain(ordinaryOtherChat);
    expect(starts).not.toContain(ordinarySameChat);
    gates.get(receiptInvocation.toString())?.resolve();
    await eventually(() => starts.includes(ordinarySameChat), 'same-chat topic after receipt');
  } finally {
    for (const gate of gates.values()) {
      gate.resolve();
    }
    await scheduler.stop();
  }
});

test('sleep entered after receipt claim but before launch settles it as skipped_budget', async () => {
  const blocker = deferred();
  const blockerStarted = deferred();
  let first = true;
  const { store, scheduler, tasks, conversationId } = await setup(
    (config) => {
      config.telegram.chats.push({ id: 987654321 });
      config.agent!.max_concurrency = 1;
    },
    async () => {
      if (first) {
        first = false;
        blockerStarted.resolve();
        await blocker.promise;
      }
      return { state: 'completed', reason: 'done' };
    },
  );
  addConversation(store, 2n, 2n, 987654321n, 0n);
  insertInvocation(store, 50n, 2n, 'queued');

  try {
    scheduler.start();
    await blockerStarted.promise;
    const created = tasks.scoped('external-plugin', conversationId).create({ payload: { race: 'sleep' } });
    tasks.scoped('external-plugin', conversationId).complete(created.taskId);
    const [receiptInvocation] = scheduler.processTasksDue(new Date());
    expect(receiptInvocation).toBeDefined();
    expect(taskState(store, created.taskId)?.state).toBe('claimed');
    enterSleep(store.orm, new Date());
    blocker.resolve();
    await eventually(() => taskState(store, created.taskId)?.state === 'handled', 'sleep settlement');
    expect(
      store.db
        .prepare<[bigint], { state: string; completion_reason: string }>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(receiptInvocation!),
    ).toEqual({ state: 'skipped_budget', completion_reason: 'sleeping' });
    expect(
      store.db
        .prepare<[bigint], { state: string; invocation_outcome: string; completion_reason: string }>(
          'SELECT state, invocation_outcome, completion_reason FROM task_receipts WHERE task_id = ?',
        )
        .get(created.taskId),
    ).toEqual({ state: 'handled', invocation_outcome: 'skipped_budget', completion_reason: 'sleeping' });
  } finally {
    blocker.resolve();
    await scheduler.stop();
  }
});

test('busy timer completion stays pending without a spin and launches when the running chat finishes', async () => {
  const running = deferred();
  const firstStarted = deferred();
  const receiptStarted = deferred();
  let handlerCalls = 0;
  const { store, scheduler, tasks, conversationId } = await setup(undefined, async () => {
    handlerCalls += 1;
    if (handlerCalls === 1) {
      firstStarted.resolve();
      await running.promise;
    } else {
      receiptStarted.resolve();
    }
    return { state: 'completed', reason: 'done' };
  });
  insertInvocation(store, 70n, conversationId, 'queued');
  const due = new Date(Date.now() + 20);
  const timer = tasks.scoped('timer-plugin', conversationId).create({
    payload: { timer: true },
    scheduledAt: due.toISOString(),
    timerResult: { fired: true },
  });

  try {
    scheduler.start();
    await firstStarted.promise;
    await eventually(() => taskState(store, timer.taskId)?.state === 'pending', 'timer completion while busy');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlerCalls).toBe(1);
    expect(taskState(store, timer.taskId)?.state).toBe('pending');
    running.resolve();
    await receiptStarted.promise;
    await eventually(() => taskState(store, timer.taskId)?.state === 'handled', 'receipt after busy run');
    expect(handlerCalls).toBe(2);
  } finally {
    running.resolve();
    await scheduler.stop();
  }
});
