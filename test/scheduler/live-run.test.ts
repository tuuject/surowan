import { afterAll, describe, expect, test } from 'vitest';
import { sleep } from '../helpers.ts';
import { cleanupSchedulerDirectories, setup, textUpdate } from './fixtures.ts';

afterAll(cleanupSchedulerDirectories);

describe('bucket scheduler', () => {
  test('records a failing handler as an invocation_error instead of a bare error name', async () => {
    // Regression: the thrown error's `name` was persisted as the completion
    // reason, so a runtime fault showed up as `completion_reason = 'Error'` with
    // no code and no message anywhere in the audit trail.
    const { store, ingestion, scheduler } = await setup(
      (config) => {
        // A zero-second window lets the running scheduler open the invocation
        // itself; a pre-created one would be recovered as stale by start().
        config.telegram.bucket_window_seconds = 0;
      },
      async () => {
        throw new Error('Stored context message does not match its schema');
      },
    );
    scheduler.start();
    try {
      ingestion.ingest(textUpdate(1, 10, 'only'), new Date());
      scheduler.wake();
      const deadline = Date.now() + 10_000;
      let invocation: { id: bigint; state: string; completion_reason: string | null } | undefined;
      while (Date.now() < deadline) {
        invocation = store.db
          .prepare<[], { id: bigint; state: string; completion_reason: string | null }>(
            'SELECT id, state, completion_reason FROM invocations ORDER BY id DESC LIMIT 1',
          )
          .get();
        if (invocation !== undefined && invocation.state !== 'queued' && invocation.state !== 'running') {
          break;
        }
        await sleep(10);
      }
      if (invocation === undefined) {
        throw new Error('Expected an invocation');
      }
      // The audit row names the failure class instead of a bare "Error".
      expect({ state: invocation.state, completion_reason: invocation.completion_reason }).toEqual({
        state: 'failed',
        completion_reason: 'invocation_error',
      });
      // The bucket this run consumed fails with it instead of staying open.
      expect(
        store.db
          .prepare<[bigint], { state: string }>(
            'SELECT state FROM buckets WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)',
          )
          .get(invocation.id)?.state,
      ).toBe('failed');
    } finally {
      await scheduler.stop();
      store.close();
    }
  }, 20_000);

  test('zero-second windows consume each next bucket once without idle retrigger or same-chat reentry', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedSignal = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedSignal = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let secondFinished!: () => void;
    const secondFinishedSignal = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const started: bigint[] = [];
    let active = 0;
    let maxActive = 0;
    const { store, ingestion, scheduler } = await setup(
      (config) => {
        config.telegram.bucket_window_seconds = 0;
      },
      async (invocationId) => {
        started.push(invocationId);
        if (started.length === 1) {
          firstStarted();
        }
        if (started.length === 2) {
          secondStarted();
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started.length === 1) {
          await firstGate;
        }
        active -= 1;
        if (started.length === 2) {
          secondFinished();
        }
        return { state: 'completed', reason: 'done' };
      },
    );
    try {
      scheduler.start();
      const received = new Date();
      ingestion.ingest(textUpdate(1, 10, 'first'), received);
      scheduler.wake();
      await firstStartedSignal;

      const during = ingestion.ingest(textUpdate(2, 11, 'during'), new Date());
      scheduler.processDue();
      expect(started).toHaveLength(1);
      expect(maxActive).toBe(1);
      expect(
        store.db.prepare<[], { state: string }>('SELECT state FROM buckets ORDER BY id DESC LIMIT 1').get()?.state,
      ).toBe('collecting');

      releaseFirst();
      await secondStartedSignal;
      expect(maxActive).toBe(1);
      await secondFinishedSignal;
      await scheduler.stop();
      expect(scheduler.processDue()).toHaveLength(0);
      expect(started).toHaveLength(2);
      expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(
        2n,
      );
      expect(
        store.db
          .prepare<[bigint], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocation_messages WHERE message_id = ? AND section = 'new'",
          )
          .get(during.messageId!)?.count,
      ).toBe(1n);
      expect(
        store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM buckets WHERE state IN ('collecting', 'queued', 'running')",
          )
          .get()?.count,
      ).toBe(0n);
    } finally {
      releaseFirst();
      await scheduler.stop();
      store.close();
    }
  });
});
