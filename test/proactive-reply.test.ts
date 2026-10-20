import { afterEach, describe, expect, test, vi, type Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import {
  proactiveReplyProbability,
  resolveProactiveReply,
  type ProactiveReplySettings,
} from '../src/platform/proactive-reply.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { chatPause } from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

const GROUP_A = -1_001_234_567_890;
const GROUP_B = -1_001_234_567_891;
const PRIVATE = 123_456_789;
const BOT_ID = 999;
const BOT_USERNAME = 'PlasticWanBot';
const WINDOW_MS = 15_000;
const START = new Date('2026-08-15T00:00:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

type LooseFields = Record<string, unknown>;

interface Harness {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly random: Mock<() => number>;
}

async function setup(
  options: {
    readonly transform?: (config: FileConfig) => void;
    readonly random?: () => number;
    readonly twoGroups?: boolean;
  } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-proactive-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.bucket_window_seconds = 15;
    config.telegram.chats = [
      { id: GROUP_A, instructions_file: 'chat-instructions.md' },
      ...(options.twoGroups === true ? [{ id: GROUP_B, instructions_file: 'chat-instructions.md' }] : []),
    ];
    options.transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const random = vi.fn(options.random ?? (() => 0.99));
  const scheduler = new BucketScheduler(
    store,
    configStore,
    async () => ({ state: 'completed', reason: 'done' }),
    undefined,
    undefined,
    { bot: { id: BigInt(BOT_ID), username: BOT_USERNAME }, random },
  );
  return {
    store,
    loaded,
    configStore,
    ingestion: new TelegramIngestion(store, configStore, { id: BOT_ID, username: BOT_USERNAME }),
    scheduler,
    random,
  };
}

function groupMessage(updateId: number, messageId: number, fields: LooseFields = {}, chatId = GROUP_A): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: `Group ${chatId}` },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `message ${messageId}`,
      ...fields,
    },
  } as unknown as Update;
}

function privateMessage(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: PRIVATE, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `private ${messageId}`,
    },
  } as unknown as Update;
}

function commandUpdate(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/status',
      entities: [{ offset: 0, length: 7, type: 'bot_command' }],
    },
  } as unknown as Update;
}

function mentionFields(): LooseFields {
  return {
    text: `@${BOT_USERNAME} ping`,
    entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
  };
}

function replyFields(): LooseFields {
  return {
    text: 'replying to you',
    reply_to_message: {
      message_id: 900,
      date: 1_700_000_000,
      chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
      from: { id: BOT_ID, is_bot: true, first_name: 'PlasticWan' },
      text: 'earlier',
    },
  };
}

type ProactiveReplyFixture = {
  enabled: boolean;
  base_probability: number;
  increment: number;
  hard_pity: number;
};

function enabled(overrides: Partial<ProactiveReplyFixture> = {}): ProactiveReplyFixture {
  return {
    enabled: true,
    base_probability: 0.2,
    increment: 0.1,
    hard_pity: 8,
    ...overrides,
  };
}

function invocationCount(store: SqliteStore): number {
  return Number(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count ?? 0n,
  );
}

function state(store: SqliteStore): { misses: bigint; fingerprint: string } | undefined {
  return store.db
    .prepare<[], { misses: bigint; fingerprint: string }>(
      'SELECT consecutive_misses AS misses, settings_fingerprint AS fingerprint FROM proactive_reply_state',
    )
    .get();
}

function logEvents(
  log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
  eventName: string,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const call of log.mock.calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(call[0]));
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const event = parsed as Record<string, unknown>;
      if (event.event === eventName) {
        events.push(event);
      }
    }
  }
  return events;
}

function sampledEvents(log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  return logEvents(log, 'agent_proactive_reply_sampled');
}

function bypassedEvents(log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  return logEvents(log, 'agent_proactive_reply_bypassed');
}

/** Ingest one message and run the due pass for its window. */
function attempt(
  harness: Harness,
  update: Update,
  receivedAt: Date,
): { bucketId: bigint | undefined; invocations: readonly bigint[] } {
  const { bucketId } = harness.ingestion.ingest(update, receivedAt);
  return {
    bucketId,
    invocations: harness.scheduler.processDue(new Date(receivedAt.getTime() + WINDOW_MS)),
  };
}

