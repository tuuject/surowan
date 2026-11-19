/**
 * The IMH-05 acceptance isolation test: `InboundIntake` is the host-neutral
 * inbound path, so this file drives it with `InboundMessage`s built by hand —
 * no grammy import, no `Update`, no transport types anywhere. What lands in
 * the shared tables must be exactly what the Telegram edge produced before
 * the split: message, revision, media, sender, conversation, bucket and
 * attention rows, plus the eligibility drops.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { InboundIntake, type InboundMessage } from '../../src/ingress/intake/index.ts';
import { EMPTY_MESSAGE_CUES } from '../../src/platform/im-host/cues.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import { seedPlaygroundConversation } from '../im/fixtures.ts';

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterAll(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const BOT_ID = 999n;
const CHAT_ID = 7n;
const HOST_CHAT_ID = 123456789n;
const SENT_AT = new Date('2026-08-15T12:59:59.000Z');
const RECEIVED_AT = new Date('2026-08-15T13:00:00.000Z');

async function setup(transform?: (config: FixtureConfig) => void): Promise<{
  store: SqliteStore;
  configStore: RuntimeConfigurationStore;
  intake: InboundIntake;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-intake-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  // Admission is the edge's job; intake starts from the stored chat row.
  store.db
    .prepare(
      `INSERT INTO chats(id, host_kind, host_chat_id, canonical_chat_id, type, updated_at)
       VALUES (?, 'telegram', ?, ?, 'supergroup', '2026-01-01T00:00:00.000Z')`,
    )
    .run(CHAT_ID, HOST_CHAT_ID, HOST_CHAT_ID);
  return { store, configStore, intake: new InboundIntake(store, configStore, BOT_ID) };
}

/** A complete inbound message; tests override only what they exercise. */
function inbound(fields: Partial<InboundMessage> = {}): InboundMessage {
  return {
    host: 'telegram',
    internalChatId: CHAT_ID,
    hostChatId: HOST_CHAT_ID,
    chatType: 'supergroup',
    threadId: 0n,
    messageNo: 1n,
    sentAt: SENT_AT,
    receivedAt: RECEIVED_AT,
    edited: false,
    cues: EMPTY_MESSAGE_CUES,
    sender: { type: 'user', id: 42n, displayName: 'Alice', username: 'alice', isBot: false },
    fromUserId: 42n,
    service: false,
    kind: 'text',
    text: 'hello',
    caption: null,
    replyToMessageNo: null,
    replySnapshotJson: null,
    forwardOriginJson: null,
    mediaGroupId: null,
    media: [],
    rawFragmentJson: '{"message_id":1,"text":"hello"}',
    ...fields,
  };
}

function rowCount(store: SqliteStore, table: string): number {
  return Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n);
}

