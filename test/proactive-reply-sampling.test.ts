import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FileConfig } from '../src/platform/config.ts';
import {
  GROUP_A,
  GROUP_B,
  START,
  WINDOW_MS,
  attempt,
  bypassedEvents,
  commandUpdate,
  enabled,
  groupMessage,
  mentionFields,
  replyFields,
  resetHarness,
  setup,
  state,
  type LooseFields,
} from './proactive-reply-harness.ts';

afterEach(async () => {
  await resetHarness();
});

describe('proactive reply probability', () => {
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
});
