import { afterAll, describe, expect, test } from 'vitest';
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
import { PlaygroundStore } from '../src/store/playground.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { buckets, invocations } from '../src/store/schema.ts';
import { writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{
  store: SqliteStore;
  configStore: RuntimeConfigurationStore;
  room: { chatId: bigint };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-scheduler-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
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
    const senderId = store.orm
      .all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
    const ingress = new PlaygroundIngress(store.orm);
    ingress.submit(room.chatId, { requestKey: 'req-1', senderId, text: 'hello' });
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
    const senderId = store.orm
      .all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]!.id;
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
});
