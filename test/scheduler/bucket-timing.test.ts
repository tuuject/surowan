import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import type { Update } from 'grammy/types';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { resolveBucketTiming } from '../../src/platform/config/resolve.ts';
import type { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { cleanupSchedulerDirectories, directories, setup, textUpdate } from './fixtures.ts';

afterAll(cleanupSchedulerDirectories);
afterEach(() => {
  vi.useRealTimers();
});

const T0 = new Date('2026-08-15T00:00:00.000Z').getTime();
const at = (seconds: number): Date => new Date(T0 + seconds * 1_000);

function timing(window: number, max?: number, bump?: number): (config: FixtureConfig) => void {
  return (config) => {
    config.telegram.bucket_window_seconds = window;
    if (max !== undefined) {
      config.telegram.bucket_max_seconds = max;
    }
    if (bump !== undefined) {
      config.telegram.bucket_bump_seconds = bump;
    }
  };
}

function collectingDeadline(store: SqliteStore): string | undefined {
  return store.db
    .prepare<[], { deadline_at: string }>("SELECT deadline_at FROM buckets WHERE state = 'collecting'")
    .get()?.deadline_at;
}

/**
 * Asserts the batch is due at exactly `seconds` after T0: one millisecond
 * earlier the scheduler opens nothing, at the deadline it opens one invocation.
 */
function expectSettlesAt(scheduler: BucketScheduler, seconds: number): bigint {
  expect(scheduler.processDue(new Date(T0 + seconds * 1_000 - 1))).toEqual([]);
  const opened = scheduler.processDue(at(seconds));
  expect(opened).toHaveLength(1);
  const [invocationId] = opened;
  if (invocationId === undefined) {
    throw new Error('Expected an invocation');
  }
  return invocationId;
}

/** Ends an opened invocation the way a finished run would, so the chat can open the next batch. */
function complete(store: SqliteStore, invocationId: bigint): void {
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
}

/** Telegram message ids a batch holds, in bucket order. */
function bucketTelegramIds(store: SqliteStore, invocationId: bigint): number[] {
  return store.db
    .prepare<[bigint], { telegram_message_id: bigint }>(
      `SELECT m.telegram_message_id FROM bucket_messages bm JOIN messages m ON m.id = bm.message_id
       WHERE bm.bucket_id = (SELECT bucket_id FROM invocations WHERE id = ?) ORDER BY bm.sequence_no`,
    )
    .all(invocationId)
    .map((row) => Number(row.telegram_message_id));
}

/** Every stored message sits in exactly one batch: none lost, none counted twice. */
function expectEachMessageInOneBucket(store: SqliteStore): void {
  const rows = store.db
    .prepare<[], { telegram_message_id: bigint; buckets: bigint }>(
      `SELECT m.telegram_message_id, COUNT(bm.bucket_id) AS buckets
       FROM messages m LEFT JOIN bucket_messages bm ON bm.message_id = m.id GROUP BY m.id`,
    )
    .all();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect({ message: Number(row.telegram_message_id), buckets: row.buckets }).toEqual({
      message: Number(row.telegram_message_id),
      buckets: 1n,
    });
  }
}

function stickerUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      sticker: {
        file_id: `sticker-${messageId}`,
        file_unique_id: `sticker-unique-${messageId}`,
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
}

