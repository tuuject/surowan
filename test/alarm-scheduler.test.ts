import { afterAll, describe, expect, test } from 'vitest';
import { purgeExpiredData } from '../src/store/store.ts';
import {
  cleanupTestDirectories,
  ensureConversation,
  getAlarmTask,
  insertAlarm,
  setup,
  update,
} from './alarm-fixtures.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

describe('alarm scheduler', () => {
  test('claims a due alarm into an invocation and leaves the topic conversation untouched', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z');
    const invocations = scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(invocations).toHaveLength(1);
    const alarm = getAlarmTask(store, alarmId);
    expect(alarm?.task_state).toBe('completed');
    expect(alarm?.receipt_state).toBe('claimed');
    expect(alarm?.state).toBe('firing');
    expect(alarm?.invocation_id).toBe(invocations[0]);
    const context = build(invocations[0] ?? 0n, { contextWindow: 200_000, maxOutputTokens: 32768 });
    expect(context.completion?.delivery.mentionUser?.userId).toBe(42n);
    // The alarm task is per-invocation state and travels with the injected batch.
    expect(context.userPrompt).toContain('test alarm');
    expect(context.userPrompt).toContain('long-running task has finished');
    expect(context.systemPrompt).not.toContain('test alarm');
    const newCount = store.db
      .prepare<[bigint], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
      )
      .get(invocations[0] ?? 0n)?.count;
    expect(newCount).toBe(0n);
    store.close();
  });

  test('cancels due alarms for pause, chat removal, and topic removal', async () => {
    const { store, scheduler } = await setup();
    const conversation = ensureConversation(store);
    const chat = store.db
      .prepare<[bigint], { chat_id: bigint }>('SELECT chat_id FROM conversations WHERE id = ?')
      .get(conversation);
    const pausedAlarm = insertAlarm(store, conversation, '2026-08-14T23:59:00.000Z');
    store.db
      .prepare('INSERT INTO chat_pause(chat_id, paused_at) VALUES (?, ?)')
      .run(chat?.chat_id ?? 0n, new Date().toISOString());
    scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, pausedAlarm)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_paused',
    });

    const removedChat = store.db
      .prepare<[string], { id: bigint }>(
        "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (999999999, 999999999, 'group', 'Removed', ?) RETURNING id",
      )
      .get(new Date().toISOString());
    const removedConversation = store.db
      .prepare<[bigint, string, string], { id: bigint }>(
        'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
      )
      .get(removedChat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
    const removedAlarm = insertAlarm(store, removedConversation?.id ?? 0n, '2026-08-14T23:59:00.000Z');
    scheduler.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, removedAlarm)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'suppressed',
      state: 'cancelled',
      cancel_reason: 'chat_removed',
    });
    store.close();
  });

  test('recovers a firing alarm as fired/outcome_unknown and never returns it to pending', async () => {
    const { store, ingestion, scheduler } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    const alarmId = insertAlarm(store, conversation.id, '2026-08-14T23:59:00.000Z', { state: 'firing' });
    scheduler.recover(new Date('2026-08-15T00:00:00.000Z'));
    expect(getAlarmTask(store, alarmId)).toMatchObject({
      task_state: 'completed',
      receipt_state: 'handled',
      state: 'fired',
      invocation_outcome: 'outcome_unknown',
      completion_reason: 'outcome_unknown',
    });
    scheduler.recover(new Date('2026-08-15T00:00:01.000Z'));
    expect(getAlarmTask(store, alarmId)?.state).toBe('fired');
    store.close();
  });
});

describe('alarm retention', () => {
  test('keeps pending and firing alarms but purges terminal history', async () => {
    const { store, loaded } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z');
    const firing = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'firing' });
    const fired = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'fired' });
    const cancelled = insertAlarm(store, conversation, '2026-01-01T00:00:00.000Z', { state: 'cancelled' });
    store.db
      .prepare('UPDATE long_tasks SET finished_at = ?, updated_at = ? WHERE id IN (?, ?)')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', fired, cancelled);
    store.db
      .prepare('UPDATE task_receipts SET claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', fired);
    store.db
      .prepare('UPDATE task_receipts SET cancelled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', cancelled);

    purgeExpiredData(store.orm, loaded.config, new Date('2026-03-01T00:00:00.000Z'));
    const ids = [pending, firing, fired, cancelled];
    const tasks = store.db
      .prepare<bigint[], { id: bigint; task_state: string; receipt_state: string | null }>(
        `SELECT lt.id, lt.state AS task_state, tr.state AS receipt_state
           FROM long_tasks lt LEFT JOIN task_receipts tr ON tr.task_id = lt.id
          WHERE lt.id IN (?, ?, ?, ?) ORDER BY lt.id`,
      )
      .all(...ids);
    expect(tasks).toEqual([
      { id: pending, task_state: 'completed', receipt_state: 'pending' },
      { id: firing, task_state: 'completed', receipt_state: 'claimed' },
    ]);
    expect(
      store.db
        .prepare<bigint[], { count: bigint }>(
          'SELECT COUNT(*) AS count FROM task_receipts WHERE task_id IN (?, ?, ?, ?)',
        )
        .get(...ids)?.count,
    ).toBe(2n);
    store.close();
  });
});
