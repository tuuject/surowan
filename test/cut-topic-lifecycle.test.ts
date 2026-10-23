import { afterAll, describe, expect, test } from 'vitest';
import { BotCommandService } from '../src/orchestration/bot-commands.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { sleep } from './helpers.ts';
import {
  ALICE,
  BUCKET_WINDOW_MS,
  FIRST_CHAT,
  cleanupCutTopicDirectories,
  commandUpdate,
  groupUpdate,
  invocationHistory,
  setup,
} from './cut-topic-fixtures.ts';

afterAll(cleanupCutTopicDirectories);

describe('cut_topic', () => {
  test('cut_topic interrupts the invocation that still holds the pre-cut transcript', async () => {
    // A run in flight keeps the pre-cut transcript in memory and a header snapshot
    // taken at its start, so leaving it alive let it answer from the history the
    // admin had just cut and write its stale, lower `head_seq` back over the cut.
    const { store, ingestion, configStore } = await setup();
    let abortReason: string | undefined;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const scheduler = new BucketScheduler(store, configStore, async (_invocationId, _snapshot, signal) => {
      signal.addEventListener('abort', () => {
        abortReason = (signal.reason as Error | undefined)?.message;
      });
      await gate;
      return { state: 'completed', reason: 'done' };
    });
    const commands = new BotCommandService(store, configStore, scheduler);
    try {
      scheduler.start();
      // Backdated so the bucket is already past its window and launches at once.
      ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), new Date(Date.now() - BUCKET_WINDOW_MS - 1_000));
      scheduler.wake();
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get() ===
          undefined
      ) {
        await sleep(10);
      }
      expect(
        store.db.prepare<[], { id: bigint }>("SELECT id FROM invocations WHERE state = 'running' LIMIT 1").get(),
      ).not.toBeUndefined();

      const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date()).command;
      expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('清空');
      expect(abortReason).toBe('context_cut');
    } finally {
      release();
      await scheduler.stop();
      store.close();
    }
  }, 30_000);

  test('the cutoff survives scheduler and command service recreation', async () => {
    const { store, ingestion, scheduler, commands, configStore } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    const command = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    await commands.run(command!, FIRST_CHAT, ALICE);
    await scheduler.stop();

    const reopened = new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    }));
    const recreatedCommands = new BotCommandService(store, configStore, reopened);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(11n);
    recreatedCommands.run({ name: 'cut_topic', messageId: 20n }, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(20n);
    expect(
      invocationHistory(
        store,
        ingestion,
        reopened,
        FIRST_CHAT,
        3,
        21,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    await reopened.stop();
    store.close();
  });

  test('an older cut_topic never moves the cutoff backwards', async () => {
    const { store, ingestion, commands } = await setup();
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), new Date('2026-08-15T00:00:00.000Z'));
    await commands.run({ name: 'cut_topic', messageId: 20n }, FIRST_CHAT, ALICE);
    await commands.run({ name: 'cut_topic', messageId: 15n }, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(20n);
    store.close();
  });
});
