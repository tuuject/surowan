import { afterAll, describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import { AGENT_PROMPT_VERSION } from '../src/platform/agent-protocol.ts';
import { cleanupSchedulerDirectories, setup, textUpdate } from './scheduler-fixtures.ts';

afterAll(cleanupSchedulerDirectories);

describe('bucket scheduler', () => {
  test('freezes the latest revision at the fixed deadline', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), start);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_010,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 5_000));
    expect(scheduler.processDue(new Date(start.getTime() + 5_999))).toHaveLength(0);
    expect(scheduler.processDue(new Date(start.getTime() + 6_000))).toHaveLength(1);
    const snapshot = store.db
      .prepare<[], { snapshot_json: string }>("SELECT snapshot_json FROM invocation_messages WHERE section = 'new'")
      .get();
    expect(snapshot === undefined ? null : JSON.parse(snapshot.snapshot_json).text).toBe('after');
    expect(
      store.db.prepare<[], { prompt_version: bigint }>('SELECT prompt_version FROM invocations').get()?.prompt_version,
    ).toBe(AGENT_PROMPT_VERSION);
    store.close();
  });

  test('post-deadline edits affect future history without rewriting the frozen invocation', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(firstInvocation);
    store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(firstInvocation);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_020,
        date: 1_700_000_010,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(start.getTime() + 16_000));
    ingestion.ingest(textUpdate(3, 11, 'next'), new Date(start.getTime() + 20_000));
    const [secondInvocation] = scheduler.processDue(new Date(start.getTime() + 35_000));
    if (secondInvocation === undefined) {
      throw new Error('Expected second invocation');
    }
    const frozen = store.db
      .prepare<[bigint], { snapshot_json: string }>(
        "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
      )
      .get(firstInvocation);
    const future = store.db
      .prepare<[bigint], { snapshot_json: string }>(
        "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no DESC LIMIT 1",
      )
      .get(secondInvocation);
    expect(frozen === undefined ? null : JSON.parse(frozen.snapshot_json).text).toBe('before');
    expect(future === undefined ? null : JSON.parse(future.snapshot_json).text).toBe('after');
    store.close();
  });

  test('does not create another invocation without new human messages', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'only'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected invocation');
    }
    store.db
      .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(invocationId);
    store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(1n);
    store.close();
  });
});
