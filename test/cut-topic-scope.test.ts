import { afterAll, describe, expect, test } from 'vitest';
import {
  ALICE,
  BUCKET_WINDOW_MS,
  FIRST_CHAT,
  SECOND_CHAT,
  cleanupCutTopicDirectories,
  commandUpdate,
  completeInvocation,
  forumUpdate,
  groupUpdate,
  invocationHistory,
  setup,
} from './cut-topic-fixtures.ts';

afterAll(cleanupCutTopicDirectories);

describe('cut_topic', () => {
  test('the cutoff only affects its own chat', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(groupUpdate(1, 10, `polluted ${FIRST_CHAT}`, FIRST_CHAT), start);
    ingestion.ingest(groupUpdate(2, 10, `polluted ${SECOND_CHAT}`, SECOND_CHAT), start);
    const command = ingestion.ingest(commandUpdate(3, 11, FIRST_CHAT), new Date(start.getTime() + 1_000)).command;
    await commands.run(command!, FIRST_CHAT, ALICE);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(1n);

    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        FIRST_CHAT,
        4,
        12,
        'trigger',
        new Date(start.getTime() + BUCKET_WINDOW_MS + 2_000),
      ),
    ).toEqual([]);
    expect(
      invocationHistory(
        store,
        ingestion,
        scheduler,
        SECOND_CHAT,
        5,
        13,
        'trigger',
        new Date(start.getTime() + 2 * BUCKET_WINDOW_MS + 4_000),
      ),
    ).toEqual([`polluted ${SECOND_CHAT}`]);
    store.close();
  });

  test('non-admin senders are denied and no cutoff row is written', async () => {
    const { store, ingestion, commands } = await setup();
    const command = ingestion.ingest(commandUpdate(1, 10, FIRST_CHAT), new Date()).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 10n });
    expect(await commands.run(command!, FIRST_CHAT, { id: 99n, name: 'Mallory', username: 'mallory' })).toBe(
      '该命令仅对本 Bot 的管理员可用。',
    );
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(0n);
    store.close();
  });

  test("cut_topic in one forum topic leaves the other topics' history alone", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);
    ingestion.ingest(forumUpdate(1, 10, 'topic A old', 100), at(0));
    ingestion.ingest(forumUpdate(2, 11, 'topic B old', 200), at(1));
    for (const id of scheduler.processDue(at(60))) {
      completeInvocation(store, id, at(61));
    }
    for (const id of scheduler.processDue(at(62))) {
      completeInvocation(store, id, at(63));
    }
    const commandUpdate = forumUpdate(3, 12, '/cut_topic', 100);
    commandUpdate.message!.entities = [{ offset: 0, length: 10, type: 'bot_command' }];
    const command = ingestion.ingest(commandUpdate, at(70)).command;
    expect(command).toEqual({ name: 'cut_topic', messageId: 12n, threadId: 100n });
    await commands.run(command!, FIRST_CHAT, ALICE);
    expect(
      store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversation_context_cutoffs').get()
        ?.count,
    ).toBe(1n);

    const historyOf = (updateId: number, messageId: number, threadId: number, seconds: number): string[] => {
      ingestion.ingest(forumUpdate(updateId, messageId, 'trigger', threadId), at(seconds));
      const [invocationId] = scheduler.processDue(at(seconds + 20));
      if (invocationId === undefined) {
        throw new Error(`Expected an invocation for topic ${threadId}`);
      }
      completeInvocation(store, invocationId, at(seconds + 21));
      return store.db
        .prepare<[bigint], { snapshot_json: string }>(
          "SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ? AND section = 'history' ORDER BY sequence_no",
        )
        .all(invocationId)
        .map((row) => (JSON.parse(row.snapshot_json) as { text: string | null }).text ?? '');
    };
    expect(historyOf(4, 13, 100, 80)).toEqual([]);
    expect(historyOf(5, 14, 200, 120)).toEqual(['topic B old']);
    store.close();
  });
});