describe('adaptive bucket timing', () => {
  test('the default configuration keeps the fixed 15-second window', async () => {
    const { loaded, store, ingestion, scheduler } = await setup();
    expect(resolveBucketTiming(loaded.config, 'telegram')).toEqual({
      windowSeconds: 15,
      maxSeconds: 15,
      bumpSeconds: 0,
    });
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    ingestion.ingest(textUpdate(2, 11, 'second'), at(10));
    ingestion.ingest(textUpdate(3, 12, 'third'), at(14.9));
    expect(collectingDeadline(store)).toBe(at(15).toISOString());
    const invocationId = expectSettlesAt(scheduler, 15);
    expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11, 12]);
    store.close();
  });

  test('a lone message settles at the window', async () => {
    const { store, ingestion, scheduler } = await setup(timing(5, 30, 10));
    ingestion.ingest(textUpdate(1, 10, 'only'), at(0));
    expect(collectingDeadline(store)).toBe(at(5).toISOString());
    expectSettlesAt(scheduler, 5);
    store.close();
  });

  test('a bump that still ends inside the window leaves the window deadline', async () => {
    const { store, ingestion, scheduler } = await setup(timing(10, 30, 4));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    // 3 + 4 = 7 < 10: the window is longer, so the deadline stays at 10.
    ingestion.ingest(textUpdate(2, 11, 'second'), at(3));
    expect(collectingDeadline(store)).toBe(at(10).toISOString());
    expectSettlesAt(scheduler, 10);
    store.close();
  });

  test('a message past the window minus the bump extends the batch beyond the window', async () => {
    const { store, ingestion, scheduler } = await setup(timing(10, 30, 8));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    ingestion.ingest(textUpdate(2, 11, 'second'), at(5));
    expect(collectingDeadline(store)).toBe(at(13).toISOString());
    // The old deadline passes without settling anything.
    expect(scheduler.processDue(at(10))).toEqual([]);
    const invocationId = expectSettlesAt(scheduler, 13);
    expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11]);
    store.close();
  });

  test('consecutive messages keep extending, and an earlier candidate never pulls the deadline in', async () => {
    const { store, ingestion, scheduler } = await setup(timing(5, 60, 5));
    ingestion.ingest(textUpdate(1, 10, 'a'), at(0));
    ingestion.ingest(textUpdate(2, 11, 'b'), at(3));
    expect(collectingDeadline(store)).toBe(at(8).toISOString());
    ingestion.ingest(textUpdate(3, 12, 'c'), at(7));
    expect(collectingDeadline(store)).toBe(at(12).toISOString());
    ingestion.ingest(textUpdate(4, 13, 'd'), at(11));
    expect(collectingDeadline(store)).toBe(at(16).toISOString());
    // A round ending pushes the batch further than any bump would (the runtime
    // writes `round end + window`, even past the ceiling); a later message must
    // keep that, not clamp it back to `first message + max`.
    store.db.prepare("UPDATE buckets SET deadline_at = ? WHERE state = 'collecting'").run(at(70).toISOString());
    ingestion.ingest(textUpdate(5, 14, 'e'), at(12));
    expect(collectingDeadline(store)).toBe(at(70).toISOString());
    const invocationId = expectSettlesAt(scheduler, 70);
    expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11, 12, 13, 14]);
    store.close();
  });

  test('an extension past the ceiling is clipped to first message plus max', async () => {
    const { store, ingestion, scheduler } = await setup(timing(5, 12, 10));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    // 8 + 10 = 18 > 0 + 12.
    ingestion.ingest(textUpdate(2, 11, 'second'), at(8));
    expect(collectingDeadline(store)).toBe(at(12).toISOString());
    expectSettlesAt(scheduler, 12);
    store.close();
  });

  test('a steady stream still settles at the ceiling and the next batch starts fresh', async () => {
    const { store, ingestion, scheduler } = await setup(timing(5, 20, 5));
    const settled: { second: number; invocationId: bigint }[] = [];
    let messageId = 10;
    // A message every two seconds for 40 seconds, each one inside the previous
    // bump, with a scheduler pass every second like a running loop would make.
    for (let second = 0; second <= 40; second += 1) {
      if (second % 2 === 0) {
        ingestion.ingest(textUpdate(messageId, messageId, `m${messageId}`), at(second));
        messageId += 1;
      }
      for (const invocationId of scheduler.processDue(at(second))) {
        settled.push({ second, invocationId });
        complete(store, invocationId);
      }
    }
    const [first, ...rest] = settled;
    // Without the ceiling every message would push the batch out again forever.
    expect(first?.second).toBe(20);
    expect(rest).toEqual([]);
    if (first === undefined) {
      throw new Error('Expected the first batch to settle');
    }
    // Messages at 0, 2, …, 20: the one arriving at the ceiling still made it in.
    expect(bucketTelegramIds(store, first.invocationId)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    // The next batch opened at 22, so its own ceiling is 22 + 20.
    expect(collectingDeadline(store)).toBe(at(42).toISOString());
    const second = expectSettlesAt(scheduler, 42);
    expect(bucketTelegramIds(store, second)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expectEachMessageInOneBucket(store);
    store.close();
  });

  test('messages that may not open a batch join it without extending it', async () => {
    const { store, ingestion, scheduler } = await setup(timing(5, 30, 10));
    ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
    // A sticker alone does not trigger (`sticker_trigger_enabled` is off), so
    // it must not hold the batch open either.
    ingestion.ingest(stickerUpdate(2, 11), at(4));
    expect(collectingDeadline(store)).toBe(at(5).toISOString());
    const invocationId = expectSettlesAt(scheduler, 5);
    expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11]);
    store.close();
  });

  describe('a message racing the settlement', () => {
    test('arriving after the deadline but before the scheduler pass, it joins the open batch exactly once', async () => {
      const { store, ingestion, scheduler } = await setup(timing(5, 5, 0));
      ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
      // The scheduler's timer is late: the deadline has passed, the batch is
      // still collecting, so the message lands in it rather than in a new one.
      ingestion.ingest(textUpdate(2, 11, 'late'), at(5.2));
      expect(collectingDeadline(store)).toBe(at(5).toISOString());
      const opened = scheduler.processDue(at(5.3));
      expect(opened).toHaveLength(1);
      const [invocationId] = opened;
      if (invocationId === undefined) {
        throw new Error('Expected an invocation');
      }
      expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11]);
      complete(store, invocationId);
      expect(scheduler.processDue(at(60))).toEqual([]);
      expectEachMessageInOneBucket(store);
      store.close();
    });

    test('arriving at the deadline with a bump, it extends the batch instead of being split off', async () => {
      const { store, ingestion, scheduler } = await setup(timing(5, 30, 3));
      ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
      ingestion.ingest(textUpdate(2, 11, 'boundary'), at(5));
      expect(collectingDeadline(store)).toBe(at(8).toISOString());
      expect(scheduler.processDue(at(5))).toEqual([]);
      const invocationId = expectSettlesAt(scheduler, 8);
      expect(bucketTelegramIds(store, invocationId)).toEqual([10, 11]);
      expectEachMessageInOneBucket(store);
      store.close();
    });

    test('arriving in the same millisecond after the batch settled, it opens the next batch', async () => {
      const { store, ingestion, scheduler } = await setup(timing(5, 30, 3));
      ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
      const first = expectSettlesAt(scheduler, 5);
      ingestion.ingest(textUpdate(2, 11, 'just after'), at(5));
      expect(bucketTelegramIds(store, first)).toEqual([10]);
      // The settled batch was not extended: the new message opened its own,
      // counted from itself.
      expect(collectingDeadline(store)).toBe(at(10).toISOString());
      complete(store, first);
      const second = expectSettlesAt(scheduler, 10);
      expect(bucketTelegramIds(store, second)).toEqual([11]);
      expectEachMessageInOneBucket(store);
      store.close();
    });
  });

  test('the running loop re-arms its timer for an extended deadline and settles the batch once', async () => {
    const started: number[] = [];
    const { store, ingestion, scheduler } = await setup(timing(5, 30, 8), async () => {
      started.push(Date.now());
      return { state: 'completed', reason: 'done' };
    });
    // Faked only once the fixture exists: the clock starts at the real current
    // time, and every instant below is an offset from it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = Date.now();
    scheduler.start();
    try {
      // The serve loop wakes the scheduler after every ingested update.
      ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(3_000);
      ingestion.ingest(textUpdate(2, 11, 'second'), new Date());
      scheduler.wake();
      // The original deadline (t0 + 5 s) passes without a run.
      await vi.advanceTimersByTimeAsync(7_999);
      expect(started).toEqual([]);
      expect(scheduler.nextDelayMilliseconds()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual([t0 + 11_000]);
      // Nothing left armed for the settled batch: a minute later it still ran once.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(started).toHaveLength(1);
      expect(
        store.db
          .prepare<[], { state: string }>('SELECT state FROM buckets')
          .all()
          .map((row) => row.state),
      ).toEqual(['completed']);
      expectEachMessageInOneBucket(store);
    } finally {
      await scheduler.stop();
      store.close();
    }
  });

  describe('configuration', () => {
    async function load(transform: (config: FixtureConfig) => void) {
      const directory = await mkdtemp(join(tmpdir(), 'surowan-bucket-timing-'));
      directories.push(directory);
      const configPath = join(directory, 'config.jsonc');
      await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
      return loadConfig(configPath);
    }

    async function loadError(transform: (config: FixtureConfig) => void): Promise<string> {
      try {
        await load(transform);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('Expected loadConfig to reject the configuration');
    }

    test('a configuration with only the old fixed window keeps that window, whatever its length', async () => {
      const loaded = await load((config) => {
        config.telegram.bucket_window_seconds = 30;
        config.agent.context.idle_grace_seconds = 30;
      });
      expect(loaded.config.telegram.bucket_max_seconds).toBeUndefined();
      expect(loaded.config.telegram.bucket_bump_seconds).toBeUndefined();
      expect(resolveBucketTiming(loaded.config, 'telegram')).toEqual({
        windowSeconds: 30,
        maxSeconds: 30,
        bumpSeconds: 0,
      });
      const { store, ingestion, scheduler } = await setup(timing(30));
      ingestion.ingest(textUpdate(1, 10, 'first'), at(0));
      ingestion.ingest(textUpdate(2, 11, 'second'), at(29));
      expectSettlesAt(scheduler, 30);
      store.close();
    });

    test('rejects a ceiling below the window and negative or oversized values', async () => {
      expect(await loadError(timing(15, 10))).toContain(
        'telegram.bucket_max_seconds must be at least telegram.bucket_window_seconds',
      );
      expect(await loadError(timing(15, 15, -1))).toContain('Invalid config');
      expect(await loadError(timing(15, 301))).toContain('Invalid config');
      // The ceiling defaults to the window, so a window alone is always valid…
      await expect(load(timing(0))).resolves.toBeDefined();
      // …and a zero bump with an equal ceiling is the fixed window spelled out.
      await expect(load(timing(15, 15, 0))).resolves.toBeDefined();
    });

    test('the idle grace has to cover the ceiling, not just the window', async () => {
      const withGrace = (grace: number) => (config: FixtureConfig) => {
        timing(10, 40, 5)(config);
        config.agent.context.idle_grace_seconds = grace;
      };
      expect(await loadError(withGrace(20))).toContain(
        'agent.context.idle_grace_seconds must be 0 (long-lived invocations off) or at least telegram.bucket_max_seconds',
      );
      await expect(load(withGrace(40))).resolves.toBeDefined();
      await expect(load(withGrace(0))).resolves.toBeDefined();
    });
  });
});
