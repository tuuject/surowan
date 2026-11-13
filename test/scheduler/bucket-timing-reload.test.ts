/**
 * Bucket timing is hot: a reload reaches the next batch, never one that is
 * already collecting. Each case pins one way the live configuration could leak
 * into an open batch — the message bump, the ceiling, the mid-round deferral
 * and the run-end re-anchor — and checks the stored deadline, not a log line.
 */
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { BucketAttachmentTarget } from '../../src/orchestration/invocation-queue/index.ts';
import type { InvocationOutcome } from '../../src/orchestration/scheduler/index.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import type { FixtureConfig } from '../helpers.ts';
import { cleanupSchedulerDirectories, setup, textUpdate } from './fixtures.ts';

afterAll(cleanupSchedulerDirectories);
afterEach(() => {
  vi.useRealTimers();
});

const T0 = new Date('2026-08-15T00:00:00.000Z').getTime();
const at = (seconds: number): Date => new Date(T0 + seconds * 1_000);

interface Timing {
  readonly window: number;
  readonly max: number;
  readonly bump: number;
}

function initial(timing: Timing): (config: FixtureConfig) => void {
  return (config) => {
    config.telegram.bucket_window_seconds = timing.window;
    config.telegram.bucket_max_seconds = timing.max;
    config.telegram.bucket_bump_seconds = timing.bump;
  };
}

/** What a hot reload of the three fields publishes; the rest of the configuration is untouched. */
function reload(configStore: RuntimeConfigurationStore, timing: Timing): void {
  const { generation: _generation, ...current } = configStore.current();
  configStore.publish({
    ...current,
    config: {
      ...current.config,
      telegram: {
        ...current.config.telegram,
        bucket_window_seconds: timing.window,
        bucket_max_seconds: timing.max,
        bucket_bump_seconds: timing.bump,
      },
    },
  });
}

interface BucketTimingRow {
  readonly deadline_at: string;
  readonly window_seconds: bigint;
  readonly max_seconds: bigint;
  readonly bump_seconds: bigint;
}

function collecting(store: SqliteStore): BucketTimingRow | undefined {
  return store.db
    .prepare<[], BucketTimingRow>(
      "SELECT deadline_at, window_seconds, max_seconds, bump_seconds FROM buckets WHERE state = 'collecting'",
    )
    .get();
}

function settlesAt(scheduler: { processDue(now: Date): bigint[] }, seconds: number): bigint {
  expect(scheduler.processDue(new Date(T0 + seconds * 1_000 - 1))).toEqual([]);
  const [invocationId, ...rest] = scheduler.processDue(at(seconds));
  expect(rest).toEqual([]);
  if (invocationId === undefined) {
    throw new Error(`Expected a batch to settle at ${seconds}s`);
  }
  return invocationId;
}

function complete(store: SqliteStore, invocationId: bigint): void {
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
}

