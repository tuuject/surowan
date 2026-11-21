import { describe, expect, test } from 'vitest';
import { bucketDecisions } from '../../src/store/schema/index.ts';
import { purgeExpiredData } from '../../src/store/store.ts';
import { openTestStore, seedTelegramConversation } from '../im/fixtures.ts';

/**
 * Migration 066 and the `bucket_decisions` rows. The table is audit, but its
 * two foreign keys carry behaviour: a deleted Bucket (and therefore the
 * retention sweep) must not leave rows behind, and the enumerated columns have
 * to be enforced by SQLite rather than only by the writer.
 */

const DAY_MS = 86_400_000;
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

function seedBucket(
  store: Awaited<ReturnType<typeof openTestStore>>['store'],
  conversationId: bigint,
  id: bigint,
  state = 'collecting',
) {
  store.db
    .prepare(
      `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, 'realtime', ?, ?, ?, ?)`,
    )
    .run(id, conversationId, state, TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP);
}

function insertDecision(
  store: Awaited<ReturnType<typeof openTestStore>>['store'],
  overrides: Partial<{
    bucketId: bigint;
    conversationId: bigint;
    mode: string;
    state: string;
    outcome: string | null;
    applied: number;
  }> = {},
): void {
  store.db
    .prepare(
      `INSERT INTO bucket_decisions
         (bucket_id, conversation_id, mode, model, state, outcome, applied, threshold, created_at)
       VALUES (?, ?, ?, 'typesafe/jev-1.14', ?, ?, ?, 0.57, ?)`,
    )
    .run(
      overrides.bucketId ?? 1n,
      overrides.conversationId ?? 200n,
      overrides.mode ?? 'shadow',
      overrides.state ?? 'success',
      overrides.outcome ?? 'enter',
      overrides.applied ?? 0,
      TIMESTAMP,
    );
}

describe('migration 066', () => {
  test('applies on a fresh store and is queryable through the Drizzle table', async () => {
    const { store } = await openTestStore();
    const { conversationId } = seedTelegramConversation(store);
    seedBucket(store, conversationId, 1n);
    insertDecision(store, { conversationId });
    const rows = store.orm.select().from(bucketDecisions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucketId: 1n,
      conversationId: 200n,
      mode: 'shadow',
      state: 'success',
      outcome: 'enter',
    });
    expect(rows[0]?.applied).toBe(false);
    expect(rows[0]?.threshold).toBe(0.57);
    expect(rows[0]?.finishedAt).toBeNull();
  });

  test('rejects an unknown mode, state, outcome or non-boolean applied', async () => {
    const { store } = await openTestStore();
    const { conversationId } = seedTelegramConversation(store);
    seedBucket(store, conversationId, 1n);
    expect(() => insertDecision(store, { conversationId, mode: 'loud' })).toThrow(/CHECK constraint failed/);
    expect(() => insertDecision(store, { conversationId, state: 'done' })).toThrow(/CHECK constraint failed/);
    expect(() => insertDecision(store, { conversationId, outcome: 'maybe' })).toThrow(/CHECK constraint failed/);
    expect(() => insertDecision(store, { conversationId, applied: 2 })).toThrow(/CHECK constraint failed/);
    // A pending row has no verdict yet, so a null outcome is legal.
    insertDecision(store, { conversationId, state: 'pending', outcome: null });
    expect(store.orm.select().from(bucketDecisions).all()).toHaveLength(1);
  });

  test('deleting a Bucket cascades its decision rows', async () => {
    const { store } = await openTestStore();
    const { conversationId } = seedTelegramConversation(store);
    seedBucket(store, conversationId, 1n, 'queued');
    seedBucket(store, conversationId, 2n, 'queued');
    insertDecision(store, { conversationId, bucketId: 1n });
    insertDecision(store, { conversationId, bucketId: 2n });
    store.db.prepare('DELETE FROM buckets WHERE id = ?').run(1n);
    const rows = store.orm.select().from(bucketDecisions).all();
    expect(rows.map((row) => row.bucketId)).toEqual([2n]);
  });

  test('the online-retention sweep removes decision rows with their finished Bucket', async () => {
    const { store, config } = await openTestStore();
    const { conversationId } = seedTelegramConversation(store);
    // One time base: an expired Bucket relative to the injected clock, and one
    // still inside the window.
    const now = new Date('2026-06-01T12:00:00.000Z');
    const expired = new Date(now.getTime() - 40 * DAY_MS).toISOString();
    const recent = new Date(now.getTime() - DAY_MS).toISOString();
    for (const [id, finishedAt] of [
      [1n, expired],
      [2n, recent],
    ] as const) {
      store.db
        .prepare(
          `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, finished_at, created_at, updated_at)
           VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?, ?)`,
        )
        .run(id, conversationId, finishedAt, finishedAt, finishedAt, finishedAt, finishedAt);
      insertDecision(store, { conversationId, bucketId: id });
    }
    purgeExpiredData(store.orm, config, now);
    const remaining = store.orm.select({ bucketId: bucketDecisions.bucketId }).from(bucketDecisions).all();
    expect(remaining.map((row) => row.bucketId)).toEqual([2n]);
    expect(store.db.prepare<[], { id: bigint }>('SELECT id FROM buckets').all()).toEqual([{ id: 2n }]);
  });
});
