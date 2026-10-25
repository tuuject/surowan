/**
 * Live connection readiness: a process keeps serving its other hosts while one
 * IM namespace is disabled, misconfigured or not connected yet.
 *
 * The Scheduler and the image worker ask the registry on every pass, so
 * Telegram work stays exactly where it is (not launched, not failed, not
 * claimed) until an instance reports an identity; Playground work is never
 * affected.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { PLAYGROUND_BOT_DISPLAY_NAME } from '../../src/adapters/local-monolith/runtime/support.ts';
import { createTelegramHost } from '../../src/adapters/local-monolith/telegram/host.ts';
import {
  ForwardingTelegramMedia,
  forwardingTelegramTransport,
  TelegramConnectionIdentity,
  TelegramInstanceHolder,
} from '../../src/adapters/local-monolith/telegram/instance.ts';
import { generationEligibilityForHosts } from '../../src/image/host-eligibility.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { ImConnectionRegistry } from '../../src/platform/im-connection.ts';
import { identityConversation } from '../../src/platform/im-host.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { buildModelRegistry } from '../../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { buckets, chats, conversations, invocations, longTasks, taskReceipts } from '../../src/store/schema/index.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterAll(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{ store: SqliteStore; configStore: RuntimeConfigurationStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-readiness-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory));
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
  return {
    store,
    configStore: new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry }),
  };
}

/** A Telegram chat/conversation matching the fixture's configured chat. */
function seedTelegramChat(store: SqliteStore, conversationId: bigint): void {
  const now = new Date().toISOString();
  store.orm
    .insert(chats)
    .values({
      id: 900n,
      hostKind: 'telegram',
      telegramChatId: 123456789n,
      canonicalChatId: 123456789n,
      type: 'private',
      updatedAt: now,
    })
    .run();
  store.orm.insert(conversations).values({ id: conversationId, chatId: 900n, createdAt: now, updatedAt: now }).run();
}

