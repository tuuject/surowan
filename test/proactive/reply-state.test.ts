import { afterEach, describe, expect, test, vi } from 'vitest';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { chatPause } from '../../src/store/schema/index.ts';
import {
  BOT_ID,
  GROUP_A,
  BOT_USERNAME,
  PRIVATE,
  START,
  WINDOW_MS,
  attempt,
  enabled,
  groupMessage,
  invocationCount,
  mentionFields,
  privateMessage,
  resetHarness,
  sampledEvents,
  setup,
  state,
} from './reply-harness.ts';

afterEach(async () => {
  await resetHarness();
});

describe('proactive reply probability', () => {
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
