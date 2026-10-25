import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { HostKind } from '../../platform/im-host/identity.ts';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';
import { chats, conversations } from './core.ts';

export const senders = sqliteTable(
  'senders',
  {
    id: sqliteBigIntId('id').primaryKey(),
    hostKind: text('host_kind').$type<HostKind>().notNull().default('telegram'),
    telegramType: text('telegram_type'),
    telegramId: sqliteBigInt('telegram_id'),
    displayName: text('display_name').notNull(),
    username: text('username'),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('senders_telegram_type_check', sql`telegram_type IN ('user', 'sender_chat')`),
    check(
      'senders_host_identity_check',
      sql`(host_kind = 'telegram' AND telegram_type IS NOT NULL AND telegram_id IS NOT NULL) OR (host_kind = 'playground' AND telegram_type IS NULL AND telegram_id IS NULL)`,
    ),
    uniqueIndex('senders_telegram_identity_key').on(t.telegramType, t.telegramId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    hostKind: text('host_kind').$type<HostKind>().notNull().default('telegram'),
    telegramMessageId: sqliteBigInt('telegram_message_id'),
    currentRevisionId: sqliteBigInt('current_revision_id').references((): AnySQLiteColumn => messageRevisions.id),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    sentByBot: integer('sent_by_bot', { mode: 'boolean' }).notNull().default(false),
    telegramDate: text('telegram_date').notNull(),
    receivedAt: text('received_at').notNull(),
    /**
     * Local (non-Telegram) reply target and arrival order. Telegram traffic
     * leaves both NULL and keeps using telegram_message_id / telegram_date.
     */
    localReplyToMessageId: sqliteBigInt('local_reply_to_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
    }),
    localSequenceNo: sqliteBigInt('local_sequence_no'),
  },
  (t) => [
    check(
      'messages_host_identity_check',
      sql`(host_kind = 'telegram' AND telegram_message_id IS NOT NULL) OR (host_kind = 'playground' AND telegram_message_id IS NULL)`,
    ),
    uniqueIndex('messages_chat_telegram_message_id_key').on(t.chatId, t.telegramMessageId),
    index('messages_local_sequence_key')
      .on(t.conversationId, t.localSequenceNo)
      .where(sql`local_sequence_no IS NOT NULL`),
  ],
);

export const messageRevisions = sqliteTable(
  'message_revisions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revisionNo: sqliteBigInt('revision_no').notNull(),
    senderId: sqliteBigInt('sender_id'),
    kind: text('kind').notNull(),
    text: text('text'),
    caption: text('caption'),
    replyToMessageId: sqliteBigInt('reply_to_message_id'),
    replySnapshotJson: text('reply_snapshot_json'),
    forwardOriginJson: text('forward_origin_json'),
    mediaGroupId: text('media_group_id'),
    serviceJson: text('service_json'),
    createdAt: text('created_at').notNull(),
    rawFragmentJson: text('raw_fragment_json').notNull(),
  },
  (t) => [uniqueIndex('message_revisions_message_revision_unique').on(t.messageId, t.revisionNo)],
);

export const media = sqliteTable(
  'media',
  {
    id: sqliteBigIntId('id').primaryKey(),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: sqliteBigInt('file_size'),
    width: sqliteBigInt('width'),
    height: sqliteBigInt('height'),
    telegramJson: text('telegram_json').notNull(),
    hostKind: text('host_kind').notNull().default('telegram'),
    localAssetId: text('local_asset_id'),
  },
  (t) => [
    check('media_kind_check', sql`kind IN ('photo', 'document', 'sticker')`),
    index('media_revision_idx').on(t.revisionId),
    index('media_unique_idx').on(t.fileUniqueId),
  ],
);

export const mediaAnalyses = sqliteTable(
  'media_analyses',
  {
    id: sqliteBigIntId('id').primaryKey(),
    fileUniqueId: text('file_unique_id').notNull(),
    analysisVersion: text('analysis_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    description: text('description'),
    metadataJson: text('metadata_json'),
    expiresAt: text('expires_at'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('media_analyses_kind_check', sql`kind IN ('image', 'sticker')`),
    check('media_analyses_state_check', sql`state IN ('pending', 'success', 'error')`),
    uniqueIndex('media_analyses_file_version_unique').on(t.fileUniqueId, t.analysisVersion),
  ],
);

export const stickerSets = sqliteTable(
  'sticker_sets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    alias: text('alias').notNull().unique(),
    telegramName: text('telegram_name').notNull().unique(),
    title: text('title'),
    configured: integer('configured', { mode: 'boolean' }).notNull().default(true),
    syncState: text('sync_state').notNull().default('pending'),
    lastSyncedAt: text('last_synced_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('sticker_sets_sync_state_check', sql`sync_state IN ('pending', 'running', 'success', 'error')`)],
);

export const stickers = sqliteTable(
  'stickers',
  {
    id: sqliteBigIntId('id').primaryKey(),
    stickerSetId: sqliteBigInt('sticker_set_id')
      .notNull()
      .references(() => stickerSets.id, { onDelete: 'cascade' }),
    fileUniqueId: text('file_unique_id').notNull().unique(),
    fileId: text('file_id').notNull(),
    emoji: text('emoji'),
    format: text('format').notNull(),
    thumbnailJson: text('thumbnail_json'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    currentAnalysisId: sqliteBigInt('current_analysis_id').references(() => mediaAnalyses.id),
    indexState: text('index_state').notNull().default('pending'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('stickers_format_check', sql`format IN ('static', 'animated', 'video')`),
    check('stickers_index_state_check', sql`index_state IN ('pending', 'running', 'success', 'error')`),
    index('stickers_index_queue_idx').on(t.active, t.indexState, t.nextRetryAt, t.id),
  ],
);