describe('reloading the bucket timing', () => {
  test('an open batch keeps the bump and ceiling it opened with; the next batch takes the new ones', async () => {
    const { store, configStore, ingestion, scheduler } = await setup(initial({ window: 10, max: 10, bump: 0 }));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    expect(collecting(store)).toEqual({
      deadline_at: at(10).toISOString(),
      window_seconds: 10n,
      max_seconds: 10n,
      bump_seconds: 0n,
    });

    reload(configStore, { window: 5, max: 60, bump: 20 });
    // Under the new timing this message would push the batch to 8 + 20 = 28.
    ingestion.ingest(textUpdate(2, 11, 'second'), at(8));
    expect(collecting(store)?.deadline_at).toBe(at(10).toISOString());
    complete(store, settlesAt(scheduler, 10));

    ingestion.ingest(textUpdate(3, 12, 'third'), at(12));
    expect(collecting(store)).toEqual({
      deadline_at: at(17).toISOString(),
      window_seconds: 5n,
      max_seconds: 60n,
      bump_seconds: 20n,
    });
    ingestion.ingest(textUpdate(4, 13, 'fourth'), at(14));
    expect(collecting(store)?.deadline_at).toBe(at(34).toISOString());
    settlesAt(scheduler, 34);
    store.close();
  });

  test('shrinking the timing does not cut an open batch short', async () => {
    const { store, configStore, ingestion, scheduler } = await setup(initial({ window: 5, max: 60, bump: 20 }));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    ingestion.ingest(textUpdate(2, 11, 'second'), at(3));
    expect(collecting(store)?.deadline_at).toBe(at(23).toISOString());

    reload(configStore, { window: 5, max: 5, bump: 0 });
    // The batch still extends with its own bump of 20, up to its own ceiling.
    ingestion.ingest(textUpdate(3, 12, 'third'), at(20));
    expect(collecting(store)?.deadline_at).toBe(at(40).toISOString());
    ingestion.ingest(textUpdate(4, 13, 'fourth'), at(38));
    expect(collecting(store)?.deadline_at).toBe(at(58).toISOString());
    ingestion.ingest(textUpdate(5, 14, 'fifth'), at(50));
    expect(collecting(store)?.deadline_at).toBe(at(60).toISOString());
    settlesAt(scheduler, 60);
    store.close();
  });

  test('a batch deferred mid-round restarts its own window, not the reloaded one', async () => {
    const attachment: BucketAttachmentTarget = {
      isClosing: () => false,
      isRoundInProgress: () => true,
      queueInjection: () => undefined,
    };
    const { store, configStore, ingestion, scheduler } = await setup(
      initial({ window: 5, max: 5, bump: 0 }),
      undefined,
      attachment,
    );
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    const running = settlesAt(scheduler, 5);
    // The run is now working on its round for this Conversation.
    store.db
      .prepare("UPDATE invocations SET state = 'running', started_at = ? WHERE id = ?")
      .run(at(5).toISOString(), running);
    store.db
      .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
      .run(running);

    ingestion.ingest(textUpdate(2, 11, 'during the round'), at(6));
    expect(collecting(store)?.deadline_at).toBe(at(11).toISOString());
    reload(configStore, { window: 30, max: 30, bump: 0 });

    expect(scheduler.processDue(at(11))).toEqual([]);
    // Pushed one of its own five-second windows on, not thirty.
    expect(collecting(store)?.deadline_at).toBe(at(16).toISOString());
    store.close();
  });

  test('the end of a run re-anchors an open batch with that batch’s window', async () => {
    const runs: number[] = [];
    let finishRun!: () => void;
    const { store, configStore, ingestion, scheduler } = await setup(
      initial({ window: 5, max: 5, bump: 0 }),
      async (): Promise<InvocationOutcome> => {
        runs.push(Date.now());
        if (runs.length === 1) {
          await new Promise<void>((resolve) => {
            finishRun = resolve;
          });
        }
        return { state: 'completed', reason: 'done' };
      },
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    scheduler.start();
    try {
      ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runs).toEqual([t0 + 5_000]);

      await vi.advanceTimersByTimeAsync(1_000);
      ingestion.ingest(textUpdate(2, 11, 'while running'), new Date());
      scheduler.wake();
      expect(collecting(store)?.deadline_at).toBe(new Date(t0 + 11_000).toISOString());
      reload(configStore, { window: 30, max: 30, bump: 0 });

      await vi.advanceTimersByTimeAsync(1_000);
      finishRun();
      await vi.advanceTimersByTimeAsync(0);
      // `run start + window` is 5 + 5 = 10 with the batch's own window, which
      // leaves its deadline of 11 alone; the reloaded 30 would push it to 35.
      expect(collecting(store)?.deadline_at).toBe(new Date(t0 + 11_000).toISOString());
      await vi.advanceTimersByTimeAsync(4_000);
      expect(runs).toEqual([t0 + 5_000, t0 + 11_000]);
    } finally {
      await scheduler.stop();
      store.close();
    }
  });
});
