import { afterAll, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { PLAYGROUND_QUEUE_TTL_MS, PlaygroundStore } from '../src/store/playground.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { appState, buckets, invocations, taskReceipts } from '../src/store/schema.ts';
import { SLEEP_STATE_KEY } from '../src/store/sleep.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(maxConcurrency?: number): Promise<{
  store: SqliteStore;
  configStore: RuntimeConfigurationStore;
  room: { chatId: bigint };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-playground-scheduler-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      if (maxConcurrency !== undefined) {
        config.agent.max_concurrency = maxConcurrency;
      }
    }),
  );
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const room = new PlaygroundStore(store.orm).createRoom({
    title: 'Scheduler Room',
    members: [{ name: 'Alice' }],
  });
  return { store, configStore, room: { chatId: room.chatId } };
}

async function until(predicate: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the scheduler');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('playground scheduling', () => {
  test('a released room invocation is launched once by the scheduler', async () => {
    const { store, configStore, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const member = playground.status(room.chatId);
    expect(member.held).toHaveLength(0);
    const senderId = store.orm.all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
    const ingress = new PlaygroundIngress(store.orm);
    await ingress.submit(room.chatId, { requestKey: 'req-1', senderId, text: 'hello' });
    const release = ingress.release(room.chatId, {
      releaseKey: 'rel-1',
      revision: playground.room(room.chatId).revision,
    });
    expect(release.invocationId).not.toBeNull();

    const launched: bigint[] = [];
    const scheduler = new BucketScheduler(store, configStore, async (invocationId) => {
      launched.push(invocationId);
      return { state: 'completed', reason: 'test' };
    });
    scheduler.start();
    try {
      await until(() => launched.length === 1);
      expect(launched[0]).toBe(release.invocationId);
      await until(
        () =>
          store.orm
            .select({ state: invocations.state })
            .from(invocations)
            .where(eq(invocations.id, release.invocationId!))
            .get()?.state === 'completed',
      );
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('a queued release survives a restart and runs once on startup', async () => {
    const { store, configStore, room } = await fixture();
    const playground = new PlaygroundStore(store.orm);
    const senderId = store.orm.all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
    playground.submit(room.chatId, { requestKey: 'req-1', senderId, text: 'hello' });
    const release = playground.release(room.chatId, {
      releaseKey: 'rel-1',
      revision: playground.room(room.chatId).revision,
    });

    const launched: bigint[] = [];
    const scheduler = new BucketScheduler(store, configStore, async (invocationId) => {
      launched.push(invocationId);
      return { state: 'completed', reason: 'test' };
    });
    scheduler.start(new Date());
    try {
      await until(() => launched.length === 1);
      expect(launched[0]).toBe(release.invocationId);
      // Startup recovery does not expire a room's queued work as a stale
      // Telegram collecting bucket.
      const bucket = store.orm.select().from(buckets).all()[0];
      expect(bucket?.state).not.toBe('expired');
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('a queued room behind a full concurrency limit does not spin the scheduler', async () => {
    const { store, configStore, room } = await fixture(1);
    const playground = new PlaygroundStore(store.orm);
    const other = playground.createRoom({ title: 'Second Room', members: [{ name: 'Bob' }] });
    const releaseRoom = (chatId: bigint, senderId: bigint): bigint => {
      playground.submit(chatId, { requestKey: `req-${chatId}`, senderId, text: 'hello' });
      const release = playground.release(chatId, {
        releaseKey: `rel-${chatId}`,
        revision: playground.room(chatId).revision,
      });
      return release.invocationId!;
    };
    const firstSender = store.orm.all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
    const first = releaseRoom(room.chatId, firstSender);
    const second = releaseRoom(other.chatId, other.members[0]!.senderId);

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const launched: bigint[] = [];
    const scheduler = new BucketScheduler(store, configStore, async (invocationId) => {
      launched.push(invocationId);
      if (invocationId === first) {
        await gate;
      }
      return { state: 'completed', reason: 'test' };
    });
    scheduler.start();
    try {
      await until(() => launched.length === 1);
      // The only slot is taken and the second room is overdue. Its deadline
      // must not drive a zero-delay loop while the first run holds the slot.
      const queries = vi.spyOn(store.orm, 'all');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(queries.mock.calls.length).toBeLessThan(20);
      queries.mockRestore();
      open();
      // The finishing run wakes the scheduler, which then launches the second.
      await until(() => launched.length === 2);
      expect(launched).toEqual([first, second]);
    } finally {
      open();
      await scheduler.stop(1_000);
    }
  });

  test('a queued room run behind the room run wakes the scheduler at its expiry', async () => {
    const { store, configStore, room } = await fixture(1);
    const playground = new PlaygroundStore(store.orm);
    const senderId = store.orm.all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
    const releaseOnce = (key: string): bigint => {
      playground.submit(room.chatId, { requestKey: `req-${key}`, senderId, text: key });
      return playground.release(room.chatId, {
        releaseKey: `rel-${key}`,
        revision: playground.room(room.chatId).revision,
      }).invocationId!;
    };
    const running = releaseOnce('1');
    store.orm.update(invocations).set({ state: 'running' }).where(eq(invocations.id, running)).run();
    // The second waits behind the room's own run, queued long enough ago that
    // it expires in two seconds; nothing else would wake the loop before 60s.
    const waiting = releaseOnce('2');
    const createdAt = new Date(Date.now() - PLAYGROUND_QUEUE_TTL_MS + 2_000).toISOString();
    store.orm.update(invocations).set({ createdAt }).where(eq(invocations.id, waiting)).run();
    const scheduler = new BucketScheduler(
      store,
      configStore,
      async () => ({ state: 'completed', reason: 'test' }),
      undefined,
      new LongTaskService(store.orm, undefined, ['playground']),
      undefined,
      ['playground'],
    );
    expect(scheduler.nextDelayMilliseconds()).toBeLessThanOrEqual(2_001);
    expect(playground.expireQueued(new Date(playground.nextQueuedExpiry()!))).toBe(1);
    expect(playground.nextQueuedExpiry()).toBeUndefined();
  });

  test('a room-only scheduler never reads or clears the global sleep state', async () => {
    const { store, configStore } = await fixture();
    const expired = new Date(Date.now() - 60_000).toISOString();
    store.orm.insert(appState).values({ key: SLEEP_STATE_KEY, value: expired, updatedAt: expired }).run();
    const scheduler = new BucketScheduler(
      store,
      configStore,
      async () => ({ state: 'completed', reason: 'test' }),
      undefined,
      new LongTaskService(store.orm, undefined, ['playground']),
      undefined,
      ['playground'],
    );
    scheduler.start();
    try {
      scheduler.nextDelayMilliseconds();
      scheduler.processDue();
      scheduler.processTasksDue();
      scheduler.wake();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await scheduler.stop(1_000);
    }
    expect(store.orm.select().from(appState).where(eq(appState.key, SLEEP_STATE_KEY)).get()?.value).toBe(expired);
  });

  test('a task completion for a room is delivered, not suppressed as a removed chat', async () => {
    const { store, configStore, room } = await fixture();
    const conversationId = new PlaygroundStore(store.orm).room(room.chatId).conversationId;
    const tasks = new LongTaskService(store.orm);
    const scope = tasks.scoped('test-plugin', conversationId);
    const created = scope.create({ payload: { operation: 'export' } });
    expect(scope.complete(created.taskId, { ok: true })).toBe(true);

    const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'test' }));
    const queued = scheduler.processTasksDue();

    expect(queued).toHaveLength(1);
    const receipt = store.orm.select().from(taskReceipts).get();
    expect(receipt).toMatchObject({ state: 'claimed', invocationId: queued[0] });
  });
});
