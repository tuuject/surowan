import { type SQL, sql } from 'drizzle-orm';
import { telegramHostSql } from '../../../store/host-scope.ts';
import { bucketDecisions } from '../../../store/schema/index.ts';
import type { Orm } from '../../../store/store.ts';
import {
  bit,
  idSnapshot,
  type ListQuery,
  num,
  type Page,
  parseId,
  parseWindow,
  snapshotCounts,
  snapshotPage,
  whereSql,
} from '../audit/shared.ts';
import { INVOCATION_CHAT_COLUMNS, type InvocationChatColumns, invocationChat } from '../audit/invocations.ts';

/**
 * The gate's decision rows as the Admin API lists them. This is the only way to
 * review `shadow` data, so the query is a plain read: `chat`, `limit`, `offset`
 * and `as_of` filter and page it exactly like the neighbouring audit lists, and
 * every value is bound rather than concatenated.
 */

interface DecisionListRow extends InvocationChatColumns {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
  readonly mode: string;
  readonly model: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly applied: bigint;
  readonly probability: number | null;
  readonly threshold: number;
  readonly history_count: bigint;
  readonly pending_count: bigint;
  readonly input_tokens: bigint | null;
  readonly cost: number | null;
  readonly duration_ms: bigint | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

/**
 * The decisions the gate recorded, newest first. This is the only way to review
 * `shadow` data, so it is a plain read: `chat`, `limit`, `offset` and `as_of`
 * filter and page it exactly like the neighbouring audit lists, and every value
 * is bound rather than concatenated.
 */
export function listBucketDecisions(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const window = parseWindow(query);
  const snapshot = idSnapshot(orm, bucketDecisions.id, sql`d.id`, query.as_of);
  const conditions: SQL[] = [];
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(sql`${telegramHostSql('ch.host_kind')} AND ch.host_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  const from = sql`FROM bucket_decisions d
       JOIN conversations c ON c.id = d.conversation_id
       JOIN chats ch ON ch.id = c.chat_id`;
  const counts = snapshotCounts(snapshot);
  const [count] = orm.all<{ readonly total: unknown; readonly fresh: unknown }>(
    sql`SELECT ${counts.total} AS total, ${counts.fresh} AS fresh ${from} ${whereSql(conditions)}`,
  );
  const rows =
    orm.all<DecisionListRow>(sql`SELECT d.id, d.bucket_id, d.conversation_id, d.mode, d.model, d.state, d.outcome,
              d.applied, d.probability, d.threshold, d.history_count, d.pending_count, d.input_tokens, d.cost,
              d.duration_ms, d.error_code, d.error_detail, d.created_at, d.finished_at,
              ${INVOCATION_CHAT_COLUMNS}
       ${from}
       ${whereSql([...conditions, snapshot.within])}
       ORDER BY d.id DESC
       LIMIT ${BigInt(window.limit)} OFFSET ${BigInt(window.offset)}`);
  const items = rows.map((row) => ({
    id: row.id.toString(),
    bucket_id: row.bucket_id.toString(),
    conversation_id: row.conversation_id.toString(),
    chat: invocationChat(row),
    mode: row.mode,
    model: row.model,
    state: row.state,
    outcome: row.outcome,
    applied: bit(row.applied),
    probability: row.probability,
    threshold: row.threshold,
    history_count: Number(row.history_count),
    pending_count: Number(row.pending_count),
    input_tokens: num(row.input_tokens),
    cost: row.cost,
    duration_ms: num(row.duration_ms),
    error_code: row.error_code,
    error_detail: row.error_detail,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }));
  return snapshotPage(items, count, window, snapshot);
}
