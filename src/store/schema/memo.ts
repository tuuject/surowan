import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { chats } from './core.ts';
import { sqliteBigInt } from './shared.ts';

/**
 * Memo Pad: chat-scoped memory shared by every Forum Topic of that Chat.
 * `expires_at IS NULL` means long-term; a non-null value is a short-term record
 * that is auto-injected and purged once it passes.
 */
export const memoPadEntries = sqliteTable(
  'memo_pad_entries',
  {
    id: text('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    detail: text('detail').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('memo_pad_entries_summary_length_check', sql`length(summary) BETWEEN 1 AND 150`),
    check('memo_pad_entries_detail_length_check', sql`length(detail) BETWEEN 1 AND 32768`),
    check('memo_pad_entries_expiry_check', sql`expires_at IS NULL OR expires_at > created_at`),
    index('memo_pad_entries_chat_created_idx').on(t.chatId, t.createdAt),
    index('memo_pad_entries_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * One chat-owned binary object referenced from Markdown as `pwblob://<id>`.
 * Bytes live under `<data_dir>/images/memo-blobs/<chatId>/`; rows are deduped by
 * `(chat_id, sha256)` so several Memo entries in one Chat share one file.
 */
export const memoBlobs = sqliteTable(
  'memo_blobs',
  {
    id: text('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    byteSize: sqliteBigInt('byte_size').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('memo_blobs_byte_size_check', sql`byte_size > 0`),
    check('memo_blobs_id_check', sql`length(id) = 36 AND substr(id, 1, 4) = 'blb_'`),
    uniqueIndex('memo_blobs_chat_sha256_key').on(t.chatId, t.sha256),
    index('memo_blobs_chat_idx').on(t.chatId),
  ],
);
