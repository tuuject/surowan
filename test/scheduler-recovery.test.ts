import { afterAll, describe, expect, test } from 'vitest';
import { cleanupSchedulerDirectories, setup, textUpdate } from './scheduler-fixtures.ts';

afterAll(cleanupSchedulerDirectories);

describe('bucket scheduler', () => {
  test('recovers a bucket younger than five minutes', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'recent'), start);
    const recoveredAt = new Date(start.getTime() + 4 * 60_000);
    scheduler.recover(recoveredAt);
    const [invocationId] = scheduler.processDue(recoveredAt);
    expect(invocationId).toBeDefined();
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('queued');
    store.close();
  });

  test('expires restart work older than five minutes', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'old'), start);
    scheduler.recover(new Date(start.getTime() + 5 * 60_000 + 1));
    expect(store.db.prepare<[], { state: string }>('SELECT state FROM buckets').get()?.state).toBe('expired');
    store.close();
  });

  test('queues a batch that outlived the recovery age while its round was running', async () => {
    // Regression: a batch collecting during a long round has its deadline pushed
    // one window at a time, so its first message ends up older than
    // `RECOVERY_MAX_AGE_MS`. The live age filter in `processDue` then excluded it
    // for good: the run ended without taking the batch, it stayed `collecting`,
    // and every later message of that Conversation joined the same dead batch —
    // no invocation was created for it any more (observed on invocations/1320).
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    const firstStarted = new Date(start.getTime() + 6_000);
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(firstStarted.toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(firstStarted.toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'during'), new Date(start.getTime() + 8_000));
    // The round is still running six minutes later: the batch keeps collecting.
    expect(scheduler.processDue(new Date(start.getTime() + 6 * 60_000))).toHaveLength(0);
    const finished = new Date(start.getTime() + 10 * 60_000);
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(finished.toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(finished.toISOString(), firstInvocation);
    // What the run does to a collecting batch it could not take: its deadline is
    // pushed to the run's end, which is already past.
    store.db
      .prepare("UPDATE buckets SET deadline_at = ?, updated_at = ? WHERE state = 'collecting'")
      .run(finished.toISOString(), finished.toISOString());
    const [secondInvocation] = scheduler.processDue(finished);
    expect(secondInvocation).toBeDefined();
    expect(
      store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()?.state,
    ).toBe('queued');
    expect(
      store.db
        .prepare<[bigint], { count: bigint }>(
          "SELECT COUNT(*) AS count FROM invocation_messages WHERE invocation_id = ? AND section = 'new'",
        )
        .get(secondInvocation!)?.count,
    ).toBe(1n);
    store.close();
  });
});
