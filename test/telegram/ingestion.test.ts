import { describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import { groupTextUpdate, setup, textUpdate } from './ingestion-fixtures.ts';

describe('Telegram ingestion', () => {
  test('stores denied metadata without content', async () => {
    const { store, ingestion } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'private text', 777));
    const row = store.db
      .prepare<[], { raw_json: string | null; rejection_reason: string }>(
        'SELECT raw_json, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(row).toEqual({ raw_json: null, rejection_reason: 'chat_not_allowed' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    store.close();
  });

  test('uses the configured window and preserves the first deadline', async () => {
    const { store, ingestion } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const firstTime = new Date('2026-08-15T00:00:00.000Z');
    const first = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const duplicate = ingestion.ingest(textUpdate(1, 10, 'first'), firstTime);
    const second = ingestion.ingest(textUpdate(2, 11, 'second'), new Date(firstTime.getTime() + 5_000));
    expect(duplicate.messageId).toBeUndefined();
    expect(first.bucketId).toBe(second.bucketId);
    const bucket = store.db
      .prepare<[], { deadline_at: string; messages: bigint }>(
        'SELECT b.deadline_at, COUNT(bm.message_id) AS messages FROM buckets b JOIN bucket_messages bm ON bm.bucket_id = b.id GROUP BY b.id',
      )
      .get();
    expect(bucket).toEqual({ deadline_at: '2026-08-15T00:00:06.000Z', messages: 2n });
    store.close();
  });

  test('waits a full window for a message that arrives while the conversation is being served', async () => {
    // Regression: with the pace rule once treating every message that arrived
    // during an active invocation as immediately due, a long-lived run consumed
    // each such bucket on the spot — one message became one zero-length bucket
    // and one injection, so the fixed window disappeared.
    const { store, ingestion } = await setup((config) => {
      config.telegram.bucket_window_seconds = 6;
    });
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'first'), start);
    // The conversation is being served right now, past its own window.
    store.db
      .prepare(
        `INSERT INTO invocations(bucket_id, conversation_id, state, config_hash, prompt_version, started_at, created_at)
         VALUES ((SELECT id FROM buckets LIMIT 1), (SELECT id FROM conversations LIMIT 1), 'running', 'hash', 1, ?, ?)`,
      )
      .run(new Date(start.getTime() + 6_000).toISOString(), start.toISOString());
    store.db
      .prepare("UPDATE buckets SET state = 'running' WHERE id = (SELECT bucket_id FROM invocations LIMIT 1)")
      .run();

    ingestion.ingest(textUpdate(2, 11, 'late arrival'), new Date(start.getTime() + 20_000));
    const bucket = store.db
      .prepare<[], { state: string; first_received_at: string; deadline_at: string }>(
        'SELECT state, first_received_at, deadline_at FROM buckets ORDER BY id DESC LIMIT 1',
      )
      .get();
    // Due one window after it arrived, not the moment it landed: the batch has
    // to be able to collect the messages that follow it.
    expect(bucket).toEqual({
      state: 'collecting',
      first_received_at: '2026-08-15T00:00:20.000Z',
      deadline_at: '2026-08-15T00:00:26.000Z',
    });
    store.close();
  });

  test('edits append revisions without creating or extending buckets', async () => {
    const { store, ingestion } = await setup();
    const receivedAt = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'before'), receivedAt);
    const edited: Update = {
      update_id: 2,
      edited_message: {
        message_id: 10,
        edit_date: 1_700_000_005,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'after',
      },
    };
    ingestion.ingest(edited, new Date(receivedAt.getTime() + 5_000));
    const row = store.db
      .prepare<[], { revisions: bigint; text: string; buckets: bigint }>(
        'SELECT (SELECT COUNT(*) FROM message_revisions) AS revisions, r.text, (SELECT COUNT(*) FROM buckets) AS buckets FROM messages m JOIN message_revisions r ON r.id = m.current_revision_id',
      )
      .get();
    expect(row).toEqual({ revisions: 2n, text: 'after', buckets: 1n });
    store.close();
  });

  test('bot and service messages cannot trigger collection', async () => {
    const { store, ingestion } = await setup();
    const botUpdate = textUpdate(1, 10, 'bot');
    if (botUpdate.message === undefined || botUpdate.message.from === undefined) {
      throw new Error('Invalid fixture');
    }
    botUpdate.message.from.is_bot = true;
    botUpdate.message.from.id = 500;
    const serviceUpdate: Update = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        new_chat_members: [{ id: 43, is_bot: false, first_name: 'Bob' }],
      },
    };
    ingestion.ingest(botUpdate);
    ingestion.ingest(serviceUpdate);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    store.close();
  });

  test('drops ignored users before commands, storage, and bucket collection', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    const trigger = ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignored = ingestion.ingest(groupTextUpdate(2, 11, 42));
    const commandUpdate = groupTextUpdate(3, 12, 42);
    if (commandUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    commandUpdate.message.text = '/pause';
    commandUpdate.message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
    const ignoredCommand = ingestion.ingest(commandUpdate);
    const replyUpdate = groupTextUpdate(4, 13, 7);
    if (replyUpdate.message === undefined) {
      throw new Error('Invalid fixture');
    }
    replyUpdate.message.text = 'reply from 7';
    replyUpdate.message.reply_to_message = {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'supergroup', title: 'Group' },
      from: { id: 42, is_bot: false, first_name: 'User 42' },
      text: 'message from 42',
      reply_to_message: undefined as never,
    };
    ingestion.ingest(replyUpdate);

    expect(trigger.bucketId).toBeDefined();
    expect(ignored).toEqual({});
    expect(ignoredCommand).toEqual({});
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM telegram_updates').get()?.count).toBe(
      4n,
    );
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM senders').get()?.count).toBe(1n);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_messages').get()?.count).toBe(
      2n,
    );
    expect(
      store.db
        .prepare<[string], { reply_to_message_id: bigint | null; reply_snapshot_json: string | null }>(
          'SELECT reply_to_message_id, reply_snapshot_json FROM message_revisions WHERE text = ?',
        )
        .get('reply from 7'),
    ).toEqual({ reply_to_message_id: null, reply_snapshot_json: null });
    store.close();
  });

  test('drops edits from ignored users without changing a stored message', async () => {
    const { store, ingestion } = await setup((config) => {
      const chat = config.telegram.chats[0];
      if (chat === undefined) {
        throw new Error('Expected chat fixture');
      }
      chat.ignored_user_ids = [42];
    });
    ingestion.ingest(groupTextUpdate(1, 10, 7));
    const ignoredEdit = groupTextUpdate(2, 10, 42);
    if (ignoredEdit.message === undefined) {
      throw new Error('Invalid fixture');
    }
    const editedMessage = ignoredEdit.message;
    const editedUpdate: Update = {
      update_id: ignoredEdit.update_id,
      edited_message: { ...editedMessage, text: 'ignored edit', edit_date: 1_700_000_010 },
    };
    expect(ingestion.ingest(editedUpdate)).toEqual({});
    expect(
      store.db
        .prepare<[], { revisions: bigint; text: string }>(
          'SELECT COUNT(*) AS revisions, MAX(text) AS text FROM message_revisions',
        )
        .get(),
    ).toEqual({ revisions: 1n, text: 'message from 7' });
    store.close();
  });
});
