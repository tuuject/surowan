import { and, eq, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { RawConfig } from '../platform/config/index.ts';
import type * as schema from './schema/index.ts';
import { chatMigrations, chatPause, toolCalls } from './schema/index.ts';

/** Synchronous, schema-aware SQLite query surface; no native driver leaks into business code. */
export type Orm = BaseSQLiteDatabase<'sync', SqliteRunResult, typeof schema>;

/** Business-facing store: persistence and synchronous atomicity, not connection lifecycle. */
export interface BusinessStore {
  readonly orm: Orm;
  transaction<T>(work: () => T): T;
}

/**
 * The better-sqlite3 drizzle driver types `.run()` as `void`, but at runtime it
 * returns the native result with `changes`. Use this whenever a write needs
 * its affected-row count.
 */
export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export function asRunResult(result: unknown): SqliteRunResult {
  return result as SqliteRunResult;
}

export function purgeExpiredData(orm: Orm, config: RawConfig, now = new Date()): void {
  const cutoff = new Date(now.getTime() - config.retention.online_days * 86_400_000).toISOString();
  orm.transaction(
    () => {
      orm.run(sql`DELETE FROM memo_pad_entries WHERE expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}`);
      orm.run(sql`DELETE FROM conversation_attention WHERE expires_at <= ${now.toISOString()}`);
      orm.run(sql`DELETE FROM telegram_updates WHERE received_at < ${cutoff}`);
      orm.run(sql`
      DELETE FROM host_sends
      WHERE tool_call_id IN (
        SELECT tc.id
        FROM tool_calls tc
        JOIN invocations i ON i.id = tc.invocation_id
        WHERE i.state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
          AND COALESCE(i.finished_at, i.created_at) < ${cutoff}
      )
    `);
      orm.run(sql`
      DELETE FROM invocations
      WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')
        AND COALESCE(finished_at, created_at) < ${cutoff}
    `);
      orm.run(sql`
      UPDATE buckets
      SET merged_into_bucket_id = NULL
      WHERE merged_into_bucket_id IN (
        SELECT id FROM buckets
        WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')
          AND COALESCE(finished_at, updated_at) < ${cutoff}
      )
    `);
      orm.run(sql`
      DELETE FROM buckets
      WHERE state IN ('completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')
        AND COALESCE(finished_at, updated_at) < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocations i WHERE i.bucket_id = buckets.id)
    `);
      orm.run(sql`
      DELETE FROM media
      WHERE revision_id IN (
        SELECT r.id FROM message_revisions r
        JOIN messages m ON m.id = r.message_id
        WHERE m.received_at < ${cutoff}
      )
    `);
      // A held room input past retention expires visibly; its ledger row then
      // outlives the message as the request key's tombstone.
      orm.run(sql`
      UPDATE playground_inputs
      SET state = 'expired'
      WHERE state = 'held'
        AND message_id IN (SELECT id FROM messages WHERE received_at < ${cutoff})
    `);
      orm.run(sql`
      UPDATE messages
      SET current_revision_id = NULL
      WHERE received_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocation_messages im WHERE im.message_id = messages.id)
        AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = messages.id)
    `);
      orm.run(sql`
      DELETE FROM messages
      WHERE received_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM invocation_messages im WHERE im.message_id = messages.id)
        AND NOT EXISTS (SELECT 1 FROM bucket_messages bm WHERE bm.message_id = messages.id)
    `);
      orm.run(sql`
      UPDATE message_revisions
      SET sender_id = NULL,
          text = NULL,
          caption = NULL,
          reply_snapshot_json = NULL,
          forward_origin_json = NULL,
          service_json = NULL,
          raw_fragment_json = '{}'
      WHERE message_id IN (SELECT id FROM messages WHERE received_at < ${cutoff})
    `);
      orm.run(
        sql`DELETE FROM senders
            WHERE NOT EXISTS (SELECT 1 FROM message_revisions r WHERE r.sender_id = senders.id)
              AND NOT EXISTS (SELECT 1 FROM room_participants p WHERE p.sender_id = senders.id)`,
      );
      orm.run(sql`DELETE FROM media_analyses WHERE kind = 'image' AND updated_at < ${cutoff}`);
      orm.run(
        sql`DELETE FROM model_calls WHERE invocation_id IS NULL AND state <> 'pending' AND created_at < ${cutoff}`,
      );
      orm.run(sql`
        DELETE FROM long_tasks
        WHERE id IN (
          SELECT lt.id
          FROM long_tasks lt
          JOIN task_receipts tr ON tr.task_id = lt.id
          WHERE lt.state IN ('completed', 'failed', 'cancelled')
            AND tr.state IN ('handled', 'suppressed')
            AND COALESCE(tr.claimed_at, tr.cancelled_at, tr.updated_at, lt.finished_at, lt.updated_at) < ${cutoff}
        )
      `);
      orm.run(sql`DELETE FROM daily_usage WHERE utc_date < ${cutoff.slice(0, 10)}`);
      // Conversation Context housekeeping: soft-evicted rows and unused
      // references go first, then contexts that have been idle past retention.
      orm.run(sql`DELETE FROM context_refs WHERE expires_at <= ${now.toISOString()}`);
      orm.run(sql`DELETE FROM context_messages WHERE evicted_at IS NOT NULL AND evicted_at < ${cutoff}`);
      orm.run(sql`DELETE FROM conversation_contexts WHERE last_active_at < ${cutoff}`);
    },
    { behavior: 'immediate' },
  );
}

export function resolveChatConfig(
  config: RawConfig,
  orm: Orm,
  chatId: bigint,
): RawConfig['telegram']['chats'][number] | undefined {
  const direct = config.telegram.chats.find((chat) => BigInt(chat.id) === chatId);
  if (direct !== undefined) {
    return direct;
  }
  const migration = orm
    .select({ oldChatId: chatMigrations.oldChatId })
    .from(chatMigrations)
    .where(eq(chatMigrations.newChatId, chatId))
    .get();
  if (migration === undefined) {
    return undefined;
  }
  return config.telegram.chats.find((chat) => BigInt(chat.id) === migration.oldChatId);
}

export function isChatPaused(orm: Orm, chatId: bigint): boolean {
  return (
    orm.select({ chatId: chatPause.chatId }).from(chatPause).where(eq(chatPause.chatId, chatId)).get() !== undefined
  );
}

export type ToolCallFinishState = 'success' | 'error' | 'outcome_unknown';

/** Inserts the pending audit row for a starting tool call and returns its rowid. */
export function startToolCall(
  orm: Orm,
  invocationId: bigint,
  toolCallId: string,
  toolName: string,
  argumentsJson: string,
  sideEffect: boolean,
  now = new Date(),
): bigint {
  const created = orm
    .insert(toolCalls)
    .values({
      invocationId,
      toolCallId,
      toolName,
      argumentsJson,
      state: 'pending',
      sideEffect,
      createdAt: now.toISOString(),
    })
    .returning({ id: toolCalls.id })
    .get();
  if (created === undefined) {
    throw new Error('tool_calls insert returned no row');
  }
  return created.id;
}

/** Inserts the already-failed audit row for a call rejected before execution started. */
export function rejectToolCall(
  orm: Orm,
  invocationId: bigint,
  toolCallId: string,
  toolName: string,
  argumentsJson: string,
  sideEffect: boolean,
  errorCode: string,
  now = new Date(),
): void {
  const at = now.toISOString();
  orm
    .insert(toolCalls)
    .values({
      invocationId,
      toolCallId,
      toolName,
      argumentsJson,
      state: 'error',
      sideEffect,
      errorCode,
      createdAt: at,
      finishedAt: at,
    })
    .run();
}

/**
 * Marks a pending tool_calls row finished. Pass startedAt (a performance.now() timestamp)
 * to also record duration_ms; pendingOnly keeps rows that were already closed untouched.
 */
export function finishToolCall(
  orm: Orm,
  auditId: bigint,
  state: ToolCallFinishState,
  resultText: string | null,
  errorCode: string | null,
  options: { startedAt?: number; pendingOnly?: boolean; now?: Date } = {},
): void {
  const finishedAt = (options.now ?? new Date()).toISOString();
  const durationMs =
    options.startedAt !== undefined
      ? BigInt(Math.max(0, Math.round(performance.now() - options.startedAt)))
      : undefined;
  const pending = options.pendingOnly === true;
  orm
    .update(toolCalls)
    .set({ state, resultText, errorCode, durationMs, finishedAt })
    .where(pending ? and(eq(toolCalls.id, auditId), eq(toolCalls.state, 'pending')) : eq(toolCalls.id, auditId))
    .run();
}
