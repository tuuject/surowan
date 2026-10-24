/**
 * Harness for the Telegram connection manager: a real SQLite store, a real
 * connection registry and a fake grammY bot that never reaches the network.
 *
 * The fake records what the manager asks of it (`getMe`, command registration,
 * webhook removal, long polling, offset confirmation), which is how the tests
 * assert that a replaced connection leaks no polling loop and that a stopped
 * one never started.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { vi } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  TelegramConnectionManager,
  type TelegramConnectionHooks,
  type TelegramConnectionManagerOptions,
} from '../src/adapters/local-monolith/telegram-connection.ts';
import { TelegramReadiness } from '../src/adapters/local-monolith/telegram-connection-support.ts';
import type { TelegramIdentity } from '../src/adapters/local-monolith/telegram-instance.ts';
import { TelegramInstanceHolder } from '../src/adapters/local-monolith/telegram-instance.ts';
import { ImConnectionRegistry, type ImConnectionState } from '../src/platform/im-connection.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import type { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import type { StickerService } from '../src/capabilities/stickers.ts';
import {
  buckets,
  chats,
  conversations,
  invocationBuckets,
  invocations,
  longTasks,
  taskReceipts,
} from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

export type FixtureTokenMode = 'jar' | 'absent' | 'unreadable';

export interface FakeGetUpdatesOutcome {
  readonly updates?: readonly unknown[];
  readonly error?: unknown;
}

type Transformer = (
  prev: (method: string, payload: unknown, signal?: unknown) => Promise<unknown>,
  method: string,
  payload: unknown,
  signal?: unknown,
) => Promise<unknown>;

/** One grammY Bot as the manager sees it. */
export class FakeTelegramBot {
  readonly token: string;
  readonly api: Record<string, unknown>;
  botInfo: unknown;
  started = false;
  stopped = false;
  stopCount = 0;
  webhookOptions: { readonly drop_pending_updates?: boolean } | undefined;
  commandsRegistered = false;
  startError: unknown;
  getUpdatesError: unknown;
  /** Set by the factory before the manager starts polling. */
  updateHandler: ((context: unknown) => unknown) | undefined;
  #transformer: Transformer | undefined;
  #settle: (() => void) | undefined;

  constructor(token: string, getMe: () => Promise<unknown>) {
    this.token = token;
    this.api = {
      config: {
        use: (transformer: Transformer) => {
          this.#transformer = transformer;
        },
      },
      getMe,
      setMyCommands: async () => {
        this.commandsRegistered = true;
        return true;
      },
      deleteWebhook: async (options: { readonly drop_pending_updates?: boolean }) => {
        this.webhookOptions = options;
        return true;
      },
    };
  }

  use(handler: (context: unknown) => unknown): void {
    this.updateHandler = handler;
  }

