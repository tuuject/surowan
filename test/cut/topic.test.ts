import { afterAll, describe, expect, test } from 'vitest';
import {
  ALICE,
  BUCKET_WINDOW_MS,
  FIRST_CHAT,
  cleanupCutTopicDirectories,
  commandUpdate,
  groupUpdate,
  invocationHistory,
  setup,
} from './topic-fixtures.ts';

afterAll(cleanupCutTopicDirectories);

describe('cut_topic', () => {
  test('without a cutoff, history includes earlier messages unchanged', async () => {
    const { store, ingestion, scheduler } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'old', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'later', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      3,
      12,
      'trigger',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 1_000),
    );
    expect(history).toEqual(['old', 'later']);
    store.close();
  });

  test('cut_topic excludes the command message and everything before it from new invocations', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 11, 'still old', FIRST_CHAT), new Date(start.getTime() + 1_000));
    const command = ingestion.ingest(commandUpdate(3, 12, FIRST_CHAT), new Date(start.getTime() + 2_000)).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 12n });
    expect(await commands.run(command!, FIRST_CHAT, ALICE)).toContain('已切掉');
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(12n);

    const history = invocationHistory(
      store,
      ingestion,
      scheduler,
      FIRST_CHAT,
      4,
      13,
      'after cut',
      new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
    );
    expect(history).toEqual([]);
    store.close();
  });

  test('messages after the cutoff remain and re-running cut_topic moves the cutoff forward', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);

    ingestion.ingest(groupUpdate(1, 10, 'polluted', FIRST_CHAT), at(0));
    const first = ingestion.ingest(commandUpdate(2, 11, FIRST_CHAT), at(1)).command;
    await commands.run(first!, FIRST_CHAT, ALICE);

    // After the first cut, the trigger itself is the only eligible message and
    // sits in its own bucket, so the frozen history is empty.
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 3, 12, 'fresh start', at(17))).toEqual([]);

    const second = ingestion.ingest(commandUpdate(4, 13, FIRST_CHAT), at(34)).command;
    await commands.run(second!, FIRST_CHAT, ALICE);
    expect(
      store.db
        .prepare<[], { telegram_message_id: bigint }>('SELECT telegram_message_id FROM conversation_context_cutoffs')
        .get()?.telegram_message_id,
    ).toBe(13n);

    // A message arriving after the second cut stays eligible for later sessions.
    ingestion.ingest(groupUpdate(5, 14, 'between', FIRST_CHAT), at(50));
    expect(invocationHistory(store, ingestion, scheduler, FIRST_CHAT, 6, 15, 'new topic', at(66))).toEqual(['between']);
    store.close();
  });
});
