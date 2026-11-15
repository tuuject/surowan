import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
  /** `read:all` is the base grant and must be 1 for the key to work. */
  readAll: integer('read_all', { mode: 'boolean' }).notNull().default(true),
  writeAll: integer('write_all', { mode: 'boolean' }).notNull().default(false),
  /**
   * Mirrors migration 053's `DEFAULT 1` and the `read_paid` default mode; Drizzle
   * writes this value for an omitted column, so it must match raw SQL.
   */
  executePaidOperations: integer('execute_paid_operations', { mode: 'boolean' }).notNull().default(true),
});

/**
 * Paired Admin clients. A client authenticates by signing each request with an
 * Ed25519 key whose private half never leaves the client machine, so no
 * long-term bearer token has to be copied into the agent's context.
 * `fingerprint` is display metadata; the grant columns mirror API keys exactly.
 */
export const adminClients = sqliteTable(
  'admin_clients',
  {
    id: sqliteBigIntId('id').primaryKey(),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    readAll: integer('read_all', { mode: 'boolean' }).notNull(),
    writeAll: integer('write_all', { mode: 'boolean' }).notNull(),
    executePaidOperations: integer('execute_paid_operations', { mode: 'boolean' }).notNull(),
  },
  (t) => [uniqueIndex('admin_clients_public_key_active_key').on(t.publicKey).where(sql`revoked_at IS NULL`)],
);

/**
 * One-time pairing tickets. `code_hash` is the SHA-256 digest of the `pwp_`
 * code, which is printed once by `surowan pairing create` and never stored.
 * A `client` ticket becomes a signed client (`public_key` pre-binds it to the
 * only key allowed to claim it); a `web` ticket becomes a panel session for
 * `user_id` and records every permission bit (migration 059).
 */
export const adminPairings = sqliteTable(
  'admin_pairings',
  {
    id: sqliteBigIntId('id').primaryKey(),
    purpose: text('purpose', { enum: ['client', 'web'] }).notNull(),
    name: text('name').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    publicKey: text('public_key'),
    userId: sqliteBigInt('user_id').references(() => adminUsers.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    canceledAt: text('canceled_at'),
    clientId: sqliteBigInt('client_id').references(() => adminClients.id),
    readAll: integer('read_all', { mode: 'boolean' }).notNull(),
    writeAll: integer('write_all', { mode: 'boolean' }).notNull(),
    executePaidOperations: integer('execute_paid_operations', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('admin_pairings_expiry_idx').on(t.expiresAt)],
);

/**
 * Consumed request nonces. Persisted rather than kept in memory so a replayed
 * request is still refused after the process restarts.
 */
export const adminClientNonces = sqliteTable(
  'admin_client_nonces',
  {
    clientId: sqliteBigInt('client_id')
      .notNull()
      .references(() => adminClients.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.nonce] }), index('admin_client_nonces_expiry_idx').on(t.expiresAt)],
);

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
