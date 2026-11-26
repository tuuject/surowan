import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Orm } from '../../../store/store.ts';

/**
 * Change detection for the live Invocation streams.
 *
 * There is no in-process event bus and the panel may run without the agent
 * runtime writing through the same object graph, so the only truthful signal is
 * the database itself. Each open stream re-reads one aggregate query per tick
 * and hashes the result: equal hash means the page would look the same, a new
 * hash means push one `change` event and let the browser refetch the ordinary
 * JSON endpoints.
 *
 * The per-row signatures fold every column the Invocation pages render, so an
 * UPDATE is caught even when it does not change a row count: `tool_calls` and
 * `host_sends` move `pending` → `success`/`error`/`outcome_unknown`,
 * `model_calls` land tokens, cost and their request/response snapshots after
 * the pending insert, and `invocations` move `queued` → `running` → a terminal
 * state. Text payloads are folded as `IS NULL` flags, never by length: SQLite
 * would otherwise read every tool result on every tick, and a result body is
 * always written together with the state and `finished_at` that carry the
 * change. They cover the whole row set of one Invocation, which is bounded,
 * rather than the whole table, which is not.
 */

/**
 * Mutating one column of a watched row must change the digest, so the shape
 * stays explicit. SQLite hands the integer columns back as `bigint`.
 */
