import { afterAll, describe, expect, test } from 'vitest';
import { STARTUP_CATCH_UP_STATE_KEY } from '../src/orchestration/scheduler.ts';
import { sleep } from './helpers.ts';
import { ALICE, FIXED_NOW, cleanupDirectories, setup, textUpdate } from './bot-commands-fixtures.ts';

afterAll(cleanupDirectories);

describe('scheduler pause enforcement', () => {
  test("due processing skips a paused chat's collecting bucket", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    await commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    const chatId = store.db
      .prepare<[], { chat_id: bigint }>('SELECT chat_id FROM conversations LIMIT 1')
      .get()!.chat_id;
    const now = new Date(start.getTime() + 15_000).toISOString();
    store.db
      .prepare(
        "INSERT INTO buckets(conversation_id, state, first_received_at, deadline_at, created_at, updated_at) VALUES ((SELECT id FROM conversations LIMIT 1), 'collecting', ?, ?, ?, ?)",
      )
      .run(now, now, now, now);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    const bucket = store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get();
    expect(bucket?.state).toBe('collecting');
    expect(
      store.db
        .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_pause WHERE chat_id = ?')
        .get(chatId)?.count,
    ).toBe(1n);
    store.close();
  });

  test('startup catch-up skips paused chats', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    store.db
      .prepare('INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)')
      .run(STARTUP_CATCH_UP_STATE_KEY, start.toISOString(), start.toISOString());
    ingestion.ingestCatchUp(textUpdate(1, 10, 'pending'), start);
    await commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(scheduler.finishStartupCatchUp(start)).toEqual([]);
    const bucket = store.db
      .prepare<[], { state: string; error_code: string | null }>('SELECT state, error_code FROM buckets')
      .get();
    expect(bucket?.state).toBe('skipped_budget');
    expect(bucket?.error_code).toBe('chat_paused');
    store.close();
  });

  test('pauseChat aborts a running invocation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    const { store, ingestion, scheduler } = await setup(
      () => {},
      async (_id, _snapshot, signal) => {
        await gate;
        if (signal.aborted) {
          sawAbort = true;
          return { state: 'aborted', reason: 'aborted' };
        }
        return { state: 'completed', reason: 'done' };
      },
    );
    const start = new Date();
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    store.db
      .prepare('UPDATE buckets SET deadline_at = ? WHERE id = (SELECT id FROM buckets LIMIT 1)')
      .run(new Date(start.getTime() - 1_000).toISOString());
    const waitForState = async (state: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (store.db.prepare<[], { state: string }>('SELECT state FROM invocations LIMIT 1').get()?.state === state) {
          return;
        }
        await sleep(10);
      }
      throw new Error(`Invocation never reached ${state}`);
    };
    try {
      scheduler.start();
      await waitForState('running');
      const chatId = store.db
        .prepare<[], { chat_id: bigint }>('SELECT chat_id FROM conversations LIMIT 1')
        .get()!.chat_id;
      scheduler.pauseChat(chatId);
      release();
      await waitForState('aborted');
      expect(sawAbort).toBe(true);
    } finally {
      release();
      await scheduler.stop();
      store.close();
    }
  });
});
