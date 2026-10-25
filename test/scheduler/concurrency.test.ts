import { afterAll, describe, expect, test } from 'vitest';
import { cleanupSchedulerDirectories, setup, textUpdate, topicUpdate } from './fixtures.ts';

afterAll(cleanupSchedulerDirectories);

describe('bucket scheduler', () => {
  test('does not queue another invocation while the conversation is busy', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 15_000).toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 15_000).toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'during'), new Date(start.getTime() + 16_000));
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    expect(
      store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()?.state,
    ).toBe('collecting');
    store.close();
  });

  test('starts the next busy-period bucket one window after its own first message', async () => {
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
    ingestion.ingest(textUpdate(2, 11, 'next'), new Date(start.getTime() + 9_000));
    expect(scheduler.processDue(new Date(start.getTime() + 11_999))).toHaveLength(0);
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 10_000).toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 10_000).toISOString(), firstInvocation);
    // The batch is measured from its own first message, so the previous session
    // ending early does not shorten it.
    expect(scheduler.processDue(new Date(start.getTime() + 12_000))).toHaveLength(0);
    expect(scheduler.processDue(new Date(start.getTime() + 14_999))).toHaveLength(0);
    expect(scheduler.processDue(new Date(start.getTime() + 15_000))).toHaveLength(1);
    const secondDeadline = store.db
      .prepare<[], { deadline_at: string }>('SELECT deadline_at FROM buckets ORDER BY id DESC LIMIT 1')
      .get();
    expect(secondDeadline?.deadline_at).toBe('2026-08-15T00:00:15.000Z');
    store.close();
  });

  test('waits for a slow session to finish before queueing the next bucket', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    const [firstInvocation] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstInvocation === undefined) {
      throw new Error('Expected first invocation');
    }
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 6_000).toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 6_000).toISOString(), firstInvocation);
    ingestion.ingest(textUpdate(2, 11, 'during'), new Date(start.getTime() + 8_000));
    expect(scheduler.processDue(new Date(start.getTime() + 20_000))).toHaveLength(0);
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 20_000).toISOString(), firstInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 20_000).toISOString(), firstInvocation);
    expect(scheduler.processDue(new Date(start.getTime() + 20_000))).toHaveLength(1);
    store.close();
  });

  test('serializes agent sessions across forum topics of the same chat', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(topicUpdate(1, 10, 100, 'topic-a'), start);
    ingestion.ingest(topicUpdate(2, 11, 200, 'topic-b'), new Date(start.getTime() + 1_000));
    const [firstId] = scheduler.processDue(new Date(start.getTime() + 6_000));
    if (firstId === undefined) {
      throw new Error('Expected first invocation');
    }
    const firstStarted = new Date(start.getTime() + 6_000);
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(firstStarted.toISOString(), firstId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'running', started_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(firstStarted.toISOString(), firstId);
    // the second topic's bucket is due, but the chat session is still busy
    expect(scheduler.processDue(new Date(start.getTime() + 7_000))).toHaveLength(0);
    // finish the first session; its completion pushes every collecting bucket of the chat to the pace
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(start.getTime() + 6_500).toISOString(), firstId);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date(start.getTime() + 6_500).toISOString(), firstId);
    const chatId = store.db
      .prepare<[], { chat_id: bigint }>('SELECT chat_id FROM conversations LIMIT 1')
      .get()!.chat_id;
    store.db
      .prepare(
        `UPDATE buckets SET deadline_at = ?, updated_at = ?
         WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ?) AND state = 'collecting'`,
      )
      .run(new Date(start.getTime() + 12_000).toISOString(), new Date(start.getTime() + 6_500).toISOString(), chatId);
    expect(scheduler.processDue(new Date(start.getTime() + 11_999))).toHaveLength(0);
    const [secondId] = scheduler.processDue(new Date(start.getTime() + 12_000));
    expect(secondId).toBeDefined();
    const secondBucket = store.db
      .prepare<[bigint], { conversation_id: bigint; thread_id: bigint }>(
        `SELECT b.conversation_id, v.message_thread_id AS thread_id FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.id = (SELECT bucket_id FROM invocations WHERE id = ?)`,
      )
      .get(secondId!);
    expect(secondBucket?.thread_id).toBe(200n);
    store.close();
  });

  test('runs agent sessions of different chats concurrently', async () => {
    const { store, ingestion, scheduler } = await setup((config) => {
      config.telegram.chats.push({ id: 987654321 });
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'chat-a', 123456789), start);
    ingestion.ingest(textUpdate(2, 11, 'chat-b', 987654321), start);
    const invocations = scheduler.processDue(new Date(start.getTime() + 15_000));
    expect(invocations).toHaveLength(2);
    store.close();
  });
});
