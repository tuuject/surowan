import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  RETENTION_CLEANUP_INTERVAL_MS,
  RetentionCleanup,
} from '../../src/adapters/local-monolith/runtime/retention.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { testConfigStore, writeTestConfig } from '../helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  // Cleanup must not fail the suite: on Windows an open SQLite handle can make
  // `rm` lose the race, and a leaked temp directory is acceptable here.
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('startup and daily cleanup prune only expired terminal rows, follow the published config and survive failures', async () => {
  vi.useFakeTimers();
  const base = new Date();
  const day = 86_400_000;
  const directory = await mkdtemp(join(tmpdir(), 'surowan-retention-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  let nextId = 0;
  const spawn = (state: string, finishedAt: Date | null, receivedAt: Date): bigint => {
    nextId += 1;
    ingestion.ingest(textUpdate(nextId, nextId, `seed ${nextId}`), receivedAt);
    const [invocation] = scheduler.processDue(new Date(receivedAt.getTime() + 15_000));
    if (invocation === undefined) {
      throw new Error('Expected an invocation');
    }
    store.db
      .prepare('UPDATE invocations SET state = ?, created_at = ?, finished_at = ? WHERE id = ?')
      .run(state, receivedAt.toISOString(), finishedAt?.toISOString() ?? null, invocation);
    return invocation;
  };
  const invocationsLeft = (id: bigint): bigint =>
    store.db.prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations WHERE id = ?').get(id)
      ?.count ?? 0n;

  const onlineDays = loaded.config.retention.online_days;
  const oldReceived = new Date(base.getTime() - (onlineDays + 10) * day);
  const oldTerminal = spawn('completed', oldReceived, base);
  const recentTerminal = spawn('completed', new Date(base.getTime() - 2 * day), base);
  // A still-running invocation must never be pruned, however old it is.
  const running = spawn('running', null, oldReceived);
  store.db
    .prepare(
      "INSERT INTO tool_calls(invocation_id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, created_at, finished_at) VALUES (?, 'old-tool', 'probe', '{}', 'old result', 'success', 0, ?, ?)",
    )
    .run(oldTerminal, oldReceived.toISOString(), oldReceived.toISOString());

  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    events.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
  let failNext = false;
  const cleanup = new RetentionCleanup(store.orm, () => {
    if (failNext) {
      failNext = false;
      throw new Error('synthetic cleanup failure');
    }
    return configStore.current().config;
  });
  try {
    // The startup run removes exactly the expired terminal rows.
    cleanup.start();
    expect(invocationsLeft(oldTerminal)).toBe(0n);
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_call_id = 'old-tool'")
        .get()?.count,
    ).toBe(0n);
    expect(invocationsLeft(recentTerminal)).toBe(1n);
    expect(invocationsLeft(running)).toBe(1n);
    expect(events.at(-1)).toMatchObject({ event: 'retention_cleanup', duration_ms: expect.any(Number) });

    // The 24h timer runs it again; nothing new has expired yet.
    vi.advanceTimersByTime(RETENTION_CLEANUP_INTERVAL_MS);
    expect(invocationsLeft(recentTerminal)).toBe(1n);
    expect(events.at(-1)).toMatchObject({ event: 'retention_cleanup' });

    // A published change reaches the next run…
    const current = configStore.current();
    configStore.publish({
      config: { ...current.config, retention: { ...current.config.retention, online_days: 1 } },
      hash: 'retention-test',
      models: current.models,
      visionModel: current.visionModel,
    });
    // …but a throwing run is logged and skipped rather than being fatal.
    failNext = true;
    vi.advanceTimersByTime(RETENTION_CLEANUP_INTERVAL_MS);
    expect(invocationsLeft(recentTerminal)).toBe(1n);
    expect(events.at(-1)).toMatchObject({ event: 'retention_cleanup_failed', error: 'synthetic cleanup failure' });

    // The following run still happens and honours the published 1-day window.
    vi.advanceTimersByTime(RETENTION_CLEANUP_INTERVAL_MS);
    expect(invocationsLeft(recentTerminal)).toBe(0n);
    expect(invocationsLeft(running)).toBe(1n);
    expect(events.at(-1)).toMatchObject({ event: 'retention_cleanup' });

    // Stopping the timer cancels every future run. The still-running
    // invocation would gate a new bucket on its conversation, so close it out
    // first; the expired terminal row planted next must stay untouched.
    cleanup.stop();
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(base.toISOString(), running);
    const lateTerminal = spawn('completed', oldReceived, base);
    const eventCount = events.length;
    vi.advanceTimersByTime(10 * RETENTION_CLEANUP_INTERVAL_MS);
    expect(invocationsLeft(lateTerminal)).toBe(1n);
    expect(events.length).toBe(eventCount);
  } finally {
    cleanup.stop();
    store.close();
  }
});

function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}
