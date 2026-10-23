/**
 * Drizzle schema for the Plastic Wan SQLite database.
 *
 * The authoritative DDL lives in `src/migrations/*.sql`. This file is the
 * typed query-layer mapping for drizzle-orm: table and column names must
 * match the migration end state exactly. When you add a migration, update
 * this file in the same change and keep both in sync.
 *
 * Conventions:
 * - INTEGER identity/reference/count columns use `sqliteBigInt`; SQLite row
 *   IDs are `bigint` everywhere in this codebase.
 * - 0/1 flag columns use `integer(..., { mode: 'boolean' })`.
 * - The `sticker_search` FTS5 virtual table is intentionally not declared
 *   here; drizzle cannot express virtual tables. Query it through `sql`
 *   templates.
 * - WITHOUT ROWID tables are declared with composite primary keys only;
 *   the rowid setting itself stays in the SQL migrations.
 */

export * from './schema/admin.ts';
export * from './schema/agent-loop.ts';
export * from './schema/core.ts';
export * from './schema/image.ts';
export * from './schema/invocation.ts';
export * from './schema/messaging.ts';
export * from './schema/operations.ts';
export * from './schema/playground.ts';
export * from './schema/shared.ts';
export * from './schema/tasks.ts';
