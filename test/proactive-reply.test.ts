import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RawConfig } from '../src/platform/config.ts';
import {
  proactiveReplyProbability,
  resolveProactiveReply,
  type ProactiveReplySettings,
} from '../src/platform/proactive-reply.ts';
import {
  PRIVATE,
  START,
  attempt,
  enabled,
  groupMessage,
  invocationCount,
  resetHarness,
  sampledEvents,
  setup,
  state,
} from './proactive-reply-harness.ts';

afterEach(async () => {
  await resetHarness();
});

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
});
