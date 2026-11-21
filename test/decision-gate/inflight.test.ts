import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  answer,
  bucketRow,
  decisionRows,
  gate,
  groupMessage,
  invocationCount,
  resetHarness,
  settle,
  setup,
  START,
  until,
  WINDOW_MS,
} from './fixtures.ts';

/**
 * The window between phase 1 and the verdict: the batch can grow, a message can
 * be edited, and the pushed deadline can run out without the request having
 * answered. Each shape has to leave the Bucket and the loop in a sane state.
 */

afterEach(async () => {
  await resetHarness();
});

function deferred() {
  const slots: ((response: Response) => void)[] = [];
  return {
    responder: (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        slots.push(resolve);
      }),
    release: (response: Response): void => {
      const next = slots.shift();
      if (next === undefined) {
        throw new Error('No decision request is waiting');
      }
      next(response);
    },
    pending: (): number => slots.length,
  };
}

describe('the fingerprint', () => {
  test('an edit of a pending message discards the drop and decides again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10, { text: 'original words' }), START);
      const bucketId = first.bucketId ?? 0n;
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      // An edit stores a new current revision without touching bucket_messages.
      const edited = groupMessage(2, 10, { text: 'edited words', edit_date: 1_700_000_020 });
      harness.ingestion.ingest({ update_id: 2, edited_message: edited.message } as never, START);
      expect(
        harness.store.db
          .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages WHERE bucket_id = ?')
          .get(bucketId)?.count,
      ).toBe(1n);
      held.release(answer(0.1));
      await until(
        () => decisionRows(harness.store, bucketId).some((row) => row.state !== 'pending'),
        'the first verdict',
      );
      // The verdict described the old revision: it is discarded, not applied.
      expect(decisionRows(harness.store, bucketId)).toMatchObject([{ state: 'stale', outcome: 'drop', applied: 0n }]);
      expect(bucketRow(harness.store, bucketId).state).toBe('collecting');
      expect(bucketRow(harness.store, bucketId).error_code).toBeNull();

      // The next pass decides the edited batch again and enters.
      harness.decisions.responder = () => answer(0.9);
      harness.scheduler.processDue(new Date());
      await settle(harness);
      expect(decisionRows(harness.store, bucketId)).toMatchObject([
        { state: 'stale', applied: 0n },
        { state: 'success', outcome: 'enter', applied: 1n },
      ]);
      expect(harness.decisions.calls).toHaveLength(2);
      expect(harness.scheduler.processDue(new Date())).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(1);
      // The model sees the edited revision.
      expect(
        harness.store.db
          .prepare<[], { snapshot_json: string }>("SELECT snapshot_json FROM invocation_messages WHERE section = 'new'")
          .get()?.snapshot_json,
      ).toContain('edited words');
    } finally {
      harness.store.close();
    }
  });
});

describe('a deciding batch with an already passed deadline', () => {
  test('the pass pushes it out instead of leaving the loop at zero', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      const bucketId = first.bucketId ?? 0n;
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      // A slow event loop outlived the pushed deadline.
      const past = new Date(Date.now() - 60_000).toISOString();
      harness.store.db.prepare('UPDATE buckets SET deadline_at = ? WHERE id = ?').run(past, bucketId);
      // The skipped batch must not keep the loop at zero while the request runs.
      harness.scheduler.processDue(new Date());
      expect(harness.scheduler.nextDelayMilliseconds()).toBeGreaterThan(0);
      expect(harness.decisions.calls).toHaveLength(1);
      // Phase 2 makes it due again as soon as the verdict lands.
      held.release(answer(0.9));
      await settle(harness);
      harness.scheduler.processDue(new Date());
      expect(harness.decisions.calls).toHaveLength(1);
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });

  test('processDue makes the skipped batch due again for the verdict', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    const held = deferred();
    harness.decisions.responder = held.responder;
    try {
      const first = harness.ingestion.ingest(groupMessage(1, 10), START);
      const bucketId = first.bucketId ?? 0n;
      harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
      await until(() => held.pending() === 1, 'the request');
      const past = new Date(Date.now() - 60_000).toISOString();
      harness.store.db.prepare('UPDATE buckets SET deadline_at = ? WHERE id = ?').run(past, bucketId);
      harness.scheduler.processDue(new Date());
      expect(Date.parse(bucketRow(harness.store, bucketId).deadline_at)).toBeGreaterThan(Date.now() - 1_000);
      held.release(answer(0.1));
      await settle(harness);
      expect(decisionRows(harness.store, bucketId)).toMatchObject([{ outcome: 'drop', applied: 1n }]);
      expect(bucketRow(harness.store, bucketId).state).toBe('skipped_budget');
    } finally {
      harness.store.close();
    }
  });
});
