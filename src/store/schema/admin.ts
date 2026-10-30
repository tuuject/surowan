import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';

export const adminUsers = sqliteTable('admin_users', {
  id: sqliteBigIntId('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash'),
  webauthnUserId: text('webauthn_user_id').notNull().unique().default(sql`(lower(hex(randomblob(16))))`),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

export const adminPasskeys = sqliteTable(
  'admin_passkeys',
  {
    id: sqliteBigIntId('id').primaryKey(),
    userId: sqliteBigInt('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    counter: sqliteBigInt('counter').notNull(),
    rpId: text('rp_id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [
    index('admin_passkeys_user_idx').on(t.userId),
    check('admin_passkeys_counter_check', sql`counter >= 0`),
    check('admin_passkeys_name_check', sql`length(name) BETWEEN 1 AND 80`),
  ],
);

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    userId: sqliteBigInt('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [index('admin_sessions_expiry_idx').on(t.expiresAt)],
);

/**
 * Programmatic Admin API keys. `token_hash` is the SHA-256 digest of the
 * plaintext `pwk_` key, which is shown once at creation and never stored;
 * `prefix` is display-only metadata for the panel.
 */
export const adminApiKeys = sqliteTable('admin_api_keys', {
  id: sqliteBigIntId('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

/**
 * Dictionary entries. `chat_id` is the Telegram chat ID (not `chats.id`), so a
 * group entry can exist for a configured chat before its first stored message.
 * Duplicate terms and aliases are legal; the conflict report is a query.
 */
export const dictionaryEntries = sqliteTable(
  'dictionary_entries',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    chatId: sqliteBigInt('chat_id'),
    term: text('term').notNull(),
    definition: text('definition').notNull(),
    aliasesJson: text('aliases_json').notNull().default('[]'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    revision: sqliteBigInt('revision').notNull().default(1n),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('dictionary_entries_scope_check', sql`scope IN ('global', 'group')`),
    check('dictionary_entries_term_length_check', sql`length(term) BETWEEN 1 AND 200`),
    check('dictionary_entries_definition_length_check', sql`length(definition) BETWEEN 1 AND 4000`),
    check('dictionary_entries_aliases_json_check', sql`json_valid(aliases_json)`),
    check('dictionary_entries_enabled_check', sql`enabled IN (0, 1)`),
    check(
      'dictionary_entries_scope_chat_check',
      sql`(scope = 'global' AND chat_id IS NULL) OR (scope = 'group' AND chat_id IS NOT NULL)`,
    ),
    index('dictionary_entries_scope_idx').on(t.scope, t.chatId, t.id),
    index('dictionary_entries_term_idx').on(t.scope, t.chatId, t.term),
  ],
);
