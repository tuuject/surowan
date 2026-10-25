import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { HostKind } from '../../platform/im-host/identity.ts';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: sqliteBigIntId('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramUpdates = sqliteTable(
  'telegram_updates',
  {
    updateId: sqliteBigIntId('update_id').primaryKey(),
    chatId: sqliteBigInt('chat_id'),
    chatType: text('chat_type'),
    receivedAt: text('received_at').notNull(),
    allowed: integer('allowed', { mode: 'boolean' }).notNull(),
    rejectionReason: text('rejection_reason'),
    rawJson: text('raw_json'),
  },
  () => [
    check(
      'telegram_updates_allowed_raw_json',
      sql`(allowed = 1 AND raw_json IS NOT NULL) OR (allowed = 0 AND raw_json IS NULL)`,
    ),
  ],
);

export const chats = sqliteTable(
  'chats',
  {
    id: sqliteBigIntId('id').primaryKey(),
    /**
     * Which host owns this row. Telegram rows carry Telegram identity columns;
     * playground rows are virtual rooms with no transport identifier at all.
     * Nothing may infer the kind from the sign of an id.
     */
    hostKind: text('host_kind').$type<HostKind>().notNull().default('telegram'),
    telegramChatId: sqliteBigInt('telegram_chat_id'),
    canonicalChatId: sqliteBigInt('canonical_chat_id'),
    type: text('type').notNull(),
    title: text('title'),
    username: text('username'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'chats_host_identity_check',
      sql`(host_kind = 'telegram' AND telegram_chat_id IS NOT NULL AND canonical_chat_id IS NOT NULL) OR (host_kind = 'playground' AND telegram_chat_id IS NULL AND canonical_chat_id IS NULL)`,
    ),
    // Plain UNIQUE, not partial: NULLs stay distinct so virtual rooms never
    // collide, and the constraint remains a usable ON CONFLICT target.
    uniqueIndex('chats_telegram_chat_id_key').on(t.telegramChatId),
  ],
);

export const chatMigrations = sqliteTable('chat_migrations', {
  oldChatId: sqliteBigIntId('old_chat_id').primaryKey(),
  newChatId: sqliteBigInt('new_chat_id').notNull().unique(),
  receivedAt: text('received_at').notNull(),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageThreadId: sqliteBigInt('message_thread_id').notNull().default(0n),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('conversations_chat_thread_unique').on(t.chatId, t.messageThreadId)],
);

export const chatPause = sqliteTable('chat_pause', {
  chatId: sqliteBigIntId('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  pausedAt: text('paused_at').notNull(),
});

export const conversationContextCutoffs = sqliteTable('conversation_context_cutoffs', {
  conversationId: sqliteBigIntId('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  telegramMessageId: sqliteBigInt('telegram_message_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Post-trigger attention window, at most one row per conversation. While
 * `expiresAt` is in the future the conversation keeps starting invocations
 * even though its chat is outside every scheduled active period.
 */
export const conversationAttention = sqliteTable(
  'conversation_attention',
  {
    conversationId: sqliteBigIntId('conversation_id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    triggeredAt: text('triggered_at').notNull(),
    triggerKind: text('trigger_kind').notNull(),
    triggerTelegramMessageId: sqliteBigInt('trigger_telegram_message_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('conversation_attention_trigger_kind_check', sql`trigger_kind IN ('mention', 'reply_to_bot', 'keyword')`),
    index('conversation_attention_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Consecutive proactive-reply misses per Chat. `settings_fingerprint` records
 * the numeric parameter set the count belongs to: changing base_probability,
 * increment or hard_pity resets the count on the next sample, while toggling
 * enabled does not. One row per group, never one per message, and it survives
 * restarts so hard pity cannot be dodged by a crash.
 */
export const proactiveReplyState = sqliteTable(
  'proactive_reply_state',
  {
    chatId: sqliteBigIntId('chat_id')
      .primaryKey()
      .references(() => chats.id, { onDelete: 'cascade' }),
    consecutiveMisses: sqliteBigInt('consecutive_misses').notNull().default(0n),
    settingsFingerprint: text('settings_fingerprint').notNull(),
    lastSampledAt: text('last_sampled_at').notNull(),
  },
  () => [check('proactive_reply_state_misses_check', sql`consecutive_misses >= 0`)],
);