describe('proactive reply probability', () => {
  test('increments from the base chance and hard pity always hits', () => {
    const settings: ProactiveReplySettings = {
      enabled: true,
      base_probability: 0.2,
      increment: 0.1,
      hard_pity: 8,
    };
    const probabilities = Array.from({ length: 8 }, (_, index) => proactiveReplyProbability(index + 1, settings));
    expect(probabilities).toHaveLength(8);
    for (const [index, expected] of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1].entries()) {
      expect(probabilities[index], `attempt ${index + 1}`).toBeCloseTo(expected, 10);
    }
    expect(proactiveReplyProbability(20, settings)).toBe(1);
    expect(proactiveReplyProbability(1, { ...settings, base_probability: 1 })).toBe(1);
  });

  test('resolves global values and Chat overrides field by field', () => {
    const config = {
      telegram: {
        proactive_reply: { enabled: true, base_probability: 0.4 },
      },
    } as unknown as Pick<RawConfig, 'telegram'>;
    expect(resolveProactiveReply(config)).toEqual({
      enabled: true,
      base_probability: 0.4,
      increment: 0.1,
      hard_pity: 8,
    });
    expect(resolveProactiveReply(config, { proactive_reply: { base_probability: 0.05, hard_pity: 3 } })).toEqual({
      enabled: true,
      base_probability: 0.05,
      increment: 0.1,
      hard_pity: 3,
    });
    expect(resolveProactiveReply({ telegram: {} } as unknown as Pick<RawConfig, 'telegram'>)).toEqual({
      enabled: false,
      base_probability: 0.2,
      increment: 0.1,
      hard_pity: 8,
    });
  });

  test('rejects proactive settings on private chats and out-of-range values', async () => {
    await expect(
      setup({
        transform: (config) => {
          config.telegram.chats = [
            { id: PRIVATE, instructions_file: 'chat-instructions.md', proactive_reply: enabled() },
          ];
        },
      }),
    ).rejects.toThrow(/private chat and cannot configure proactive_reply/);
    await expect(
      setup({
        transform: (config) => {
          config.telegram.proactive_reply = { base_probability: 1.5 };
        },
      }),
    ).rejects.toThrow();
    await expect(
      setup({
        transform: (config) => {
          config.telegram.proactive_reply = { hard_pity: 0 };
        },
      }),
    ).rejects.toThrow();
  });

  test('disabled by default keeps the previous behavior and writes no counter', async () => {
    const harness = await setup();
    const { invocations } = attempt(harness, groupMessage(1, 10), START);
    expect(invocations).toHaveLength(1);
    expect(invocationCount(harness.store)).toBe(1);
    expect(state(harness.store)).toBeUndefined();
    expect(harness.random).not.toHaveBeenCalled();
    harness.store.close();
  });

  test('a miss creates no Invocation; a later hit resets the counter', async () => {
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
      random: () => 0.6,
    });
    const first = attempt(harness, groupMessage(1, 10), START);
    expect(first.invocations).toHaveLength(0);
    expect(invocationCount(harness.store)).toBe(0);
    expect(state(harness.store)?.misses).toBe(1n);
    const firstBucket = harness.store.db
      .prepare<[bigint], { state: string; error_code: string }>('SELECT state, error_code FROM buckets WHERE id = ?')
      .get(first.bucketId ?? 0n);
    expect(firstBucket).toEqual({ state: 'skipped_budget', error_code: 'proactive_reply_skipped' });

    harness.random.mockReturnValue(0.25);
    const second = attempt(harness, groupMessage(2, 11), new Date(START.getTime() + 20_000));
    expect(second.invocations).toHaveLength(1);
    expect(invocationCount(harness.store)).toBe(1);
    expect(state(harness.store)?.misses).toBe(0n);
    harness.store.close();
  });

  test('consecutive misses increment the chance and the eighth attempt hits by pity', async () => {
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
      random: () => 0.99,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (let index = 1; index <= 7; index += 1) {
      const result = attempt(
        harness,
        groupMessage(index, index + 10),
        new Date(START.getTime() + (index - 1) * 20_000),
      );
      expect(result.invocations, `attempt ${index}`).toHaveLength(0);
      expect(state(harness.store)?.misses).toBe(BigInt(index));
    }
    const pity = attempt(harness, groupMessage(8, 18), new Date(START.getTime() + 7 * 20_000));
    expect(pity.invocations).toHaveLength(1);
    expect(invocationCount(harness.store)).toBe(1);
    expect(state(harness.store)?.misses).toBe(0n);

    const samples = sampledEvents(log);
    expect(samples).toHaveLength(8);
    for (const [index, expected] of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1].entries()) {
      expect(Number(samples[index]?.probability), `attempt ${index + 1}`).toBeCloseTo(expected, 10);
    }
    expect(samples.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(samples.at(-1)).toMatchObject({ hit: true, hard_pity: true, consecutive_misses_before: 7 });
    harness.store.close();
  });

  test('a whole debounced batch gets one sample, and a direct cue inside it bypasses the gate', async () => {
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
      random: () => 0.99,
    });
    for (const [index, offset] of [0, 1_000, 2_000, 3_000, 4_000].entries()) {
      const result = harness.ingestion.ingest(groupMessage(index + 1, index + 10), new Date(START.getTime() + offset));
      expect(result.bucketId).toBeDefined();
    }
    expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toHaveLength(0);
    expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toHaveLength(0);
    expect(harness.random).toHaveBeenCalledTimes(1);
    expect(state(harness.store)?.misses).toBe(1n);
    expect(
      Number(
        harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count ??
          0n,
      ),
    ).toBe(5);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    harness.ingestion.ingest(groupMessage(6, 20), new Date(START.getTime() + 20_000));
    const direct = attempt(harness, groupMessage(7, 21, mentionFields()), new Date(START.getTime() + 20_000));
    expect(direct.invocations).toHaveLength(1);
    expect(harness.random).toHaveBeenCalledTimes(1);
    expect(state(harness.store)?.misses).toBe(1n);
    expect(bypassedEvents(log)).toMatchObject([{ trigger_kind: 'mention' }]);
    harness.store.close();
  });

  test('direct mentions, replies and keywords bypass sampling without changing the counter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cases: readonly {
      readonly name: string;
      readonly fields: LooseFields;
      readonly transform?: (config: FileConfig) => void;
    }[] = [
      { name: 'mention', fields: mentionFields() },
      { name: 'reply', fields: replyFields() },
      {
        name: 'keyword',
        fields: { text: '塑料碗在吗' },
        transform: (config) => {
          config.telegram.participation = {
            active_windows: [{ start: '00:00', end: '24:00' }],
            trigger_keywords: ['塑料碗'],
          };
        },
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const harness = await setup({
        transform: (config) => {
          config.telegram.proactive_reply = enabled();
          entry.transform?.(config);
        },
        random: () => 0.99,
      });
      // Two misses establish a non-zero counter that the direct cue must not touch.
      attempt(harness, groupMessage(index * 10 + 1, index * 10 + 10), START);
      attempt(harness, groupMessage(index * 10 + 2, index * 10 + 11), new Date(START.getTime() + 20_000));
      expect(state(harness.store)?.misses).toBe(2n);
      const calls = harness.random.mock.calls.length;
      const direct = attempt(
        harness,
        groupMessage(index * 10 + 3, index * 10 + 12, entry.fields),
        new Date(START.getTime() + 40_000),
      );
      expect(direct.invocations, entry.name).toHaveLength(1);
      expect(harness.random, entry.name).toHaveBeenCalledTimes(calls);
      expect(state(harness.store)?.misses, entry.name).toBe(2n);
      harness.store.close();
    }
  });

  test('bot commands never enter bucket scheduling and leave the counter untouched', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
    });
    const result = harness.ingestion.ingest(commandUpdate(1, 10), START);
    expect(result.command?.name).toBe('status');
    expect(result.bucketId).toBeUndefined();
    expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toHaveLength(0);
    expect(state(harness.store)).toBeUndefined();
    expect(harness.random).not.toHaveBeenCalled();
    harness.store.close();
  });

  test('counters are isolated per group', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rolls = [0.99, 0.0];
    const harness = await setup({
      twoGroups: true,
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
      random: () => rolls.shift() ?? 0.99,
    });
    expect(attempt(harness, groupMessage(1, 10, {}, GROUP_A), START).invocations).toHaveLength(0);
    expect(
      attempt(harness, groupMessage(2, 11, {}, GROUP_B), new Date(START.getTime() + 20_000)).invocations,
    ).toHaveLength(1);
    const rows = harness.store.db
      .prepare<[], { telegram_chat_id: bigint; consecutive_misses: bigint }>(
        `SELECT c.telegram_chat_id, s.consecutive_misses
         FROM proactive_reply_state s JOIN chats c ON c.id = s.chat_id`,
      )
      .all();
    const missesByChat = new Map(rows.map((row) => [row.telegram_chat_id, row.consecutive_misses]));
    expect(missesByChat.get(BigInt(GROUP_A))).toBe(1n);
    expect(missesByChat.get(BigInt(GROUP_B))).toBe(0n);
    harness.store.close();
  });

  test('the counter survives a restart and continues the attempt sequence', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
    });
    expect(attempt(harness, groupMessage(1, 10), START).invocations).toHaveLength(0);
    expect(state(harness.store)?.misses).toBe(1n);
    harness.store.close();

    const reopened = await SqliteStore.open(harness.loaded.config);
    const random = vi.fn(() => 0.25);
    const scheduler = new BucketScheduler(
      reopened,
      harness.configStore,
      async () => ({ state: 'completed', reason: 'done' }),
      undefined,
      undefined,
      { bot: { id: BigInt(BOT_ID), username: BOT_USERNAME }, random },
    );
    const ingestion = new TelegramIngestion(reopened, harness.configStore, {
      id: BOT_ID,
      username: BOT_USERNAME,
    });
    const result = ingestion.ingest(groupMessage(2, 11), new Date(START.getTime() + 20_000));
    expect(result.bucketId).toBeDefined();
    expect(scheduler.processDue(new Date(START.getTime() + 20_000 + WINDOW_MS))).toHaveLength(1);
    expect(random).toHaveBeenCalledTimes(1);
    expect(invocationCount(reopened)).toBe(1);
    expect(state(reopened)?.misses).toBe(0n);
    reopened.close();
  });

  test('turning the feature off and on again preserves the counter', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
    });
    attempt(harness, groupMessage(1, 10), START);
    attempt(harness, groupMessage(2, 11), new Date(START.getTime() + 20_000));
    expect(state(harness.store)?.misses).toBe(2n);

    const current = harness.configStore.current();
    const disabledConfig = structuredClone(current.config);
    disabledConfig.telegram.proactive_reply = enabled({ enabled: false });
    harness.configStore.publish({ ...current, config: disabledConfig, hash: 'disabled' });
    // Disabled: ordinary chatter proceeds directly to a normal Invocation.
    const disabledResult = attempt(harness, groupMessage(3, 12), new Date(START.getTime() + 40_000));
    expect(disabledResult.invocations).toHaveLength(1);
    expect(state(harness.store)?.misses).toBe(2n);
    const disabledInvocation = disabledResult.invocations[0];
    if (disabledInvocation === undefined || disabledResult.bucketId === undefined) {
      throw new Error('Expected the disabled-mode invocation');
    }
    harness.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(disabledInvocation);
    harness.store.db.prepare("UPDATE buckets SET state = 'completed' WHERE id = ?").run(disabledResult.bucketId);

    const reenabled = structuredClone(current.config);
    harness.configStore.publish({ ...current, config: reenabled, hash: 'reenabled' });
    harness.random.mockReturnValue(0.45);
    const result = attempt(harness, groupMessage(4, 13), new Date(START.getTime() + 60_000));
    expect(result.invocations).toHaveLength(0);
    expect(sampledEvents(log).at(-1)).toMatchObject({
      attempt: 3,
      probability: 0.4,
      consecutive_misses_before: 2,
      state_reset: false,
    });
    harness.store.close();
  });

  test('a changed parameter set resets the counter on the next sample', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
    });
    attempt(harness, groupMessage(1, 10), START);
    attempt(harness, groupMessage(2, 11), new Date(START.getTime() + 20_000));
    expect(state(harness.store)?.misses).toBe(2n);

    const current = harness.configStore.current();
    const next = structuredClone(current.config);
    next.telegram.proactive_reply = enabled({ increment: 0.2 });
    harness.configStore.publish({ ...current, config: next, hash: 'changed' });

    harness.random.mockReturnValue(0.25);
    const result = attempt(harness, groupMessage(3, 12), new Date(START.getTime() + 40_000));
    expect(result.invocations).toHaveLength(0);
    expect(state(harness.store)?.misses).toBe(1n);
    expect(sampledEvents(log).at(-1)).toMatchObject({
      attempt: 1,
      probability: 0.2,
      consecutive_misses_before: 0,
      state_reset: true,
    });
    harness.store.close();
  });

  test('buckets arriving during a long-lived run are sampled once before attach', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const injections: bigint[] = [];
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
      },
      random: vi.fn(() => 0.99),
    });
    // First sample hits so a running invocation exists.
    harness.random.mockReturnValueOnce(0);
    const first = attempt(harness, groupMessage(1, 10), START);
    expect(first.invocations).toHaveLength(1);
    const invocationId = first.invocations[0];
    if (invocationId === undefined || first.bucketId === undefined) {
      throw new Error('Expected the first invocation');
    }
    harness.store.db.prepare("UPDATE invocations SET state = 'running' WHERE id = ?").run(invocationId);
    harness.store.db.prepare("UPDATE buckets SET state = 'running' WHERE id = ?").run(first.bucketId);

    const scheduler = new BucketScheduler(
      harness.store,
      harness.configStore,
      async () => ({ state: 'completed', reason: 'done' }),
      {
        isClosing: () => false,
        isRoundInProgress: () => false,
        queueInjection: (_conversationId, bucketId) => injections.push(bucketId),
      },
      undefined,
      { bot: { id: BigInt(BOT_ID), username: BOT_USERNAME }, random: harness.random },
    );

    // Ordinary chatter: one sample, a miss, and no injection into the running run.
    harness.ingestion.ingest(groupMessage(2, 11), new Date(START.getTime() + 20_000));
    expect(scheduler.processDue(new Date(START.getTime() + 20_000 + WINDOW_MS))).toHaveLength(0);
    expect(injections).toHaveLength(0);
    expect(harness.random).toHaveBeenCalledTimes(2);
    expect(state(harness.store)?.misses).toBe(1n);

    // A mention in the next batch is direct and may attach.
    harness.ingestion.ingest(groupMessage(3, 12, mentionFields()), new Date(START.getTime() + 40_000));
    expect(scheduler.processDue(new Date(START.getTime() + 40_000 + WINDOW_MS))).toHaveLength(0);
    expect(injections).toHaveLength(1);
    expect(harness.random).toHaveBeenCalledTimes(2);
    expect(state(harness.store)?.misses).toBe(1n);
    harness.store.close();
  });

  test('private chats, paused chats and the participation gate keep their own semantics', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      transform: (config) => {
        config.telegram.proactive_reply = enabled();
        config.telegram.chats.push({ id: PRIVATE, instructions_file: 'chat-instructions.md' });
        config.telegram.participation = { active_windows: [{ start: '09:00', end: '10:00' }] };
      },
    });
    expect(attempt(harness, privateMessage(1, 10), START).invocations).toHaveLength(1);
    expect(state(harness.store)).toBeUndefined();
    expect(harness.random).not.toHaveBeenCalled();

    // Outside the active period an ordinary group message opens no bucket at all.
    expect(attempt(harness, groupMessage(2, 11), new Date(START.getTime() + 20_000)).invocations).toHaveLength(0);
    expect(harness.random).not.toHaveBeenCalled();

    // A direct cue still opens one, and bypasses sampling.
    expect(
      attempt(harness, groupMessage(3, 12, mentionFields()), new Date(START.getTime() + 40_000)).invocations,
    ).toHaveLength(1);
    expect(harness.random).not.toHaveBeenCalled();

    const chatId = harness.store.db
      .prepare<[bigint], { id: bigint }>('SELECT id FROM chats WHERE telegram_chat_id = ?')
      .get(BigInt(GROUP_A))?.id;
    if (chatId === undefined) {
      throw new Error('Group chat row missing');
    }
    harness.store.orm
      .insert(chatPause)
      .values({ chatId, pausedAt: new Date(START.getTime() + 50_000).toISOString() })
      .run();
    expect(attempt(harness, groupMessage(4, 13), new Date(START.getTime() + 60_000)).invocations).toHaveLength(0);
    expect(harness.random).not.toHaveBeenCalled();
    expect(state(harness.store)).toBeUndefined();
    harness.store.close();
  });
});
