import { describe, expect, test } from 'vitest';
import { openDatabase } from '../../scripts/audit/database.ts';
import { renderInvocation } from '../../scripts/audit/invocation.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { LoadedConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { openTestStore, seedTelegramConversation } from '../im/fixtures.ts';

/**
 * The audit script is the only way to read a verdict after the fact, so its
 * wording has to match the row: a `shadow` drop never withheld anything, a
 * `stale` verdict was discarded, and an `interrupted` row is not a failure that
 * admitted a batch. Decisions of every Bucket an Invocation consumed belong to
 * it too, not only the opening one.
 */

const TIMESTAMP = '2025-01-01T00:00:00.000Z';
const INVOCATION = 900;
const OPENING_BUCKET = 900;
const ATTACHED_BUCKET = 901;

function seedBucket(store: SqliteStore, conversationId: bigint, id: number): void {
  store.db
    .prepare(
      `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?)`,
    )
    .run(id, conversationId, TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP);
}

function seedInvocation(store: SqliteStore, conversationId: bigint, bucketId: number): void {
  store.db
    .prepare(
      `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
       VALUES (?, ?, ?, 'completed', 'h', 1, ?)`,
    )
    .run(INVOCATION, bucketId, conversationId, TIMESTAMP);
}

interface DecisionSeed {
  readonly bucketId: number;
  readonly mode: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly applied: number;
  readonly errorCode?: string;
}

function seedDecision(store: SqliteStore, conversationId: bigint, seed: DecisionSeed): void {
  store.db
    .prepare(
      `INSERT INTO bucket_decisions
         (bucket_id, conversation_id, mode, model, state, outcome, applied, threshold,
          history_count, pending_count, error_code, created_at, finished_at)
       VALUES (?, ?, ?, 'typesafe/jev-1.14', ?, ?, ?, 0.57, 0, 1, ?, ?, ?)`,
    )
    .run(
      seed.bucketId,
      conversationId,
      seed.mode,
      seed.state,
      seed.outcome,
      seed.applied,
      seed.errorCode ?? null,
      TIMESTAMP,
      TIMESTAMP,
    );
}

async function fixture(): Promise<{ store: SqliteStore; loaded: LoadedConfig; conversationId: bigint }> {
  const { store, loaded } = await openTestStore();
  const { conversationId } = seedTelegramConversation(store);
  seedBucket(store, conversationId, OPENING_BUCKET);
  seedBucket(store, conversationId, ATTACHED_BUCKET);
  seedInvocation(store, conversationId, OPENING_BUCKET);
  store.db
    .prepare('INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at, injected_at) VALUES (?, ?, ?, ?)')
    .run(INVOCATION, ATTACHED_BUCKET, TIMESTAMP, TIMESTAMP);
  seedDecision(store, conversationId, {
    bucketId: OPENING_BUCKET,
    mode: 'shadow',
    state: 'success',
    outcome: 'drop',
    applied: 0,
  });
  seedDecision(store, conversationId, {
    bucketId: ATTACHED_BUCKET,
    mode: 'enforce',
    state: 'stale',
    outcome: 'drop',
    applied: 0,
  });
  seedDecision(store, conversationId, {
    bucketId: OPENING_BUCKET,
    mode: 'enforce',
    state: 'error',
    outcome: 'enter',
    applied: 1,
    errorCode: 'secret_unresolved',
  });
  seedDecision(store, conversationId, {
    bucketId: OPENING_BUCKET,
    mode: 'enforce',
    state: 'error',
    outcome: null,
    applied: 0,
    errorCode: 'interrupted',
  });
  return { store, loaded, conversationId };
}

describe('the audit script on entry-gate rows', () => {
  test('describes shadow drops, discarded verdicts and interruptions for what they are', async () => {
    const { loaded } = await fixture();
    const database = openDatabase(loaded.config.paths.database);
    try {
      const text = renderInvocation(database, INVOCATION, false);
      // Every Bucket of the Invocation, not only the opening one.
      expect(text).toContain('入场闸门决策 (4)');
      expect(text).toContain(`bucket=${ATTACHED_BUCKET}`);
      const lines = text.split('\n');
      const shadow = lines.find((line) => line.includes('shadow 模式'));
      expect(shadow).toContain('1');
      expect(shadow).toContain('抛弃');
      expect(lines.find((line) => line.includes('作废'))).toContain('1');
      const interrupted = lines.find((line) => line.includes('interrupted'));
      expect(interrupted).toContain('1');
      // The interrupted row is not counted as a failure that admitted a batch.
      const failed = lines.find((line) => line.includes('失败一律送入'));
      expect(failed).toContain('secret_unresolved');
      expect(failed).not.toContain('interrupted');
      // The part-2 wording claimed every unapplied drop grew during the decision.
      expect(text).not.toContain('批次在决策期间增长了');
    } finally {
      database.close();
    }
  });

  test('the JSON view carries the same rows', async () => {
    const { loaded } = await fixture();
    const database = openDatabase(loaded.config.paths.database);
    try {
      const parsed = JSON.parse(renderInvocation(database, INVOCATION, true)) as {
        decisions: { bucket_id: number; mode: string; state: string; error_code: string | null }[];
      };
      expect(parsed.decisions.map((row) => row.bucket_id)).toEqual([
        OPENING_BUCKET,
        ATTACHED_BUCKET,
        OPENING_BUCKET,
        OPENING_BUCKET,
      ]);
      expect(parsed.decisions[1]).toMatchObject({ mode: 'enforce', state: 'stale' });
    } finally {
      database.close();
    }
  });
});