describe('neutral inbound intake', () => {
  test('a hand-built message is stored and opens a bucket', async () => {
    const { store, intake } = await setup();
    const result = intake.ingest(inbound());

    expect(result.messageId).toBe(1n);
    expect(result.bucketId).toBe(1n);
    expect(result.mention).toBeUndefined();

    expect(
      store.db.prepare('SELECT display_name, username, is_bot FROM senders WHERE host_sender_id = 42').all(),
    ).toEqual([{ display_name: 'Alice', username: 'alice', is_bot: 0n }]);
    expect(store.db.prepare('SELECT chat_id, message_thread_id FROM conversations').all()).toEqual([
      { chat_id: CHAT_ID, message_thread_id: 0n },
    ]);
    expect(store.db.prepare('SELECT host_kind, message_no, sent_at, received_at FROM messages').all()).toEqual([
      {
        host_kind: 'telegram',
        message_no: 1n,
        sent_at: SENT_AT.toISOString(),
        received_at: RECEIVED_AT.toISOString(),
      },
    ]);
    const revision = store.db
      .prepare('SELECT revision_no, kind, text, raw_fragment_json FROM message_revisions')
      .all() as Record<string, unknown>[];
    expect(revision).toEqual([
      { revision_no: 1n, kind: 'text', text: 'hello', raw_fragment_json: '{"message_id":1,"text":"hello"}' },
    ]);
    const current = store.db.prepare('SELECT current_revision_id AS id FROM messages').get() as { id: bigint };
    expect(current.id).toBe(1n);
    expect(store.db.prepare('SELECT state, kind FROM buckets').all()).toEqual([
      { state: 'collecting', kind: 'realtime' },
    ]);
    expect(store.db.prepare('SELECT bucket_id, message_id, sequence_no FROM bucket_messages').all()).toEqual([
      { bucket_id: 1n, message_id: 1n, sequence_no: 1n },
    ]);
  });

  test('media, reply, forward and service metadata are stored verbatim', async () => {
    const { store, intake } = await setup();
    const result = intake.ingest(
      inbound({
        kind: 'rich_message',
        text: 'look at this',
        caption: 'cap',
        replyToMessageNo: 90n,
        replySnapshotJson: '{"message_id":"90","sender":"Bob","content":"earlier"}',
        forwardOriginJson: '{"type":"channel","chat":{"id":-100}}',
        mediaGroupId: '42',
        media: [
          {
            kind: 'photo',
            fileId: 'file-1',
            fileUniqueId: 'unique-1',
            mimeType: 'image/jpeg',
            fileSize: 1024n,
            width: 640n,
            height: 480n,
            rawJson: '{"file_id":"file-1"}',
          },
        ],
      }),
    );
    expect(result.bucketId).toBe(1n);
    expect(
      store.db
        .prepare(
          'SELECT kind, text, caption, reply_to_message_id, reply_snapshot_json, forward_origin_json, media_group_id FROM message_revisions',
        )
        .all(),
    ).toEqual([
      {
        kind: 'rich_message',
        text: 'look at this',
        caption: 'cap',
        reply_to_message_id: 90n,
        reply_snapshot_json: '{"message_id":"90","sender":"Bob","content":"earlier"}',
        forward_origin_json: '{"type":"channel","chat":{"id":-100}}',
        media_group_id: '42',
      },
    ]);
    expect(
      store.db
        .prepare(
          'SELECT kind, file_id, file_unique_id, mime_type, file_size, width, height, telegram_json, host_kind FROM media',
        )
        .all(),
    ).toEqual([
      {
        kind: 'photo',
        file_id: 'file-1',
        file_unique_id: 'unique-1',
        mime_type: 'image/jpeg',
        file_size: 1024n,
        width: 640n,
        height: 480n,
        telegram_json: '{"file_id":"file-1"}',
        host_kind: 'telegram',
      },
    ]);
  });

  test('an edit appends a revision without a new bucket; a duplicate stores nothing', async () => {
    const { store, intake } = await setup();
    const first = intake.ingest(inbound());
    expect(first.bucketId).toBe(1n);

    const edited = intake.ingest(
      inbound({ edited: true, text: 'hello again', rawFragmentJson: '{"message_id":1,"text":"hello again"}' }),
    );
    expect(edited.messageId).toBe(1n);
    expect(edited.bucketId).toBeUndefined();
    expect(store.db.prepare('SELECT revision_no, text FROM message_revisions ORDER BY revision_no').all()).toEqual([
      { revision_no: 1n, text: 'hello' },
      { revision_no: 2n, text: 'hello again' },
    ]);
    expect(rowCount(store, 'buckets')).toBe(1);
    expect(rowCount(store, 'bucket_messages')).toBe(1);

    const duplicate = intake.ingest(inbound());
    expect(duplicate.messageId).toBeUndefined();
    expect(duplicate.bucketId).toBeUndefined();
    expect(rowCount(store, 'message_revisions')).toBe(2);
    expect(rowCount(store, 'buckets')).toBe(1);
  });

  test('a trigger cue refreshes the attention window and reports the mention', async () => {
    const { store, intake } = await setup((config) => {
      config.telegram.participation = {
        active_windows: [{ start: '09:00', end: '12:00' }],
        attention_window_seconds: 600,
      };
    });
    const result = intake.ingest(
      inbound({ cues: { mentionsBot: true, repliesToBot: false, asksBot: false, texts: ['hi @bot'] } }),
    );
    // 2026-08-15 13:00 UTC is outside the 09:00–12:00 window, so the mention
    // is what opens the bucket and the window it leaves is configured.
    expect(result.bucketId).toBe(1n);
    expect(result.mention).toEqual({
      hostKind: 'telegram',
      hostChatId: HOST_CHAT_ID,
      internalChatId: CHAT_ID,
      threadId: 0n,
    });
    expect(
      store.db.prepare('SELECT expires_at, trigger_kind, trigger_message_no FROM conversation_attention').all(),
    ).toEqual([
      {
        expires_at: '2026-08-15T13:10:00.000Z',
        trigger_kind: 'mention',
        trigger_message_no: 1n,
      },
    ]);
    // A plain message inside the opened window joins the same bucket.
    const followUp = intake.ingest(inbound({ messageNo: 2n, receivedAt: new Date('2026-08-15T13:01:00.000Z') }));
    expect(followUp.bucketId).toBe(1n);
    expect(followUp.mention).toBeUndefined();
  });

  test('own, other-bot, service and sticker-only messages keep their eligibility', async () => {
    const { store, intake } = await setup();
    const bot = { type: 'user', id: 555n, displayName: 'OtherBot', username: 'other', isBot: true } as const;

    // The bot's own message is dropped outright; so is another bot's while
    // `process_bot_messages` is off (the fixture's default).
    expect(intake.ingest(inbound({ messageNo: 1n, fromUserId: BOT_ID })).messageId).toBeUndefined();
    expect(intake.ingest(inbound({ messageNo: 2n, sender: bot, fromUserId: 555n })).messageId).toBeUndefined();

    // A service notice or an untriggering sticker-only message is stored but
    // cannot open a bucket on its own.
    const service = intake.ingest(inbound({ messageNo: 3n, kind: 'service', text: 'joined the group', service: true }));
    expect(service.messageId).toBeDefined();
    expect(service.bucketId).toBeUndefined();

    const human = intake.ingest(inbound({ messageNo: 4n }));
    expect(human.bucketId).toBe(1n);

    // With a bucket collecting, the same companion-only kinds ride along.
    const sticker = intake.ingest(
      inbound({
        messageNo: 5n,
        kind: 'sticker',
        text: null,
        media: [
          {
            kind: 'sticker',
            fileId: 'st-1',
            fileUniqueId: 'st-u1',
            mimeType: 'image/webp',
            fileSize: 20_000n,
            width: 512n,
            height: 512n,
            rawJson: '{"file_id":"st-1"}',
          },
        ],
      }),
    );
    expect(sticker.messageId).toBeDefined();
    expect(sticker.bucketId).toBe(1n);
    const notice = intake.ingest(inbound({ messageNo: 6n, kind: 'service', text: 'left the group', service: true }));
    expect(notice.bucketId).toBe(1n);
    expect(store.db.prepare('SELECT message_id FROM bucket_messages ORDER BY sequence_no').all()).toEqual([
      { message_id: 2n },
      { message_id: 3n },
      { message_id: 4n },
    ]);
    expect(rowCount(store, 'messages')).toBe(4);
    expect(rowCount(store, 'buckets')).toBe(1);
  });

  test('a mid-write failure rolls back the whole delivery', async () => {
    const { store, intake } = await setup();
    // A media kind outside the schema CHECK simulates a write failing between
    // the message row and the bucket append.
    expect(() =>
      intake.ingest(
        inbound({
          kind: 'video',
          media: [
            {
              kind: 'video' as 'photo',
              fileId: 'v-1',
              fileUniqueId: 'v-u1',
              mimeType: 'video/mp4',
              fileSize: 1n,
              width: 1n,
              height: 1n,
              rawJson: '{}',
            },
          ],
        }),
      ),
    ).toThrow();
    for (const table of [
      'senders',
      'conversations',
      'messages',
      'message_revisions',
      'media',
      'buckets',
      'bucket_messages',
      'conversation_attention',
    ]) {
      expect(rowCount(store, table)).toBe(0);
    }
  });

  test('catch-up intake stores the message without scheduling a bucket', async () => {
    const { store, intake } = await setup();
    const result = intake.ingestCatchUp(inbound());
    expect(result.messageId).toBe(1n);
    expect(result.bucketId).toBeUndefined();
    expect(rowCount(store, 'messages')).toBe(1);
    expect(rowCount(store, 'buckets')).toBe(0);
  });

  test('refuses a host whose intake is release instead of opening a bucket', async () => {
    const { store, intake } = await setup();
    seedPlaygroundConversation(store, { chatId: 8n });
    // A release host's rooms never collect: delivering through this path must
    // not open a collecting bucket the due query would queue without a release.
    expect(() => intake.ingest(inbound({ host: 'playground', internalChatId: 8n, hostChatId: 8n }))).toThrow();
    for (const table of ['senders', 'messages', 'message_revisions', 'buckets']) {
      expect(rowCount(store, table)).toBe(0);
    }
  });

  test('refuses a message whose chat belongs to another host', async () => {
    const { store, intake } = await setup();
    const { chatId } = seedPlaygroundConversation(store, { chatId: 8n });
    // `chat_id` only proves the row exists; the chat's host_kind must match
    // `message.host`, or catch-up and snapshots would read one row as two hosts.
    expect(() => intake.ingest(inbound({ internalChatId: chatId }))).toThrow();
    for (const table of ['senders', 'messages', 'message_revisions', 'buckets']) {
      expect(rowCount(store, table)).toBe(0);
    }
  });
});
