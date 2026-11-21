import { afterEach, describe, expect, test, vi } from 'vitest';
import { DecisionGate, type DecisionGateBot } from '../../src/orchestration/decision-gate/index.ts';
import type { FixtureConfig } from '../helpers.ts';
import {
  answer,
  bucketRow,
  conversationIdOf,
  decisionRows,
  gate,
  gateEvents,
  GROUP_A,
  GROUP_B,
  groupMessage,
  invocationCount,
  resetHarness,
  settle,
  setup,
  START,
  until,
  WINDOW_MS,
  type Harness,
} from './fixtures.ts';

/**
 * Phase 1 must never take scheduling down. Everything that can throw — reading
 * the batch, rendering the request, writing the row, pushing the deadline —
 * either fails open into the ordinary path or is rolled back with the due
 * transaction; in both cases no in-memory reservation may survive, so the rest
 * of the pass, the scheduler loop and the next decision still work.
 */

afterEach(async () => {
  await resetHarness();
});

const CHAT_C = -1_001_234_567_892;

/** Three configured Chats, so one failure and two later decisions stay independent. */
function threeChats(config: FixtureConfig): void {
  config.telegram.chats = [GROUP_A, GROUP_B, CHAT_C].map((id) => ({ id, instructions_file: 'chat-instructions.md' }));
}

const DIRECT_BOT: DecisionGateBot = { id: 999n, displayName: 'direct', username: 'direct' };

/** The fixture's gate over its own store, so `begin` can be driven directly. */
function directGate(harness: Harness, bot: DecisionGateBot = DIRECT_BOT): DecisionGate {
  return new DecisionGate(harness.store, harness.configStore, {
    bot,
    secrets: harness.secrets,
    wake: () => undefined,
  });
}

function candidate(harness: Harness, bucketId: bigint, now = new Date(START.getTime() + WINDOW_MS)) {
  return {
    bucketId,
    conversationId: conversationIdOf(harness.store),
    bucketKind: 'realtime',
    hostChatId: BigInt(GROUP_A),
    hostKind: 'telegram' as const,
    chatType: 'supergroup',
    chat: {},
    keywords: [],
    now,
  };
}

describe('a phase-1 failure before the decision row', () => {
  test('the batch enters, the row is absent and no reservation survives', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The identity getters are read before the insert; throwing once fails
    // exactly one batch and leaves the next one a working identity. `leak` is a
    // known secret by the time the getter runs, so the logged detail must be
    // redacted.
    let failures = 1;
    let leak = '';
    const bot = {
      id: 999n,
      get displayName(): string {
        if (failures > 0) {
          failures -= 1;
          throw new Error(`the connection identity is unavailable: ${leak}`);
        }
        return 'direct';
      },
      username: 'direct',
    };
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      bot,
      maxConcurrent: 1,
      transform: threeChats,
    });
    leak = 'known-decision-gate-secret';
    harness.secrets.remember(leak);
    harness.decisions.responder = () => answer(0.9);
    try {
      const a = harness.ingestion.ingest(groupMessage(1, 10), START);
      const b = harness.ingestion.ingest(
        groupMessage(2, 11, { chat: { id: GROUP_B, type: 'supergroup', title: 'Group B' } }),
        START,
      );
      const due = harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      // The failing batch took the ordinary path in this very pass…
      expect(due).toHaveLength(1);
      expect(bucketRow(harness.store, a.bucketId ?? 0n).state).toBe('queued');
      expect(decisionRows(harness.store, a.bucketId ?? 0n)).toEqual([]);
      // …and the other due Bucket of the same pass still got its decision. With
      // one slot, a leaked reservation would have admitted it instead.
      expect(bucketRow(harness.store, b.bucketId ?? 0n).state).toBe('collecting');
      expect(decisionRows(harness.store, b.bucketId ?? 0n)).toMatchObject([{ state: 'pending' }]);
      await until(() => harness.decisions.calls.length === 1, 'the surviving decision request');
      const failed = gateEvents(log).filter((event) => event.error_code === 'internal_error');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        bucket_id: (a.bucketId ?? 0n).toString(),
        decision_id: null,
        state: 'error',
        outcome: 'enter',
        applied: false,
        mode: 'enforce',
      });
      expect(JSON.stringify(failed)).toContain('[REDACTED]');
      expect(JSON.stringify(failed)).not.toContain(leak);

      await settle(harness);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      // A later batch still gets the single slot: nothing leaked.
      harness.ingestion.ingest(
        groupMessage(3, 12, { chat: { id: CHAT_C, type: 'supergroup', title: 'Group C' } }),
        START,
      );
      harness.scheduler.processDue(new Date());
      await until(() => harness.decisions.calls.length === 2, 'the next decision request');
      // A leaked slot would have answered `concurrency_limit` instead of asking.
      expect(decisionRows(harness.store).filter((row) => row.error_code === 'concurrency_limit')).toEqual([]);
    } finally {
      harness.store.close();
    }
  });

  test('the scheduler loop keeps running after the failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let failures = 1;
    const bot = {
      id: 999n,
      get displayName(): string {
        if (failures > 0) {
          failures -= 1;
          throw new Error('injected');
        }
        return 'direct';
      },
      username: 'direct',
    };
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      bot,
      transform: (config) => {
        config.telegram.bucket_window_seconds = 0;
      },
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      harness.scheduler.start();
      harness.ingestion.ingest(groupMessage(1, 10), new Date());
      harness.scheduler.wake();
      await until(() => invocationCount(harness.store) === 1, 'the batch that failed open');
      // The loop survived the throw; the next batch is decided normally.
      harness.ingestion.ingest(groupMessage(2, 11), new Date(Date.now() + 1));
      harness.scheduler.wake();
      await until(
        () => decisionRows(harness.store).some((row) => row.state !== 'pending'),
        'the next decision verdict',
      );
      expect(harness.decisions.calls).toHaveLength(1);
      expect(decisionRows(harness.store)).toHaveLength(1);
    } finally {
      await harness.scheduler.stop(1_000);
      harness.store.close();
    }
  });
});

