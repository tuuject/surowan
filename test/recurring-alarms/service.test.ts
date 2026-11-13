import { describe, expect, test } from 'vitest';
import { purgeExpiredData } from '../../src/store/store.ts';
import { RecurringAlarmError } from '../../src/store/recurring-alarms/records.ts';
import { draft, firings, minuteNow, plus, setup, taskRows } from './fixtures.ts';

const MINUTE = 60_000;

function errorCode(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof RecurringAlarmError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe('recurring alarm definitions', () => {
  test('create validates rules, text and target, and stores the next occurrence', async () => {
    const { recurring, store } = await setup();
    const now = minuteNow();
    const created = recurring.create(1n, draft({ rules: [' */5  * * * * '] }), 'admin', now);
    expect(created.rules).toEqual(['*/5 * * * *']);
    expect(created.revision).toBe(1n);
    expect(created.nextFireAt).toBe(recurring.engine.nextAfter(['*/5 * * * *'], 'UTC', now)?.toISOString());

    const invalid = (() => {
      try {
        recurring.create(1n, draft({ rules: ['0 8 * * *', '0 8 L * *'] }), 'admin', now);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(invalid).toBeInstanceOf(RecurringAlarmError);
    expect(invalid).toMatchObject({ code: 'invalid_rules', issues: [{ index: 1, code: 'unsupported' }] });
    expect(errorCode(() => recurring.create(1n, draft({ timeZone: 'Mars/Base' }), 'admin', now))).toBe(
      'invalid_time_zone',
    );
    expect(errorCode(() => recurring.create(1n, draft({ title: '   ' }), 'admin', now))).toBe('invalid_title');
    expect(errorCode(() => recurring.create(1n, draft({ title: 'x'.repeat(81) }), 'admin', now))).toBe('invalid_title');
    expect(errorCode(() => recurring.create(1n, draft({ prompt: 'x'.repeat(4001) }), 'admin', now))).toBe(
      'invalid_prompt',
    );
    // 4000 control characters fit the character limit but not the encoded payload.
    expect(errorCode(() => recurring.create(1n, draft({ prompt: '\u0001'.repeat(4000) }), 'admin', now))).toBe(
      'invalid_prompt',
    );
    store.db.prepare("INSERT INTO chat_pause(chat_id, paused_at) VALUES (1, '2020-01-01T00:00:00.000Z')").run();
    expect(errorCode(() => recurring.create(1n, draft(), 'admin', now))).toBe('target_unavailable');
    expect(errorCode(() => recurring.create(99n, draft(), 'admin', now))).toBe('target_unavailable');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM recurring_alarms').get()).toEqual({ n: 1n });
  });

  test('a conversation holds at most 20 recurring alarms', async () => {
    const { recurring } = await setup();
    const now = minuteNow();
    for (let index = 0; index < 20; index += 1) {
      recurring.create(1n, draft({ title: `alarm ${index}` }), 'admin', now);
    }
    expect(errorCode(() => recurring.create(1n, draft(), 'admin', now))).toBe('too_many_recurring_alarms');
  });

  test('edits recompute the next occurrence only when the schedule changes, under a revision (F11)', async () => {
    const { recurring, tasks } = await setup();
    const now = minuteNow();
    const created = recurring.create(1n, draft(), 'admin', now);
    const later = plus(now, 2 * MINUTE);
    const prompted = recurring.update(created.id, 1n, draft({ prompt: 'Changed.' }), 'editor', later);
    expect(prompted).toMatchObject({ revision: 2n, nextFireAt: created.nextFireAt, updatedBy: 'editor' });
    expect(errorCode(() => recurring.update(created.id, 1n, draft(), 'editor', later))).toBe('revision_conflict');

    const hourly = recurring.update(created.id, 2n, draft({ rules: ['0 * * * *'] }), 'editor', later);
    expect(hourly.nextFireAt).toBe(recurring.engine.nextAfter(['0 * * * *'], 'UTC', later)?.toISOString());
    expect(tasks.nextDeadline()).toBe(hourly.nextFireAt);

    const disabled = recurring.update(created.id, 3n, draft({ rules: ['0 * * * *'], enabled: false }), 'editor', later);
    expect(disabled.nextFireAt).toBeNull();
    expect(tasks.nextDeadline()).toBeUndefined();

    const reenabled = recurring.update(
      created.id,
      4n,
      draft({ rules: ['0 * * * *'] }),
      'editor',
      plus(later, 90 * MINUTE),
    );
    expect(reenabled.nextFireAt).toBe(
      recurring.engine.nextAfter(['0 * * * *'], 'UTC', plus(later, 90 * MINUTE))?.toISOString(),
    );
    expect(tasks.nextDeadline()).toBe(reenabled.nextFireAt);
    expect(errorCode(() => recurring.update(999n, 1n, draft(), 'editor', later))).toBe('not_found');
  });
});

describe('recurring alarm occurrences', () => {
  test('a due occurrence becomes one completed timer task with a pending receipt, exactly once (F3)', async () => {
    const { recurring, tasks, store } = await setup();
    const now = minuteNow();
    const created = recurring.create(1n, draft({ title: 'Briefing', prompt: 'Summarize the news.' }), 'admin', now);
    const due = created.nextFireAt ?? '';
    const at = plus(due, 10_000);
    tasks.processDue(at);
    tasks.processDue(at);
    expect(firings(store, created.id)).toEqual([
      {
        source: 'schedule',
        occurrence_at: due,
        outcome: 'scheduled',
        skip_reason: null,
        coalesced: 0n,
        task_id: expect.any(BigInt),
        triggered_by: null,
      },
    ]);
    const [task] = taskRows(store);
    expect(taskRows(store)).toHaveLength(1);
    expect(task).toMatchObject({
      plugin_id: 'recurring-alarm',
      state: 'completed',
      scheduled_at: due,
      receipt_state: 'pending',
    });
    expect(JSON.parse(task?.payload_json ?? '{}')).toEqual({
      recurring_alarm_id: created.id.toString(),
      source: 'schedule',
      title: 'Briefing',
      prompt: 'Summarize the news.',
      time_zone: 'UTC',
      occurrence_at: due,
      coalesced: 0,
    });
    expect(JSON.parse(task?.delivery_json ?? '{}')).toEqual({ bypassDailyBudget: true });
    expect(recurring.get(created.id)?.nextFireAt).toBe(
      recurring.engine.nextAfter(['*/5 * * * *'], 'UTC', at)?.toISOString(),
    );
  });

  test('missed occurrences fold into one delivery, and a long outage drops them (F4)', async () => {
    const { recurring, store } = await setup();
    const now = minuteNow();
    const late = recurring.create(1n, draft({ title: 'late' }), 'admin', now);
    const lost = recurring.create(1n, draft({ title: 'lost' }), 'admin', now);
    store.db
      .prepare('UPDATE recurring_alarms SET next_fire_at = ? WHERE id = ?')
      .run(plus(late.nextFireAt ?? '', 20 * MINUTE).toISOString(), lost.id);
    const due = late.nextFireAt ?? '';
    // 12 minutes late: 2 more five-minute occurrences passed and fold in.
    recurring.materializeDue(plus(due, 12 * MINUTE));
    expect(firings(store, late.id)).toEqual([expect.objectContaining({ outcome: 'scheduled', coalesced: 2n })]);
    expect(JSON.parse(taskRows(store)[0]?.payload_json ?? '{}')).toMatchObject({ coalesced: 2 });

    // 31 minutes after its due time, the second alarm is dropped as missed.
    recurring.materializeDue(plus(due, 51 * MINUTE));
    expect(firings(store, lost.id)).toEqual([
      expect.objectContaining({ outcome: 'skipped', skip_reason: 'missed', coalesced: 6n, task_id: null }),
    ]);
    expect(taskRows(store).filter((row) => row.payload_json.includes('"lost"'))).toEqual([]);
    expect(recurring.get(lost.id)?.nextFireAt).toBe(
      recurring.engine.nextAfter(['*/5 * * * *'], 'UTC', plus(due, 51 * MINUTE))?.toISOString(),
    );
  });

  test('an undelivered occurrence makes the next one skip instead of piling up (F5)', async () => {
    const { recurring, tasks, store } = await setup();
    const created = recurring.create(1n, draft(), 'admin', minuteNow());
    const first = created.nextFireAt ?? '';
    tasks.processDue(plus(first, 1000));
    for (const state of ['pending', 'claimed']) {
      store.db.prepare('UPDATE task_receipts SET state = ?').run(state);
      const due = recurring.get(created.id)?.nextFireAt ?? '';
      tasks.processDue(plus(due, 1000));
      expect(firings(store, created.id).at(-1)).toMatchObject({
        outcome: 'skipped',
        skip_reason: 'previous_pending',
        task_id: null,
      });
    }
    expect(taskRows(store)).toHaveLength(1);
    store.db.prepare("UPDATE task_receipts SET state = 'handled'").run();
    const due = recurring.get(created.id)?.nextFireAt ?? '';
    tasks.processDue(plus(due, 1000));
    expect(firings(store, created.id).at(-1)).toMatchObject({ outcome: 'scheduled' });
    expect(taskRows(store)).toHaveLength(2);
  });

  test('a paused, removed or off-allowlist target skips with its reason and keeps the definition (F6)', async () => {
    const { recurring, tasks, store, playground } = await setup({
      transform: (config) => {
        config.telegram.chats.push({ id: -100500, topic_ids: [7] });
      },
    });
    const now = minuteNow();
    const paused = recurring.create(1n, draft({ title: 'paused' }), 'admin', now);
    store.db
      .prepare(
        "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (2, -100500, -100500, 'supergroup', 'Forum', ?)",
      )
      .run(now.toISOString());
    const topic = recurring.ensureConversation(2n, 7n, now);
    const offTopic = recurring.create(topic, draft({ title: 'topic' }), 'admin', now);
    const room = playground.createRoom({ title: 'Lab' });
    const roomAlarm = recurring.create(room.conversationId, draft({ title: 'room' }), 'admin', now);

    store.db.prepare("INSERT INTO chat_pause(chat_id, paused_at) VALUES (1, '2020-01-01T00:00:00.000Z')").run();
    store.db.prepare('UPDATE conversations SET message_thread_id = 8 WHERE id = ?').run(topic);
    store.db.prepare('DELETE FROM rooms WHERE chat_id = ?').run(room.chatId);
    tasks.processDue(plus(paused.nextFireAt ?? '', 1000));
    expect(firings(store, paused.id)).toEqual([expect.objectContaining({ skip_reason: 'chat_paused' })]);
    expect(firings(store, offTopic.id)).toEqual([expect.objectContaining({ skip_reason: 'topic_removed' })]);
    expect(firings(store, roomAlarm.id)).toEqual([expect.objectContaining({ skip_reason: 'chat_removed' })]);
    expect(taskRows(store)).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM recurring_alarms WHERE enabled = 1').get()).toEqual({ n: 3n });
  });

  test('disabling or deleting suppresses an unclaimed delivery but not a claimed one (F9)', async () => {
    const { recurring, tasks, store } = await setup();
    const now = minuteNow();
    const disabled = recurring.create(1n, draft({ title: 'disabled' }), 'admin', now);
    const deleted = recurring.create(1n, draft({ title: 'deleted' }), 'admin', now);
    const claimed = recurring.create(1n, draft({ title: 'claimed' }), 'admin', now);
    tasks.processDue(plus(disabled.nextFireAt ?? '', 1000));
    store.db
      .prepare(
        "UPDATE task_receipts SET state = 'claimed' WHERE task_id = (SELECT task_id FROM recurring_alarm_firings WHERE recurring_alarm_id = ?)",
      )
      .run(claimed.id);
    recurring.update(disabled.id, 1n, draft({ title: 'disabled', enabled: false }), 'admin', now);
    recurring.delete(deleted.id, 'admin', now);
    recurring.update(claimed.id, 1n, draft({ title: 'claimed', enabled: false }), 'admin', now);
    const rows = taskRows(store).map((row) => ({
      title: JSON.parse(row.payload_json).title,
      receipt: row.receipt_state,
      reason: row.cancel_reason,
    }));
    expect(rows).toEqual([
      { title: 'disabled', receipt: 'suppressed', reason: 'recurring_alarm_disabled' },
      { title: 'deleted', receipt: 'suppressed', reason: 'recurring_alarm_deleted' },
      { title: 'claimed', receipt: 'claimed', reason: null },
    ]);
    expect(recurring.get(deleted.id)).toBeUndefined();
    expect(firings(store, deleted.id)).toEqual([]);
  });

  test('a single-host process neither fires nor waits for another host’s alarms (F10)', async () => {
    const { recurring, tasks, store, playground } = await setup({ hosts: ['playground'] });
    const now = minuteNow();
    const telegram = recurring.create(1n, draft({ title: 'telegram', rules: ['* * * * *'] }), 'admin', now);
    expect(tasks.nextDeadline()).toBeUndefined();
    const room = playground.createRoom({ title: 'Lab' });
    const roomAlarm = recurring.create(room.conversationId, draft({ title: 'room' }), 'admin', now);
    expect(tasks.nextDeadline()).toBe(roomAlarm.nextFireAt);
    tasks.processDue(plus(roomAlarm.nextFireAt ?? '', 1000));
    expect(firings(store, telegram.id)).toEqual([]);
    expect(recurring.get(telegram.id)?.nextFireAt).toBe(telegram.nextFireAt);
    expect(firings(store, roomAlarm.id)).toHaveLength(1);
    expect(() => recurring.runNow(telegram.id, 'admin', now)).toThrow(
      expect.objectContaining({ code: 'target_unavailable' }),
    );
  });

  test('a definition that cannot produce its task rolls back as a whole and is parked', async () => {
    const { recurring, tasks, store } = await setup();
    const created = recurring.create(1n, draft(), 'admin', minuteNow());
    // Past the validator, as an old row could be: it fits the column but not the payload.
    store.db.prepare('UPDATE recurring_alarms SET prompt = ? WHERE id = ?').run('\u0001'.repeat(4000), created.id);
    tasks.processDue(plus(created.nextFireAt ?? '', 1000));
    expect(firings(store, created.id)).toEqual([]);
    expect(taskRows(store)).toEqual([]);
    expect(recurring.get(created.id)).toMatchObject({ enabled: true, nextFireAt: null });
    expect(tasks.nextDeadline()).toBeUndefined();
  });

  test('retention prunes old firings, keeps definitions and keeps an undelivered firing (F14)', async () => {
    const { recurring, tasks, store, config } = await setup();
    const created = recurring.create(1n, draft(), 'admin', minuteNow());
    tasks.processDue(plus(created.nextFireAt ?? '', 1000));
    const second = recurring.get(created.id)?.nextFireAt ?? '';
    tasks.processDue(plus(second, 1000));
    expect(firings(store, created.id).map((row) => row.skip_reason)).toEqual([null, 'previous_pending']);
    store.db.prepare("UPDATE recurring_alarm_firings SET created_at = '2000-01-01T00:00:00.000Z'").run();
    purgeExpiredData(store.orm, config);
    // The pending delivery's firing stays; the skipped one is gone.
    expect(firings(store, created.id)).toEqual([expect.objectContaining({ outcome: 'scheduled' })]);
    store.db.prepare("UPDATE task_receipts SET state = 'handled', updated_at = '2000-01-01T00:00:00.000Z'").run();
    store.db.prepare("UPDATE long_tasks SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    purgeExpiredData(store.orm, config);
    expect(firings(store, created.id)).toEqual([]);
    expect(taskRows(store)).toEqual([]);
    expect(recurring.get(created.id)?.enabled).toBe(true);
  });
});

describe('recurring alarm run now (F15)', () => {
  test('runs the saved definition once, outside the schedule, and refuses to pile up', async () => {
    const { recurring, tasks, store } = await setup();
    const now = minuteNow();
    const created = recurring.create(1n, draft({ enabled: false }), 'admin', now);
    const at = plus(now, 1234);
    const run = recurring.runNow(created.id, 'api-key:7', at);
    expect(run.occurrenceAt).toBe(at.toISOString());
    expect(recurring.get(created.id)).toMatchObject({ enabled: false, nextFireAt: null, revision: 1n });
    expect(firings(store, created.id)).toEqual([
      {
        source: 'manual',
        occurrence_at: at.toISOString(),
        outcome: 'scheduled',
        skip_reason: null,
        coalesced: 0n,
        task_id: run.taskId,
        triggered_by: 'api-key:7',
      },
    ]);
    expect(() => recurring.runNow(created.id, 'admin', at)).toThrow(
      expect.objectContaining({ code: 'previous_pending' }),
    );
    tasks.processDue(at);
    expect(taskRows(store)).toEqual([
      expect.objectContaining({ state: 'completed', scheduled_at: at.toISOString(), receipt_state: 'pending' }),
    ]);
    expect(JSON.parse(taskRows(store)[0]?.payload_json ?? '{}')).toMatchObject({ source: 'manual', coalesced: 0 });

    // A scheduled occurrence that comes due while the manual run is undelivered is skipped.
    const enabled = recurring.update(created.id, 1n, draft(), 'admin', at);
    tasks.processDue(plus(enabled.nextFireAt ?? '', 1000));
    expect(firings(store, created.id).at(-1)).toMatchObject({ source: 'schedule', skip_reason: 'previous_pending' });

    store.db.prepare("UPDATE task_receipts SET state = 'handled'").run();
    store.db.prepare("INSERT INTO chat_pause(chat_id, paused_at) VALUES (1, '2020-01-01T00:00:00.000Z')").run();
    expect(() => recurring.runNow(created.id, 'admin', at)).toThrow(
      expect.objectContaining({ code: 'target_unavailable' }),
    );
    expect(firings(store, created.id)).toHaveLength(2);
    expect(() => recurring.runNow(999n, 'admin', at)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
