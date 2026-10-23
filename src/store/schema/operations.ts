import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteBigInt, sqliteBigIntId } from './shared.ts';

export const dailyUsage = sqliteTable(
  'daily_usage',
  {
    utcDate: text('utc_date').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    metric: text('metric').notNull(),
    amount: sqliteBigInt('amount').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.utcDate, t.scope, t.resource, t.metric] })],
);

export const mcpServerState = sqliteTable(
  'mcp_server_state',
  {
    alias: text('alias').primaryKey(),
    state: text('state').notNull(),
    registryHash: text('registry_hash'),
    reconnectAttempt: sqliteBigInt('reconnect_attempt').notNull().default(0n),
    nextReconnectAt: text('next_reconnect_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('mcp_server_state_check', sql`state IN ('starting', 'ready', 'degraded', 'stopped')`)],
);

/**
 * Version history for the editable prompt layers: the global persona prompt and
 * each configured Chat's group instructions. One row per recorded content
 * change — panel saves, restores, and prompt-file edits picked up at startup or
 * on an explicit config apply. Rows are pruned per scope by `seq` (see
 * `store/prompt-versions.ts`), never by the online retention window: prompt
 * history is configuration, not conversation data. `chat_id` is `0` for the
 * global scope and the configured Chat ID for the group scope.
 */
export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    scope: text('scope').notNull(),
    chatId: sqliteBigInt('chat_id').notNull().default(0n),
    seq: sqliteBigInt('seq').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    source: text('source').notNull(),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('prompt_versions_scope_check', sql`scope IN ('global', 'group')`),
    check(
      'prompt_versions_scope_chat_check',
      sql`(scope = 'global' AND chat_id = 0) OR (scope = 'group' AND chat_id <> 0)`,
    ),
    check('prompt_versions_source_check', sql`source IN ('panel', 'external', 'rollback')`),
    uniqueIndex('prompt_versions_scope_seq_unique').on(t.scope, t.chatId, t.seq),
  ],
);

/**
 * Event warnings raised by any runtime module. Standing warnings are not stored:
 * the Admin API derives them from the active configuration, so they disappear
 * the moment their condition clears. `variables_json` is a bounded JSON object
 * rendered by the panel's per-code template; it never contains executable code.
 * At most one unread row per `code` exists (partial unique index); a repeated
 * event updates that row instead of appending duplicates. Read rows are pruned
 * by `read_at` plus the configured warning retention window.
 */
export const warnings = sqliteTable(
  'warnings',
  {
    id: sqliteBigIntId('id').primaryKey(),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    variablesJson: text('variables_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    readAt: text('read_at'),
  },
  (t) => [
    check('warnings_code_check', sql`length(code) BETWEEN 1 AND 64`),
    check('warnings_severity_check', sql`severity IN ('warning', 'critical')`),
    check('warnings_variables_json_check', sql`json_valid(variables_json)`),
    uniqueIndex('warnings_unread_code_unique').on(t.code).where(sql`read_at IS NULL`),
    index('warnings_unread_created_idx').on(t.id).where(sql`read_at IS NULL`),
    index('warnings_read_at_idx').on(t.readAt).where(sql`read_at IS NOT NULL`),
  ],
);