function seedQueuedInvocation(store: SqliteStore, conversationId: bigint): void {
  const now = new Date().toISOString();
  store.orm
    .insert(buckets)
    .values({
      id: 900n,
      conversationId,
      state: 'queued',
      kind: 'realtime',
      firstReceivedAt: now,
      deadlineAt: now,
      queuedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  store.orm
    .insert(invocations)
    .values({
      id: 900n,
      bucketId: 900n,
      conversationId,
      state: 'queued',
      configHash: 'fixture',
      promptVersion: 1n,
      createdAt: now,
    })
    .run();
}

function readinessFor(registry: ImConnectionRegistry) {
  return (host: 'telegram' | 'playground'): boolean => host === 'playground' || registry.isReady('telegram');
}

function schedulerFor(
  store: SqliteStore,
  configStore: RuntimeConfigurationStore,
  readiness: (host: 'telegram' | 'playground') => boolean,
  launched: bigint[],
): BucketScheduler {
  return new BucketScheduler(
    store,
    configStore,
    async (invocationId) => {
      launched.push(invocationId);
      return { state: 'completed', reason: 'test' };
    },
    undefined,
    new LongTaskService(store.orm, undefined, ['telegram', 'playground']),
    undefined,
    ['telegram', 'playground'],
    undefined,
    readiness,
  );
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

const invocationState = (store: SqliteStore, id: bigint): string | undefined =>
  store.orm.select({ state: invocations.state }).from(invocations).where(eq(invocations.id, id)).get()?.state;

describe('connection readiness', () => {
  test('Telegram work waits for a ready connection and resumes when one arrives', async () => {
    const { store, configStore } = await fixture();
    seedTelegramChat(store, 900n);
    seedQueuedInvocation(store, 900n);
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    const launched: bigint[] = [];
    const scheduler = schedulerFor(store, configStore, readinessFor(registry), launched);
    scheduler.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(launched).toEqual([]);
      expect(invocationState(store, 900n)).toBe('queued');
      expect(store.orm.select({ state: buckets.state }).from(buckets).where(eq(buckets.id, 900n)).get()?.state).toBe(
        'queued',
      );

      registry.set('telegram', {
        status: 'connected',
        since: '2026-01-01T00:00:01.000Z',
        bot: { id: '42', username: 'fixture_bot' },
      });
      scheduler.wake();
      await until(() => launched.length === 1);
      expect(launched[0]).toBe(900n);
      await until(() => invocationState(store, 900n) === 'completed');
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('startup recovery closes a dead process run although Telegram is not ready yet', async () => {
    const { store, configStore } = await fixture();
    seedTelegramChat(store, 900n);
    seedQueuedInvocation(store, 900n);
    // What a killed process leaves behind: its run is still `running`.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    store.orm
      .insert(buckets)
      .values({
        id: 901n,
        conversationId: 900n,
        state: 'running',
        kind: 'realtime',
        firstReceivedAt: startedAt,
        deadlineAt: startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      })
      .run();
    store.orm
      .insert(invocations)
      .values({
        id: 901n,
        bucketId: 901n,
        conversationId: 900n,
        state: 'running',
        configHash: 'fixture',
        promptVersion: 1n,
        startedAt,
        createdAt: startedAt,
      })
      .run();
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    const launched: bigint[] = [];
    const scheduler = schedulerFor(store, configStore, readinessFor(registry), launched);
    // Recovery runs once, here, while the connection is still coming up.
    scheduler.start();
    try {
      expect(
        store.orm
          .select({ state: invocations.state, reason: invocations.completionReason })
          .from(invocations)
          .where(eq(invocations.id, 901n))
          .get(),
      ).toEqual({ state: 'aborted', reason: 'process_restart' });
      expect(store.orm.select({ state: buckets.state }).from(buckets).where(eq(buckets.id, 901n)).get()?.state).toBe(
        'aborted',
      );
      // Fresh queued work is not the dead process's to close; it waits.
      expect(invocationState(store, 900n)).toBe('queued');

      registry.set('telegram', {
        status: 'connected',
        since: '2026-01-01T00:00:01.000Z',
        bot: { id: '42', username: 'fixture_bot' },
      });
      scheduler.wake();
      // The stale `running` row no longer blocks the chat.
      await until(() => launched.length === 1);
      expect(launched[0]).toBe(900n);
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('a due Telegram timer completes but its receipt stays pending until ready', async () => {
    const { store, configStore } = await fixture();
    seedTelegramChat(store, 900n);
    const tasks = new LongTaskService(store.orm, undefined, ['telegram', 'playground']);
    const scheduledAt = new Date(Date.now() - 60_000).toISOString();
    const created = tasks.scoped('alarm', 900n).create({ payload: { summary: 'wake up' }, scheduledAt });
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    const launched: bigint[] = [];
    const scheduler = schedulerFor(store, configStore, readinessFor(registry), launched);
    const receiptState = (): string | undefined =>
      store.orm
        .select({ state: taskReceipts.state })
        .from(taskReceipts)
        .where(eq(taskReceipts.taskId, created.taskId))
        .get()?.state;
    scheduler.start();
    try {
      await until(
        () =>
          store.orm.select({ state: longTasks.state }).from(longTasks).where(eq(longTasks.id, created.taskId)).get()
            ?.state === 'completed',
      );
      await until(() => receiptState() === 'pending');
      expect(launched).toEqual([]);
      expect(store.orm.select().from(invocations).all()).toHaveLength(0);

      registry.set('telegram', {
        status: 'connected',
        since: '2026-01-01T00:00:01.000Z',
        bot: { id: '42', username: 'fixture_bot' },
      });
      scheduler.wake();
      await until(() => launched.length === 1);
      await until(() => receiptState() === 'handled');
      const invocation = store.orm.select().from(invocations).all()[0];
      expect(invocation?.conversationId).toBe(900n);
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('a Playground room still runs while Telegram is not ready', async () => {
    const { store, configStore } = await fixture();
    seedTelegramChat(store, 900n);
    const playground = new PlaygroundStore(store.orm);
    const room = playground.createRoom({ title: 'Room', members: [{ name: 'Ada' }] });
    playground.submit(room.chatId, {
      requestKey: 'room-1',
      senderId: room.members[0]!.senderId,
      text: 'hello',
    });
    const release = playground.release(room.chatId, {
      releaseKey: 'release-1',
      revision: playground.room(room.chatId).revision,
    });
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    const launched: bigint[] = [];
    const scheduler = schedulerFor(store, configStore, readinessFor(registry), launched);
    scheduler.start();
    try {
      await until(() => launched.length === 1);
      expect(launched[0]).toBe(release.invocationId);
    } finally {
      await scheduler.stop(1_000);
    }
  });

  test('image work for an unready host stays ineligible until it is ready', async () => {
    const { store } = await fixture();
    seedTelegramChat(store, 900n);
    const playground = new PlaygroundStore(store.orm);
    const room = playground.createRoom({ title: 'Room', members: [{ name: 'Ada' }] });
    const roomConversation = playground.room(room.chatId).conversationId;
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    const eligible = generationEligibilityForHosts(store, ['telegram', 'playground'], readinessFor(registry));

    expect(eligible({ id: 'g1', actorId: 'agent:900' })).toBe(false);
    expect(eligible({ id: 'g2', actorId: `agent:${roomConversation.toString()}` })).toBe(true);
    expect(eligible({ id: 'g3', actorId: 'admin:root' })).toBe(true);

    registry.set('telegram', {
      status: 'connected',
      since: '2026-01-01T00:00:01.000Z',
      bot: { id: '42', username: 'fixture_bot' },
    });
    expect(eligible({ id: 'g1', actorId: 'agent:900' })).toBe(true);
  });

  test('a registry only reports ready after an identity exists', () => {
    const registry = new ImConnectionRegistry(() => new Date('2026-01-01T00:00:00.000Z'));
    expect(registry.get('telegram')).toEqual({ status: 'disabled', since: '2026-01-01T00:00:00.000Z' });
    expect(registry.isReady('telegram')).toBe(false);

    registry.set('telegram', {
      status: 'config_error',
      reason: 'unauthorized',
      since: '2026-01-01T00:00:01.000Z',
      bot: { id: '42', username: 'fixture_bot' },
    });
    expect(registry.isReady('telegram')).toBe(false);

    registry.set('telegram', {
      status: 'network_error',
      since: '2026-01-01T00:00:02.000Z',
      bot: { id: '42', username: 'fixture_bot' },
    });
    expect(registry.isReady('telegram')).toBe(true);

    registry.set('telegram', { status: 'disabled', since: '2026-01-01T00:00:03.000Z' });
    expect(registry.isReady('telegram')).toBe(false);
  });

  test('the forwarding transport refuses permanently without an instance and follows a new one', async () => {
    const holder = new TelegramInstanceHolder();
    const host = createTelegramHost({
      transport: forwardingTelegramTransport(holder),
      sendRate: () => ({ sendsPerWindow: 6, windowSeconds: 300 }),
    });
    const conversation = identityConversation({ chatId: 1n, threadId: 0n, conversationId: 1n }, 'telegram', 'private');
    const request = {
      target: { conversation, policy: host.policy(conversation) },
      parts: [{ kind: 'text' as const, text: 'hello' }],
      sendId: 1n,
      signal: undefined,
    };

    expect(await host.delivery.deliver(request)).toMatchObject({
      kind: 'rejected',
      failure: { reason: 'permanent', code: 'telegram_unavailable', outcomeUnknown: false },
    });
    await expect(
      new ForwardingTelegramMedia(holder).download('file', 'destination', new AbortController().signal),
    ).rejects.toThrow('this process has no Telegram media transport');

    const identity = new TelegramConnectionIdentity(holder);
    expect(identity).toMatchObject({ id: 0n, displayName: PLAYGROUND_BOT_DISPLAY_NAME, username: null });

    const api = {
      sendMessage: async () => ({ message_id: 7, date: 100, chat: { id: 1 } }),
    } as unknown as Api;
    holder.set({ api, token: 'token', me: { id: 42, first_name: 'Fixture', username: 'fixture_bot' } });
    expect(identity).toMatchObject({ id: 42n, displayName: 'Fixture', username: 'fixture_bot' });

    const delivered = await host.delivery.deliver(request);
    expect(delivered).toEqual({
      kind: 'delivered',
      recordedByHost: false,
      messages: [{ partIndex: 0, messageId: 7n, sentAtSeconds: 100 }],
    });

    holder.set(undefined);
    expect(await host.delivery.deliver(request)).toMatchObject({
      kind: 'rejected',
      failure: { code: 'telegram_unavailable' },
    });
  });
});