function digest(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

interface InvocationLiveRow {
  readonly state: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly side_effect_started: number;
  readonly resumed_from: number | null;
  readonly resumed_by: number | null;
  readonly tools: string | null;
  readonly model_calls: string | null;
  readonly sends: string | null;
  readonly agent_messages: string | null;
  readonly context_messages: string | null;
  readonly buckets: string | null;
}

/**
 * The fingerprint of one Invocation detail page, or `null` once its row is
 * gone. Every subquery is an index range scan on the Invocation's own rows
 * (`tool_calls_invocation_idx`, `model_calls_invocation_idx`, the primary keys
 * of `agent_messages` / `invocation_messages` / `invocation_buckets`, and
 * `host_sends` probed through the tool call it belongs to).
 */
export function invocationLiveFingerprint(orm: Orm, id: bigint): string | null {
  const row = orm
    .all<InvocationLiveRow>(sql`SELECT i.state AS state, i.started_at AS started_at, i.finished_at AS finished_at,
              i.completion_reason AS completion_reason, i.error_code AS error_code, i.sends_used AS sends_used,
              i.tool_calls_used AS tool_calls_used, i.turns_used AS turns_used,
              i.side_effect_started AS side_effect_started,
              i.resumed_from_invocation_id AS resumed_from,
              (SELECT MAX(r.id) FROM invocations r WHERE r.resumed_from_invocation_id = i.id) AS resumed_by,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT t.id || '~' || t.state || '~' || COALESCE(t.finished_at, '') || '~' ||
                        COALESCE(t.error_code, '') || '~' || COALESCE(t.duration_ms, '') || '~' ||
                        (t.result_text IS NOT NULL) || '~' || (t.result_content_json IS NOT NULL) AS sig
                 FROM tool_calls t WHERE t.invocation_id = i.id ORDER BY t.id)) AS tools,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT m.id || '~' || m.state || '~' || COALESCE(m.finished_at, '') || '~' ||
                        COALESCE(m.input_tokens, 0) || '~' || COALESCE(m.output_tokens, 0) || '~' ||
                        COALESCE(m.cache_read_tokens, 0) || '~' || COALESCE(m.cache_write_tokens, 0) || '~' ||
                        COALESCE(m.cost, 0) || '~' || COALESCE(m.error_code, '') || '~' ||
                        (m.request_json IS NOT NULL) || '~' || (m.response_json IS NOT NULL) AS sig
                 FROM model_calls m WHERE m.invocation_id = i.id ORDER BY m.id)) AS model_calls,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT s.id || '~' || s.state || '~' || COALESCE(s.message_no, '') || '~' ||
                        COALESCE(s.message_id, '') || '~' || COALESCE(s.error_code, '') || '~' ||
                        COALESCE(s.finished_at, '') AS sig
                 FROM host_sends s JOIN tool_calls t ON t.id = s.tool_call_id
                 WHERE t.invocation_id = i.id ORDER BY s.id)) AS sends,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT a.id || '~' || a.sequence_no AS sig
                 FROM agent_messages a WHERE a.invocation_id = i.id ORDER BY a.id)) AS agent_messages,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT m.sequence_no || '~' || m.message_id || '~' || m.revision_id AS sig
                 FROM invocation_messages m WHERE m.invocation_id = i.id ORDER BY m.sequence_no)) AS context_messages,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT b.bucket_id || '~' || COALESCE(b.injected_at, '') AS sig
                 FROM invocation_buckets b WHERE b.invocation_id = i.id ORDER BY b.bucket_id)) AS buckets
       FROM invocations i WHERE i.id = ${id}`)
    .at(0);
  return row === undefined ? null : digest(row);
}

interface InvocationListLiveRow {
  readonly total: number;
  readonly id_sum: number | null;
  readonly max_id: number | null;
  readonly live_invocations: string | null;
  readonly live_tool_calls: string | null;
  readonly live_model_calls: string | null;
}

/**
 * The fingerprint of the Invocation list.
 *
 * Insertions and deletions are detected by the id set itself: `MAX(id)` catches
 * the arrival a reader should see at the top, and `COUNT(*)` + `SUM(id)` catch
 * the bulk purges that remove rows from the middle. That is one covering-index
 * pass over `invocations`, the cheapest exact answer SQLite offers for a
 * deletion, and the only O(rows) part of the query (≈2 ms at 100k rows).
 *
 * Every column a non-terminal row renders is folded per live row: the counters
 * and side-effect bit live on `invocations`, the tool count on `tool_calls`,
 * and tokens/cost on `model_calls`. Terminal rows are immutable, so they are
 * read through the id set alone; a stream that misses an update to one of them
 * would be a row the page can no longer change.
 */
export function invocationListLiveFingerprint(orm: Orm): string {
  const row = orm
    .all<InvocationListLiveRow>(sql`SELECT
              (SELECT COUNT(*) FROM invocations) AS total,
              (SELECT COALESCE(SUM(id), 0) FROM invocations) AS id_sum,
              (SELECT COALESCE(MAX(id), 0) FROM invocations) AS max_id,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT i.id || '~' || i.state || '~' || COALESCE(i.started_at, '') || '~' ||
                        COALESCE(i.finished_at, '') || '~' || COALESCE(i.completion_reason, '') || '~' ||
                        COALESCE(i.error_code, '') || '~' || i.sends_used || '~' || i.tool_calls_used || '~' ||
                        i.turns_used || '~' || i.side_effect_started AS sig
                 FROM invocations i WHERE i.state IN ('queued', 'running') ORDER BY i.id)) AS live_invocations,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT t.id || '~' || t.state AS sig
                 FROM tool_calls t JOIN invocations i ON i.id = t.invocation_id
                 WHERE i.state IN ('queued', 'running') ORDER BY t.id)) AS live_tool_calls,
              (SELECT group_concat(sig, '|') FROM (
                 SELECT m.id || '~' || m.state || '~' ||
                        (COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0) +
                         COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0)) || '~' ||
                        COALESCE(m.cost, 0) AS sig
                 FROM model_calls m JOIN invocations i ON i.id = m.invocation_id
                 WHERE i.state IN ('queued', 'running') ORDER BY m.id)) AS live_model_calls`)
    .at(0);
  return digest(row ?? null);
}

/** Whether the Invocation exists at all; the detail stream answers 404 before opening one. */
export function invocationExists(orm: Orm, id: bigint): boolean {
  return orm.get<{ readonly one: number }>(sql`SELECT 1 AS one FROM invocations WHERE id = ${id}`) !== undefined;
}
