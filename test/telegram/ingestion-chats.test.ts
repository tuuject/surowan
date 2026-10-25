import { describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { groupTextUpdate, setup, stickerUpdate, textUpdate } from './ingestion-fixtures.ts';

describe('Telegram ingestion', () => {
  test('scopes ignored users to the configured chat and not sender_chat identities', async () => {
    const secondChatId = 987654321;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
      config.telegram.chats.push({
        id: secondChatId,
      });
    });
    expect(ingestion.ingest(groupTextUpdate(1, 10, 42))).toEqual({});
    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, secondChatId)).bucketId).toBeDefined();
    const senderChatUpdate: Update = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 42, is_bot: false, first_name: 'Anonymous sender' },
        sender_chat: { id: 42, type: 'channel', title: 'Channel identity' },
        text: 'sender chat message',
      },
    };
    expect(ingestion.ingest(senderChatUpdate).messageId).toBeDefined();
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    store.close();
  });

  test('inherits ignored users after a group migrates to a supergroup', async () => {
    const migratedChatId = -1001234567890;
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const migration = groupTextUpdate(1, 10, 7);
    if (migration.message === undefined) {
      throw new Error('Invalid fixture');
    }
    migration.message.chat = { id: 123456789, type: 'group', title: 'Old group' };
    migration.message.migrate_to_chat_id = migratedChatId;
    ingestion.ingest(migration);

    expect(ingestion.ingest(groupTextUpdate(2, 11, 42, migratedChatId))).toEqual({});
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('an anonymous admin message is a human message despite its placeholder bot sender', async () => {
    const { store, ingestion } = await setup();
    const anonymous: Update = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
        sender_chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        text: 'from an anonymous admin',
      },
    };
    const result = ingestion.ingest(anonymous);
    expect(result.messageId).toBeDefined();
    expect(result.bucketId).toBeDefined();
    expect(
      store.db
        .prepare<[], { telegram_type: string; is_bot: bigint }>(
          'SELECT telegram_type, is_bot FROM senders WHERE telegram_id = 123456789',
        )
        .get(),
    ).toEqual({ telegram_type: 'sender_chat', is_bot: 0n });
    // A real bot without a sender_chat is still dropped by default.
    const bot: Update = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 555, is_bot: true, first_name: 'Other', username: 'other_bot' },
        text: 'bot message',
      },
    };
    expect(ingestion.ingest(bot)).toEqual({});
    store.close();
  });

  test('authorizes the new supergroup from a migrate_from notice seen first', async () => {
    const migratedChatId = -1001234567890;
    const { store, ingestion } = await setup();
    // The notice arrives in the new supergroup, whose ID is not configured yet.
    const notice: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: migratedChatId, type: 'supergroup', title: 'Group' },
        from: { id: 7, is_bot: false, first_name: 'User 7' },
        migrate_from_chat_id: 123456789,
      },
    } as Update;
    ingestion.ingest(notice);
    expect(
      store.db.prepare<[], { new_chat_id: bigint }>('SELECT new_chat_id FROM chat_migrations').get()?.new_chat_id,
    ).toBe(BigInt(migratedChatId));
    expect(ingestion.ingest(groupTextUpdate(2, 2, 7, migratedChatId)).messageId).toBeDefined();
    store.close();
  });

  test('a migrate_from notice cannot hand on an allowlist entry the old chat never had', async () => {
    const { store, ingestion } = await setup();
    const notice: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: -1009999999999, type: 'supergroup', title: 'Other' },
        from: { id: 7, is_bot: false, first_name: 'User 7' },
        migrate_from_chat_id: 555,
      },
    } as Update;
    ingestion.ingest(notice);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM chat_migrations').get()?.count).toBe(
      0n,
    );
    expect(ingestion.ingest(groupTextUpdate(2, 2, 7, -1009999999999))).toEqual({});
    store.close();
  });

  test('requires sticker_trigger_enabled for a sticker to open a bucket', async () => {
    const disabled = await setup();
    const standalone = disabled.ingestion.ingest(stickerUpdate(1, 10));
    expect(standalone.messageId).toBeDefined();
    expect(standalone.bucketId).toBeUndefined();
    expect(disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(
      0n,
    );
    const text = disabled.ingestion.ingest(textUpdate(2, 11, 'hello'));
    const companion = disabled.ingestion.ingest(stickerUpdate(3, 12));
    expect(companion.bucketId).toBe(text.bucketId);
    expect(
      disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count,
    ).toBe(2n);
    disabled.store.close();

    const enabled = await setup((config) => {
      config.telegram.sticker_trigger_enabled = true;
    });
    expect(enabled.ingestion.ingest(stickerUpdate(4, 20)).bucketId).toBeDefined();
    enabled.store.close();
  });

  test('holds other bots messages until a human opens the next bucket', async () => {
    const botUpdate = (updateId: number, messageId: number): Update => ({
      update_id: updateId,
      message: {
        message_id: messageId,
        date: 1_700_000_000 + messageId,
        chat: { id: 123456789, type: 'supergroup', title: 'Group' },
        from: { id: 77, is_bot: true, first_name: 'OtherBot' },
        text: `beep ${messageId}`,
      },
    });
    const bucketRows = (store: SqliteStore) =>
      store.db
        .prepare<[], { bucket_id: bigint; sequence_no: bigint; telegram_message_id: bigint }>(
          `SELECT bm.bucket_id, bm.sequence_no, m.telegram_message_id
           FROM bucket_messages bm JOIN messages m ON m.id = bm.message_id
           ORDER BY bm.bucket_id, bm.sequence_no`,
        )
        .all();

    const disabled = await setup();
    expect(disabled.ingestion.ingest(botUpdate(1, 10))).toEqual({});
    expect(
      disabled.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count,
    ).toBe(0n);
    disabled.store.close();

    const { store, ingestion } = await setup((config) => {
      config.telegram.process_bot_messages = true;
    });
    const first = ingestion.ingest(botUpdate(1, 10));
    expect(first.messageId).toBeDefined();
    expect(first.bucketId).toBeUndefined();
    expect(ingestion.ingest(botUpdate(2, 11)).bucketId).toBeUndefined();
    expect(bucketRows(store)).toEqual([]);

    const human = ingestion.ingest(groupTextUpdate(3, 12, 42));
    expect(human.bucketId).toBeDefined();
    const bucketId = human.bucketId ?? 0n;
    // A bot message while the bucket is collecting simply joins it.
    expect(ingestion.ingest(botUpdate(4, 13)).bucketId).toBe(bucketId);
    expect(bucketRows(store)).toEqual([
      { bucket_id: bucketId, sequence_no: 1n, telegram_message_id: 10n },
      { bucket_id: bucketId, sequence_no: 2n, telegram_message_id: 11n },
      { bucket_id: bucketId, sequence_no: 3n, telegram_message_id: 12n },
      { bucket_id: bucketId, sequence_no: 4n, telegram_message_id: 13n },
    ]);

    // Once that bucket is consumed, later bot messages wait for the next human
    // and are adopted exactly once.
    store.db.prepare("UPDATE buckets SET state = 'running'").run();
    expect(ingestion.ingest(botUpdate(5, 14)).bucketId).toBeUndefined();
    const next = ingestion.ingest(groupTextUpdate(6, 15, 42));
    expect(next.bucketId).toBeDefined();
    expect(bucketRows(store).filter((row) => row.bucket_id === next.bucketId)).toEqual([
      { bucket_id: next.bucketId ?? 0n, sequence_no: 1n, telegram_message_id: 14n },
      { bucket_id: next.bucketId ?? 0n, sequence_no: 2n, telegram_message_id: 15n },
    ]);
    store.close();
  });
});
