import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { chats } from './core.ts';
import { sqliteBigInt } from './shared.ts';

/**
 * One dated event summary of a Chat, with the inclusive Telegram message-id
 * range it was written from. Rows outlive the raw messages so the event remains
 * searchable; the range is what `read_group_messages` replays while the source
 * rows are still retained.
 */
export const groupMemories = sqliteTable(
  'group_memories',
  {
    id: text('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    summary: text('summary').notNull(),
    firstMessageId: sqliteBigInt('first_message_id').notNull(),
    lastMessageId: sqliteBigInt('last_message_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('group_memories_summary_length_check', sql`length(summary) BETWEEN 1 AND 150`),
    check('group_memories_day_check', sql`day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check('group_memories_range_check', sql`first_message_id > 0 AND last_message_id >= first_message_id`),
    index('group_memories_chat_day_idx').on(t.chatId, t.day, t.firstMessageId),
    index('group_memories_chat_range_idx').on(t.chatId, t.firstMessageId, t.lastMessageId),
  ],
);

/**
 * Per-Chat consolidation watermark and claim. A row is created by the worker on
 * its first claim; its absence means "nothing consolidated yet". `state` never
 * holds an error value: a failure returns to `idle` with `error_code` and
 * `next_attempt_at`, so a failed batch is retried instead of being lost.
 */
export const groupMemoryState = sqliteTable(
  'group_memory_state',
  {
    chatId: sqliteBigInt('chat_id')
      .primaryKey()
      .references(() => chats.id, { onDelete: 'cascade' }),
    consolidatedThroughMessageId: sqliteBigInt('consolidated_through_message_id').notNull().default(0n),
    state: text('state').$type<'idle' | 'running'>().notNull().default('idle'),
    claimedAt: text('claimed_at'),
    lastAttemptAt: text('last_attempt_at'),
    lastSuccessAt: text('last_success_at'),
    nextAttemptAt: text('next_attempt_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [
    check('group_memory_state_state_check', sql`state IN ('idle', 'running')`),
    check('group_memory_state_watermark_check', sql`consolidated_through_message_id >= 0`),
  ],
);