  start(): Promise<void> {
    this.started = true;
    if (this.startError !== undefined) {
      return Promise.reject(this.startError);
    }
    return new Promise<void>((resolve) => {
      this.#settle = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopCount += 1;
    this.#settle?.();
    this.#settle = undefined;
  }

  /** Runs one `getUpdates` through the installed transformer, as grammY would. */
  getUpdates(outcome: FakeGetUpdatesOutcome = {}): Promise<unknown> {
    const transformer = this.#transformer;
    if (transformer === undefined) {
      throw new Error('the manager did not install a getUpdates observer');
    }
    const prev = async (): Promise<unknown> => {
      if (outcome.error !== undefined) {
        throw outcome.error;
      }
      return outcome.updates ?? [];
    };
    return transformer(prev, 'getUpdates', {});
  }

  /** Fails long polling without going through the `bot.start` rejection. */
  failPolling(error: unknown): Promise<unknown> {
    return this.getUpdates({ error });
  }
}

export class FakeStickers {
  synced = 0;
  started = 0;
  stops = 0;

  async sync(): Promise<void> {
    this.synced += 1;
  }

  start(): void {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

export interface FixtureOptions {
  readonly token?: FixtureTokenMode;
  /** One entry per Bot the manager creates; the last one is reused. */
  readonly getMe?: readonly (() => Promise<unknown>)[];
  readonly startError?: (bot: FakeTelegramBot) => unknown;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly withStickers?: boolean;
  readonly abortInvocations?: (ids: readonly bigint[], reason: string) => number;
  readonly abortGraceMs?: number;
  /** Observes the readiness gate closing after a transition. */
  readonly onSettled?: () => void;
}

const NOW = '2026-01-01T00:00:00.000Z';

export interface ConnectionFixture {
  readonly directory: string;
  readonly configPath: string;
  readonly store: SqliteStore;
  readonly manager: TelegramConnectionManager;
  readonly holder: TelegramInstanceHolder;
  readonly connections: ImConnectionRegistry;
  readonly readiness: TelegramReadiness;
  readonly secrets: SecretStore;
  readonly bots: FakeTelegramBot[];
  readonly stickers: FakeStickers[];
  readonly sleeps: number[];
  readonly events: Record<string, unknown>[];
  readonly activityStops: number[];
  readonly aborted: { readonly ids: readonly bigint[]; readonly reason: string }[];
  readonly coldCatchUps: number[];
  readonly runtimeCatchUps: number[];
  readonly token: string;
  readonly hooks: TelegramConnectionHooks;
  status(): ImConnectionState;
  waitForStatus(predicate: (state: ImConnectionState) => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const openFixtures: ConnectionFixture[] = [];

export async function closeConnectionFixtures(): Promise<void> {
  for (const fixture of openFixtures.splice(0)) {
    await fixture.close();
  }
}

export async function openConnectionFixture(options: FixtureOptions = {}): Promise<ConnectionFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-tg-connection-'));
  const configPath = join(directory, 'config.jsonc');
  const mode = options.token ?? 'jar';
  const json = testConfigJsonc(directory, (config) => {
    const telegram = config.telegram as unknown as Record<string, unknown>;
    if (mode === 'absent') {
      delete telegram.token;
    }
    if (mode === 'unreadable') {
      telegram.token = { jar: 'not-in-the-key-jar' };
    }
  });
  await writeTestConfig(directory, configPath, json);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const configStore = await testConfigStore({ config: loaded.config, hash: loaded.hash, configPath });
  const secrets = new SecretStore(keyJarPath(configPath));
  const connections = new ImConnectionRegistry(() => new Date(NOW));
  const readiness = new TelegramReadiness(connections);
  const holder = new TelegramInstanceHolder();
  const bots: FakeTelegramBot[] = [];
  const stickers: FakeStickers[] = [];
  const sleeps: number[] = [];
  const events: Record<string, unknown>[] = [];
  const activityStops: number[] = [];
  const aborted: { ids: readonly bigint[]; reason: string }[] = [];
  const coldCatchUps: number[] = [];
  const runtimeCatchUps: number[] = [];
  const getMeQueue = [...(options.getMe ?? [])];
  const token = 'telegram-secret';
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (!line.startsWith('{')) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.event === 'string') {
        events.push(parsed);
      }
    } catch {
      // Not an event line.
    }
  });

  const managerOptions: TelegramConnectionManagerOptions = {
    store,
    configStore,
    secrets,
    connections,
    readiness,
    holder,
    createIngestion: (me) => ({ botId: me.id, ingest: () => ({}) }) as unknown as TelegramIngestion,
    ...(options.withStickers === true
      ? {
          createStickers: () => {
            const service = new FakeStickers();
            stickers.push(service);
            return service as unknown as StickerService;
          },
        }
      : {}),
    stopActivity: () => activityStops.push(Date.now()),
    abortInvocations: (ids, reason) => {
      aborted.push({ ids, reason });
      return options.abortInvocations?.(ids, reason) ?? ids.length;
    },
    createBot: (value) => {
      const next = getMeQueue.shift() ?? getMeQueue.at(-1) ?? (() => Promise.resolve(identityOf(value)));
      const bot = new FakeTelegramBot(value, next);
      if (options.startError !== undefined) {
        bot.startError = options.startError(bot);
      }
      bots.push(bot);
      return bot as unknown as Bot;
    },
    now: () => new Date(NOW),
    retry: {
      initialMs: 1,
      maxMs: 60_000,
      sleep:
        options.sleep ??
        (async (ms) => {
          sleeps.push(ms);
        }),
    },
    stopTimeoutMs: 50,
    abortGraceMs: options.abortGraceMs ?? 50,
    ...(options.onSettled === undefined ? {} : { onSettled: options.onSettled }),
  };
  const manager = new TelegramConnectionManager(managerOptions);
  const hooks: TelegramConnectionHooks = {
    onUpdate: () => undefined,
    coldCatchUp: async () => {
      coldCatchUps.push(Date.now());
    },
    runtimeCatchUp: async () => {
      runtimeCatchUps.push(Date.now());
    },
  };

  const fixture: ConnectionFixture = {
    directory,
    configPath,
    store,
    manager,
    holder,
    connections,
    readiness,
    secrets,
    bots,
    stickers,
    sleeps,
    events,
    activityStops,
    aborted,
    coldCatchUps,
    runtimeCatchUps,
    token,
    hooks,
    status: () => connections.get('telegram'),
    waitForStatus: (predicate, timeoutMs = 5_000) => waitUntil(() => predicate(connections.get('telegram')), timeoutMs),
    close: async () => {
      log.mockRestore();
      await manager.shutdown();
      store.close();
      const index = openFixtures.indexOf(fixture);
      if (index >= 0) {
        openFixtures.splice(index, 1);
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
  openFixtures.push(fixture);
  return fixture;
}

/** A deterministic getMe answer for a token. */
export function identityOf(token: string): TelegramIdentity {
  return { id: token === 'telegram-secret' ? 42 : 43, first_name: `Bot ${token}`, username: `${token}_bot` };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the Telegram connection manager');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface SeededWork {
  /** The Telegram collecting bucket, expired by a stop. */
  readonly collectingBucket: bigint;
  /** The Telegram queued bucket, expired by a stop. */
  readonly queuedBucket: bigint;
  /** The queued invocation of the queued bucket, aborted by a stop. */
  readonly queuedInvocation: bigint;
  /** A batch attached to the running invocation but not injected yet. */
  readonly attachedBucket: bigint;
  /** The running invocation the stop interrupts. */
  readonly runningInvocation: bigint;
  readonly runningReceiptTask: bigint;
  /** A Playground batch that must survive a Telegram stop untouched. */
  readonly playgroundBucket: bigint;
  readonly playgroundInvocation: bigint;
  readonly playgroundReceiptTask: bigint;
}

/**
 * Seeds one of every Telegram work state a stop must handle, plus a Playground
 * batch as the control group. Timestamps are derived from the current clock so
 * no row becomes "too old" or "still valid" by accident later.
 */
export function seedWork(store: SqliteStore): SeededWork {
  const stamp = new Date().toISOString();
  store.orm
    .insert(chats)
    .values([
      {
        id: 900n,
        hostKind: 'telegram',
        telegramChatId: 123456789n,
        canonicalChatId: 123456789n,
        type: 'private',
        updatedAt: stamp,
      },
      { id: 800n, hostKind: 'playground', type: 'group', updatedAt: stamp },
    ])
    .run();
  store.orm
    .insert(conversations)
    .values([
      { id: 900n, chatId: 900n, createdAt: stamp, updatedAt: stamp },
      { id: 800n, chatId: 800n, createdAt: stamp, updatedAt: stamp },
    ])
    .run();
  const bucket = (id: bigint, conversationId: bigint, state: string) => ({
    id,
    conversationId,
    state,
    kind: 'realtime',
    firstReceivedAt: stamp,
    deadlineAt: stamp,
    ...(state === 'queued' ? { queuedAt: stamp } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.orm
    .insert(buckets)
    .values([
      bucket(900n, 900n, 'collecting'),
      bucket(901n, 900n, 'queued'),
      bucket(902n, 900n, 'running'),
      bucket(903n, 900n, 'running'),
      bucket(800n, 800n, 'collecting'),
    ])
    .run();
  const invocation = (id: bigint, bucketId: bigint, conversationId: bigint, state: string) => ({
    id,
    bucketId,
    conversationId,
    state,
    configHash: 'fixture',
    promptVersion: 1n,
    ...(state === 'running' ? { startedAt: stamp } : {}),
    createdAt: stamp,
  });
  store.orm
    .insert(invocations)
    .values([
      invocation(901n, 901n, 900n, 'queued'),
      invocation(902n, 902n, 900n, 'running'),
      invocation(800n, 800n, 800n, 'queued'),
    ])
    .run();
  store.orm
    .insert(invocationBuckets)
    .values([
      { invocationId: 902n, bucketId: 902n, attachedAt: stamp },
      { invocationId: 902n, bucketId: 903n, attachedAt: stamp },
      { invocationId: 800n, bucketId: 800n, attachedAt: stamp },
    ])
    .run();
  const task = (id: bigint, conversationId: bigint, summary: string) => ({
    id,
    pluginId: 'alarm',
    conversationId,
    payloadJson: JSON.stringify({ summary }),
    state: 'completed' as const,
    scheduledAt: stamp,
    timerResultJson: JSON.stringify({ summary }),
    deliveryJson: '{"bypassDailyBudget":false}',
    createdAt: stamp,
    updatedAt: stamp,
  });
  store.orm
    .insert(longTasks)
    .values([
      task(901n, 900n, 'queued reminder'),
      task(902n, 900n, 'running reminder'),
      task(800n, 800n, 'room reminder'),
    ])
    .run();
  store.orm
    .insert(taskReceipts)
    .values([
      {
        taskId: 901n,
        status: 'completed',
        resultJson: '{"summary":"queued reminder"}',
        state: 'claimed',
        createdAt: stamp,
        updatedAt: stamp,
        claimedAt: stamp,
        invocationId: 901n,
        bucketId: 901n,
      },
      {
        taskId: 902n,
        status: 'completed',
        resultJson: '{"summary":"running reminder"}',
        state: 'claimed',
        createdAt: stamp,
        updatedAt: stamp,
        claimedAt: stamp,
        invocationId: 902n,
        bucketId: 902n,
      },
      {
        taskId: 800n,
        status: 'completed',
        resultJson: '{"summary":"room reminder"}',
        state: 'claimed',
        createdAt: stamp,
        updatedAt: stamp,
        claimedAt: stamp,
        invocationId: 800n,
        bucketId: 800n,
      },
    ])
    .run();
  return {
    collectingBucket: 900n,
    queuedBucket: 901n,
    queuedInvocation: 901n,
    attachedBucket: 903n,
    runningInvocation: 902n,
    runningReceiptTask: 902n,
    playgroundBucket: 800n,
    playgroundInvocation: 800n,
    playgroundReceiptTask: 800n,
  };
}

export const bucketState = (store: SqliteStore, id: bigint) =>
  store.orm
    .select({ state: buckets.state, errorCode: buckets.errorCode })
    .from(buckets)
    .where(eq(buckets.id, id))
    .get();

export const invocationState = (store: SqliteStore, id: bigint) =>
  store.orm
    .select({ state: invocations.state, completionReason: invocations.completionReason })
    .from(invocations)
    .where(eq(invocations.id, id))
    .get();

export const receiptState = (store: SqliteStore, taskId: bigint) =>
  store.orm
    .select({
      state: taskReceipts.state,
      invocationId: taskReceipts.invocationId,
      bucketId: taskReceipts.bucketId,
      claimedAt: taskReceipts.claimedAt,
      handledAt: taskReceipts.handledAt,
      cancelReason: taskReceipts.cancelReason,
    })
    .from(taskReceipts)
    .where(eq(taskReceipts.taskId, taskId))
    .get();
