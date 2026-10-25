import { afterAll, describe, expect, test } from 'vitest';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { BotCommandService } from '../../src/orchestration/bot-commands/index.ts';
import { enterSleep } from '../../src/store/sleep.ts';
import {
  cleanupTestDirectories,
  ensureConversation,
  getAlarmTask,
  insertAlarm,
  processDue,
  setup,
  update,
} from './fixtures.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

describe('alarm scheduling behavior', () => {
  test('launches a claimed alarm before an already-queued normal invocation, then the queued normal runs', async () => {
    const { store, ingestion, scheduler, configStore } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    const launched: bigint[] = [];
    let releaseGate!: () => void;
    let firstLaunched!: () => void;
    const firstSignal = new Promise<void>((resolve) => {
      firstLaunched = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const recording = new BucketScheduler(store, configStore, async (id) => {
      launched.push(id);
      if (launched.length === 1) {
        firstLaunched();
        await gate;
      }
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await firstSignal;
    const alarmInvocation = store.db
      .prepare<[], { invocation_id: bigint }>(
        "SELECT invocation_id FROM task_receipts WHERE state IN ('claimed', 'handled') ORDER BY task_id LIMIT 1",
      )
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    // While the alarm is still running, the queued normal invocation must wait.
    expect(
      store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('queued');
    releaseGate();
    while (launched.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await recording.stop(30_000);
    expect(launched).toEqual([alarmInvocation, normalInvocation]);
    store.close();
  });

  test('a claimed alarm still launches while the bot is sleeping', async () => {
    const { store, ingestion, scheduler, configStore } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const normalInvocation = processDue(scheduler, new Date(received.getTime() + 15_000));
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    enterSleep(store.orm);

    const launched: bigint[] = [];
    const recording = new BucketScheduler(store, configStore, async (id) => {
      launched.push(id);
      return { state: 'completed', reason: 'done' };
    });
    recording.start(new Date('2026-08-15T00:00:00.000Z'));
    await recording.stop(30_000);

    const alarmInvocation = store.db
      .prepare<[], { invocation_id: bigint }>(
        "SELECT invocation_id FROM task_receipts WHERE state = 'handled' ORDER BY task_id LIMIT 1",
      )
      .get()?.invocation_id;
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }
    expect(launched).toEqual([alarmInvocation]);
    expect(
      store.db.prepare<[bigint], { state: string }>('SELECT state FROM invocations WHERE id = ?').get(normalInvocation)
        ?.state,
    ).toBe('skipped_budget');
    store.close();
  });

  test('does not claim while a same-chat invocation is running, then claims on release', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(received.toISOString(), invocationId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(received.toISOString(), invocationId);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');

    expect(scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'))).toEqual([]);
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'pending',
      state: 'pending',
    });

    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run('2026-08-15T00:00:01.000Z', invocationId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run('2026-08-15T00:00:01.000Z', invocationId);

    const claimed = scheduler.processTasksDue(new Date('2026-08-15T00:00:01.000Z'));
    expect(claimed).toHaveLength(1);
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'claimed',
      state: 'firing',
    });
    store.close();
  });

  test('pause after claim closes the firing alarm as cancelled/chat_paused', async () => {
    const { store, scheduler, configStore } = await setup();
    const conversation = ensureConversation(store);
    const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    const [invocationId] = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    if (invocationId === undefined) {
      throw new Error('Expected claimed alarm invocation');
    }

    const commands = new BotCommandService(store, configStore, scheduler);
    expect(
      await commands.run(
        { name: 'pause' },
        123456789n,
        { id: 42n, name: 'Alice', username: null },
        new Date('2026-08-15T00:00:00.000Z'),
      ),
    ).toContain('已暂停');

    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_paused',
      admin_cancelled: 0n,
    });
    expect(
      store.db
        .prepare<[bigint], { state: string; completion_reason: string | null }>(
          'SELECT state, completion_reason FROM invocations WHERE id = ?',
        )
        .get(invocationId),
    ).toEqual({ state: 'aborted', completion_reason: 'chat_paused' });
    store.close();
  });

  test('every terminal invocation outcome closes the alarm without retry', async () => {
    const { store, configStore } = await setup();
    const outcomes: Array<{ state: 'completed' | 'failed' | 'aborted' | 'outcome_unknown'; reason: string }> = [
      { state: 'completed', reason: 'completed' },
      { state: 'failed', reason: 'model_error' },
      { state: 'aborted', reason: 'timeout' },
      { state: 'outcome_unknown', reason: 'telegram_unknown' },
    ];
    for (const outcome of outcomes) {
      const conversation = ensureConversation(store);
      const alarmId = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
      const scheduler = new BucketScheduler(store, configStore, async () => outcome);
      scheduler.start(new Date('2026-08-15T00:00:00.000Z'));
      await scheduler.stop(30_000);
      expect(getAlarmTask(store, alarmId)).toMatchObject({
        task_state: 'completed',
        receipt_state: 'handled',
        state: 'fired',
        invocation_outcome: outcome.state,
        completion_reason: outcome.reason,
      });
    }
    store.close();
  });
});
