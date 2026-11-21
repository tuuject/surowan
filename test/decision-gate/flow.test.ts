import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FixtureConfig } from '../helpers.ts';
import {
  answer,
  attempt,
  bucketRow,
  conversationIdOf,
  decisionRows,
  gate,
  gateEvents,
  groupMessage,
  invocationBucketRows,
  invocationCount,
  resetHarness,
  seedRunningInvocation,
  settle,
  setup,
  START,
  until,
  WINDOW_MS,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

describe('decision gate flow', () => {
  test('the gate is off by default: no request and no decision row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup();
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(result.invocations).toHaveLength(1);
      expect(harness.decisions.calls).toHaveLength(0);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(bucketRow(harness.store, result.bucketId ?? 0n)).toMatchObject({ state: 'queued' });
    } finally {
      harness.store.close();
    }
  });

  test('shadow records the verdict and leaves the batch transitions untouched', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'shadow', { threshold: 0.9 }) });
    harness.decisions.responder = () => answer(0.1);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      // The verdict is below the threshold, yet the batch is queued in this pass.
      expect(result.invocations).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(1);
      await settle(harness);
      expect(harness.decisions.calls).toHaveLength(1);
      expect(decisionRows(harness.store)).toMatchObject([
        { mode: 'shadow', state: 'success', outcome: 'drop', applied: 0n, probability: 0.1 },
      ]);
      expect(bucketRow(harness.store, result.bucketId ?? 0n)).toMatchObject({ state: 'queued', error_code: null });
    } finally {
      harness.store.close();
    }
  });

  test('enforce holds an entering batch for one more pass, then queues it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.9);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      const bucketId = result.bucketId ?? 0n;
      expect(result.invocations).toEqual([]);
      expect(invocationCount(harness.store)).toBe(0);
      // Phase 1 keeps the batch collecting and pushes its deadline past the budget.
      const held = bucketRow(harness.store, bucketId);
      expect(held.state).toBe('collecting');
      expect(Date.parse(held.deadline_at)).toBeGreaterThan(START.getTime() + 15_000);
      await settle(harness);
      const row = decisionRows(harness.store, bucketId)[0];
      expect(row).toMatchObject({
        bucket_id: bucketId,
        mode: 'enforce',
        model: 'typesafe/jev-1.14',
        state: 'success',
        outcome: 'enter',
        applied: 1n,
        probability: 0.9,
        threshold: 0.57,
        history_count: 0n,
        pending_count: 1n,
        input_tokens: 21n,
        cost: null,
        error_code: null,
        error_detail: null,
      });
      expect(row?.finished_at).not.toBeNull();
      expect(row?.created_at).not.toBe('');
      expect(row?.duration_ms).not.toBeNull();
      // Released: the batch is still collecting, due now.
      expect(bucketRow(harness.store, bucketId).state).toBe('collecting');
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(1);
      // The release mark is gone and no second request went out.
      expect(harness.decisions.calls).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test('enforce drops a below-threshold batch with decision_gate_dropped and keeps its messages', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.2);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      const bucketId = result.bucketId ?? 0n;
      expect(result.invocations).toEqual([]);
      await settle(harness);
      expect(decisionRows(harness.store, bucketId)).toMatchObject([{ state: 'success', outcome: 'drop', applied: 1n }]);
      expect(bucketRow(harness.store, bucketId)).toMatchObject({
        state: 'skipped_budget',
        error_code: 'decision_gate_dropped',
      });
      expect(harness.scheduler.processDue(new Date())).toEqual([]);
      expect(invocationCount(harness.store)).toBe(0);
      expect(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
      ).toBe(1n);
      expect(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count,
      ).toBe(1n);
    } finally {
      harness.store.close();
    }
  });

  test('the threshold is inclusive', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce', { threshold: 0.57 }) });
    harness.decisions.responder = () => answer(0.57);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(decisionRows(harness.store, result.bucketId ?? 0n)).toMatchObject([
        { state: 'success', outcome: 'enter', applied: 1n },
      ]);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test('one structured log line per decision, without message text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.2);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      const events = gateEvents(log);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        chat_id: '-1001234567890',
        conversation_id: '1',
        bucket_id: (result.bucketId ?? 0n).toString(),
        mode: 'enforce',
        model: 'typesafe/jev-1.14',
        state: 'success',
        outcome: 'drop',
        applied: true,
        threshold: 0.57,
        history_count: 0,
        pending_count: 1,
      });
      expect(JSON.stringify(events[0])).not.toContain('message 10');
    } finally {
      harness.store.close();
    }
  });
});

