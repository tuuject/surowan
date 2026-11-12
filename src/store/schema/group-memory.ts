import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { chats } from './core.ts';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';

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
    check('group_memories_summary_length_check', sql`length(summary) BETWEEN 1 AND 200`),
    check('group_memories_day_check', sql`day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check('group_memories_range_check', sql`first_message_id > 0 AND last_message_id >= first_message_id`),
    index('group_memories_chat_day_idx').on(t.chatId, t.day, t.firstMessageId),
    index('group_memories_chat_range_idx').on(t.chatId, t.firstMessageId, t.lastMessageId),
  ],
);

/**
 * One consolidation lane of a Chat. `live` follows new messages; `backfill`
 * works through an old backlog up to `untilMessageId`, after which the live lane
 * starts. A row exists only while group memory is active for the Chat: switching
 * it off deletes the lanes. `state` never holds an error value: a failure returns
 * to `idle` with `error_code` and `next_attempt_at`, so a failed batch is retried
 * instead of being lost.
 */
export const groupMemoryLanes = sqliteTable(
  'group_memory_lanes',
  {
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    lane: text('lane').$type<'live' | 'backfill'>().notNull(),
    throughMessageId: sqliteBigInt('through_message_id').notNull().default(0n),
    untilMessageId: sqliteBigInt('until_message_id'),
    state: text('state').$type<'idle' | 'running'>().notNull().default('idle'),
    claimedAt: text('claimed_at'),
    lastAttemptAt: text('last_attempt_at'),
    lastSuccessAt: text('last_success_at'),
    nextAttemptAt: text('next_attempt_at'),
    errorCode: text('error_code'),
    consecutiveFailures: sqliteBigInt('consecutive_failures').notNull().default(0n),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.lane] }),
    check('group_memory_lanes_lane_check', sql`lane IN ('live', 'backfill')`),
    check('group_memory_lanes_state_check', sql`state IN ('idle', 'running')`),
    check('group_memory_lanes_through_check', sql`through_message_id >= 0`),
    check('group_memory_lanes_failures_check', sql`consecutive_failures >= 0`),
    check(
      'group_memory_lanes_until_check',
      sql`(lane = 'live' AND until_message_id IS NULL) OR (lane = 'backfill' AND until_message_id IS NOT NULL AND until_message_id >= through_message_id)`,
    ),
  ],
);

/**
 * One consolidation batch of one lane: what it read, how many model calls it
 * took and how it ended. Audit rows, pruned by `retention.online_days`.
 */
export const groupMemoryRuns = sqliteTable(
  'group_memory_runs',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    lane: text('lane').$type<'live' | 'backfill'>().notNull(),
    day: text('day').notNull(),
    firstMessageId: sqliteBigInt('first_message_id').notNull(),
    throughMessageId: sqliteBigInt('through_message_id').notNull(),
    messages: sqliteBigInt('messages').notNull(),
    state: text('state').$type<'running' | 'success' | 'error'>().notNull(),
    events: sqliteBigInt('events'),
    modelCalls: sqliteBigInt('model_calls').notNull().default(0n),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    check('group_memory_runs_lane_check', sql`lane IN ('live', 'backfill')`),
    check('group_memory_runs_state_check', sql`state IN ('running', 'success', 'error')`),
    check('group_memory_runs_messages_check', sql`messages >= 0`),
    check('group_memory_runs_model_calls_check', sql`model_calls >= 0`),
    check('group_memory_runs_range_check', sql`through_message_id >= first_message_id`),
    index('group_memory_runs_chat_started_idx').on(t.chatId, t.startedAt),
    index('group_memory_runs_started_idx').on(t.startedAt),
  ],
);
