import { describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import { setup } from './telegram-ingestion-fixtures.ts';

describe('Telegram ingestion', () => {
  test('keeps ordinary supergroup reply threads in the main conversation', async () => {
    const { store, ingestion } = await setup();
    const chat = { id: 123456789, type: 'supergroup' as const, title: 'Group' };
    const sender = { id: 42, is_bot: false, first_name: 'Alice' };
    const rootMessage = {
      message_id: 10,
      date: 1_700_000_000,
      chat,
      from: sender,
      text: 'root',
    };
    const first = ingestion.ingest({ update_id: 1, message: rootMessage });
    const second = ingestion.ingest({
      update_id: 2,
      message: {
        message_id: 11,
        message_thread_id: 10,
        date: 1_700_000_001,
        chat,
        from: sender,
        text: 'reply',
      },
    });
    expect(second.bucketId).toBe(first.bucketId);
    expect(
      store.db
        .prepare<[], { conversations: bigint; thread_id: bigint; messages: bigint }>(
          `SELECT COUNT(DISTINCT v.id) AS conversations, MAX(v.message_thread_id) AS thread_id,
                  COUNT(bm.message_id) AS messages
           FROM conversations v
           JOIN buckets b ON b.conversation_id = v.id
           JOIN bucket_messages bm ON bm.bucket_id = b.id`,
        )
        .get(),
    ).toEqual({ conversations: 1n, thread_id: 0n, messages: 2n });
    store.close();
  });

  test('isolates allowed forum topics and rejects unconfigured topics', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.topic_ids = [100, 200];
    });
    const topicUpdate = (updateId: number, messageId: number, threadId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        message_thread_id: threadId,
        is_topic_message: true,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: `topic-${threadId}`,
      },
    });
    ingestion.ingest(topicUpdate(1, 10, 100));
    ingestion.ingest(topicUpdate(2, 11, 200));
    ingestion.ingest(topicUpdate(3, 12, 300));
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM conversations').get()?.count).toBe(
      2n,
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(2n);
    expect(
      store.db
        .prepare<[], { reason: string }>('SELECT rejection_reason AS reason FROM telegram_updates WHERE update_id = 3')
        .get()?.reason,
    ).toBe('topic_not_allowed');
    store.close();
  });

  describe('mention signal for immediate typing', () => {
    const BOT = 'SurowanBot';
    const mentionUpdate = (
      updateId: number,
      messageId: number,
      fields: Record<string, unknown> = {},
      kind: 'message' | 'edited_message' = 'message',
    ): Update => {
      const message = {
        message_id: messageId,
        date: 1_700_000_000,
        ...(kind === 'edited_message' ? { edit_date: 1_700_000_100 } : {}),
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: `@${BOT} ping`,
        entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }],
        ...fields,
      };
      return { update_id: updateId, [kind]: message } as unknown as Update;
    };

    test('reports chat and topic for a live @mention that joined a bucket', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const result = ingestion.ingest(mentionUpdate(1, 10));
      expect(result.bucketId).toBeDefined();
      expect(result.mention).toEqual({ chatId: 123456789n, threadId: 0n });
      const topic = ingestion.ingest(
        mentionUpdate(2, 11, {
          message_thread_id: 77,
          is_topic_message: true,
          chat: { id: 123456789, type: 'supergroup', title: 'Forum', is_forum: true },
        }),
      );
      expect(topic.mention).toEqual({ chatId: 123456789n, threadId: 77n });
      store.close();
    });

    test('counts text mentions of the bot id and captions, case-insensitively', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const textMention = ingestion.ingest(
        mentionUpdate(1, 10, {
          text: 'Wan hello',
          entities: [
            { type: 'text_mention', offset: 0, length: 3, user: { id: 999, is_bot: true, first_name: 'Wan' } },
          ],
        }),
      );
      const caption = ingestion.ingest(
        mentionUpdate(2, 11, {
          text: undefined,
          caption: `@${BOT.toLowerCase()} look`,
          entities: undefined,
          caption_entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }],
        }),
      );
      expect(textMention.mention).toBeDefined();
      expect(caption.mention).toBeDefined();
      store.close();
    });

    test('stays silent for everything that is not a live human @mention of this bot', async () => {
      const { store, ingestion } = await setup(undefined, BOT);
      const other = ingestion.ingest(
        mentionUpdate(1, 10, { text: '@SomeoneElse hi', entities: [{ type: 'mention', offset: 0, length: 12 }] }),
      );
      const plain = ingestion.ingest(mentionUpdate(2, 11, { text: 'hello', entities: undefined }));
      const reply = ingestion.ingest(
        mentionUpdate(3, 12, {
          text: 'replying',
          entities: undefined,
          reply_to_message: {
            message_id: 5,
            date: 1_700_000_000,
            chat: { id: 123456789, type: 'supergroup', title: 'Group' },
            from: { id: 999, is_bot: true, first_name: 'Wan' },
            text: 'earlier',
          },
        }),
      );
      const fromBot = ingestion.ingest(mentionUpdate(4, 13, { from: { id: 555, is_bot: true, first_name: 'Other' } }));
      const edited = ingestion.ingest(mentionUpdate(5, 14, {}, 'edited_message'));
      const catchUp = ingestion.ingestCatchUp(mentionUpdate(6, 15));
      for (const result of [other, plain, reply, fromBot, edited, catchUp]) {
        expect(result.mention).toBeUndefined();
      }
      store.close();
    });

    test('stays silent while the chat is paused and when the option is turned off', async () => {
      const paused = await setup(undefined, BOT);
      paused.ingestion.ingest(mentionUpdate(1, 10, { text: 'warm up', entities: undefined }));
      paused.store.db
        .prepare("INSERT INTO chat_pause (chat_id, paused_at) SELECT id, '2026-08-15T00:00:00.000Z' FROM chats")
        .run();
      expect(paused.ingestion.ingest(mentionUpdate(2, 11)).mention).toBeUndefined();
      paused.store.close();

      const off = await setup((config) => {
        config.telegram.mention_typing_enabled = false;
      }, BOT);
      const result = off.ingestion.ingest(mentionUpdate(1, 10));
      expect(result.bucketId).toBeDefined();
      expect(result.mention).toBeUndefined();
      off.store.close();
    });

    test('a message participation keeps out of every bucket reports nothing, a mention that opens the window does', async () => {
      const { store, ingestion } = await setup((config) => {
        config.telegram.participation = { active_windows: [{ start: '00:00', end: '00:01' }] };
      }, BOT);
      const plain = ingestion.ingest(
        mentionUpdate(1, 10, { text: 'hello', entities: undefined }),
        new Date('2026-08-15T13:00:00.000Z'),
      );
      expect(plain.bucketId).toBeUndefined();
      expect(plain.mention).toBeUndefined();
      const mention = ingestion.ingest(mentionUpdate(2, 11), new Date('2026-08-15T13:00:05.000Z'));
      expect(mention.bucketId).toBeDefined();
      expect(mention.mention).toBeDefined();
      store.close();
    });
  });
});