describe('decision gate on the attach path', () => {
  test('an entering batch is attached to the running invocation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.9);
    try {
      const result = harness.ingestion.ingest(groupMessage(1, 10), START);
      seedRunningInvocation(harness.store, conversationIdOf(harness.store));
      const bucketId = result.bucketId ?? 0n;
      // Held on the attach path: no `invocation_buckets` row while the verdict is pending.
      expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toEqual([]);
      await until(() => harness.decisions.calls.length === 1, 'the decision request');
      expect(invocationBucketRows(harness.store)).toEqual([]);
      await settle(harness);
      expect(invocationBucketRows(harness.store)).toEqual([]);
      expect(bucketRow(harness.store, bucketId).state).toBe('collecting');
      expect(harness.scheduler.processDue(new Date())).toEqual([]);
      expect(invocationBucketRows(harness.store)).toEqual([{ invocation_id: 900n, bucket_id: bucketId }]);
      expect(harness.decisions.calls).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test('a dropped batch is never attached', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.1);
    try {
      const result = harness.ingestion.ingest(groupMessage(1, 10), START);
      seedRunningInvocation(harness.store, conversationIdOf(harness.store));
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await settle(harness);
      expect(bucketRow(harness.store, result.bucketId ?? 0n)).toMatchObject({
        state: 'skipped_budget',
        error_code: 'decision_gate_dropped',
      });
      expect(invocationBucketRows(harness.store)).toEqual([]);
    } finally {
      harness.store.close();
    }
  });
});

describe('a released batch and a running round', () => {
  test('a postponed released batch is not decided again and enters when the round ends', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = () => answer(0.9);
    try {
      const first = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(decisionRows(harness.store, first.bucketId ?? 0n)).toMatchObject([{ applied: 1n }]);

      const conversationId = conversationIdOf(harness.store);
      seedRunningInvocation(harness.store, conversationId);
      harness.attachment.beginRound(conversationId);
      // The round owns the Conversation: the released batch is deferred, not decided.
      harness.scheduler.processDue(new Date());
      expect(harness.decisions.calls).toHaveLength(1);
      expect(bucketRow(harness.store, first.bucketId ?? 0n).state).toBe('collecting');

      harness.attachment.endRound(conversationId);
      harness.scheduler.processDue(new Date(Date.now() + 16_000));
      expect(harness.decisions.calls).toHaveLength(1);
      expect(invocationBucketRows(harness.store)).toEqual([{ invocation_id: 900n, bucket_id: first.bucketId ?? 0n }]);
    } finally {
      harness.store.close();
    }
  });
});

describe('proactive reply sampling and the gate', () => {
  function sampling(baseProbability: number) {
    return (config: FixtureConfig): void => {
      config.telegram.proactive_reply = {
        enabled: true,
        base_probability: baseProbability,
        increment: 0,
        hard_pity: 100,
      };
    };
  }

  test('enforce retires sampling for the Chat and never touches the pity counter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: sampling(0),
      random: () => 0.99,
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(harness.random).not.toHaveBeenCalled();
      expect(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM proactive_reply_state').get()
          ?.count,
      ).toBe(0n);
      expect(decisionRows(harness.store, result.bucketId ?? 0n)).toHaveLength(1);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  test('shadow keeps sampling ahead of the gate, so a sampled-out batch is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'shadow'),
      transform: sampling(0),
      random: () => 0.99,
    });
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      await settle(harness);
      expect(harness.random).toHaveBeenCalledTimes(1);
      expect(bucketRow(harness.store, result.bucketId ?? 0n)).toMatchObject({
        state: 'skipped_budget',
        error_code: 'proactive_reply_skipped',
      });
      expect(decisionRows(harness.store)).toEqual([]);
      expect(harness.decisions.calls).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  test('shadow decides a batch that sampling admitted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'shadow'),
      transform: sampling(0.5),
      random: () => 0.25,
    });
    harness.decisions.responder = () => answer(0.1);
    try {
      const result = attempt(harness, groupMessage(1, 10), START);
      expect(result.invocations).toHaveLength(1);
      await settle(harness);
      expect(decisionRows(harness.store, result.bucketId ?? 0n)).toMatchObject([{ applied: 0n }]);
    } finally {
      harness.store.close();
    }
  });
});