describe('a phase-1 failure after the decision row', () => {
  test('the row closes as internal_error and the batch enters', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce'), twoGroups: true, maxConcurrent: 1 });
    harness.decisions.responder = () => answer(0.9);
    try {
      const a = harness.ingestion.ingest(groupMessage(1, 10), START);
      const b = harness.ingestion.ingest(
        groupMessage(2, 11, { chat: { id: GROUP_B, type: 'supergroup', title: 'Group B' } }),
        START,
      );
      // A real failure inside the transaction: the deadline push of one batch
      // aborts, the transaction stays usable and the other batch is decided.
      harness.store.db.exec(
        `CREATE TRIGGER inject_failure BEFORE UPDATE OF deadline_at ON buckets
         WHEN NEW.id = ${Number(a.bucketId ?? 0n)} AND NEW.deadline_at > OLD.deadline_at
         BEGIN SELECT RAISE(ABORT, 'injected deadline failure'); END`,
      );
      try {
        const due = harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
        expect(due).toHaveLength(1);
      } finally {
        harness.store.db.exec('DROP TRIGGER inject_failure');
      }
      expect(bucketRow(harness.store, a.bucketId ?? 0n).state).toBe('queued');
      expect(decisionRows(harness.store, a.bucketId ?? 0n)).toMatchObject([
        { state: 'error', outcome: 'enter', applied: 1n, error_code: 'internal_error' },
      ]);
      expect(decisionRows(harness.store, a.bucketId ?? 0n)[0]?.finished_at).not.toBeNull();
      expect(bucketRow(harness.store, b.bucketId ?? 0n).state).toBe('collecting');
      expect(gateEvents(log)).toMatchObject([
        { bucket_id: (a.bucketId ?? 0n).toString(), state: 'error', error_code: 'internal_error' },
      ]);
      await settle(harness);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(2);
    } finally {
      harness.store.close();
    }
  });

  test('a direct begin() leaves no deciding mark and no leaked slot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce'), maxConcurrent: 1, twoGroups: true });
    harness.decisions.responder = () => answer(0.9);
    const first = harness.ingestion.ingest(groupMessage(1, 10), START);
    const bucketId = first.bucketId ?? 0n;
    const gateUnderTest = directGate(harness);
    try {
      harness.store.db.exec(
        `CREATE TRIGGER inject_failure BEFORE UPDATE OF deadline_at ON buckets
         WHEN NEW.id = ${Number(bucketId)} AND NEW.deadline_at > OLD.deadline_at
         BEGIN SELECT RAISE(ABORT, 'injected deadline failure'); END`,
      );
      let begun: unknown;
      harness.store.transaction(() => {
        begun = gateUnderTest.begin(candidate(harness, bucketId));
      });
      harness.store.db.exec('DROP TRIGGER inject_failure');
      expect(begun).toBeUndefined();
      expect(gateUnderTest.isDeciding(bucketId)).toBe(false);
      expect(decisionRows(harness.store, bucketId)).toMatchObject([{ state: 'error', error_code: 'internal_error' }]);

      // The single slot is free: the same batch can be decided again.
      const retry = harness.store.transaction(() => gateUnderTest.begin(candidate(harness, bucketId)));
      expect(retry).toMatchObject({ held: true, token: { plan: { kind: 'request' } } });
      expect(gateUnderTest.isDeciding(bucketId)).toBe(true);
      if (retry?.token !== undefined) {
        gateUnderTest.abandon([retry.token]);
      }
      expect(gateUnderTest.isDeciding(bucketId)).toBe(false);
    } finally {
      harness.store.close();
    }
  });
});
