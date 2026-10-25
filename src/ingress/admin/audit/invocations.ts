import { type SQL, sql } from 'drizzle-orm';
import type { RawConfig } from '../../../platform/config/index.ts';
import { HOST_KINDS, type HostKind } from '../../../platform/im-host/identity.ts';
import { telegramIdentity } from '../../../store/host-scope.ts';
import type { Orm } from '../../../store/store.ts';
import {
  AdminQueryError,
  appendCursor,
  assertToken,
  bit,
  type ListQuery,
  optionalFilter,
  type Page,
  page,
  parseId,
  parseLimit,
  whereSql,
} from './shared.ts';
import { loadMatchedMessages, matchedMessagesExists, parseInvocationMessageFilter } from './invocation-search.ts';

export interface InvocationListRow {
  readonly id: bigint;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: bigint;
  readonly tool_calls_used: bigint;
  readonly turns_used: bigint;
  readonly side_effect_started: bigint;
  readonly config_hash: string;
  readonly host_kind: HostKind;
  /** Internal chat row; a room's id is this value. */
  readonly chat_id: bigint;
  /** NULL on virtual rooms. */
  readonly telegram_chat_id: bigint | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly chat_username: string | null;
  readonly message_thread_id: bigint;
  readonly tool_call_count: bigint;
  /**
   * Tokens this invocation consumed under the daily-budget definition
   * (`meteredTokens`): input, output, cache read and cache write. The cache
   * counters are also reported on their own as a breakdown of this total.
   */
  readonly total_tokens: bigint;
  readonly cache_read_tokens: bigint;
  readonly cache_write_tokens: bigint;
  readonly total_cost: number | null;
}

export const INVOCATION_CHAT_COLUMNS = sql`ch.host_kind, ch.id AS chat_id, ch.telegram_chat_id, ch.type AS chat_type,
              ch.title AS chat_title, ch.username AS chat_username, c.message_thread_id`;

export function listInvocations(orm: Orm, query: ListQuery, config?: RawConfig): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: SQL[] = [];
  appendCursor(conditions, sql`i.id`, query.cursor);
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push(sql`i.state = ${assertToken(query.state, 'state')}`);
  }
  const host = optionalFilter(query.host);
  if (host !== undefined) {
    if (!(HOST_KINDS as readonly string[]).includes(host)) {
      throw new AdminQueryError('invalid_host', `host must be one of ${HOST_KINDS.join(', ')}`);
    }
    conditions.push(sql`ch.host_kind = ${host}`);
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push(sql`ch.telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  const filter = parseInvocationMessageFilter(orm, query, config);
  if (filter !== null) {
    conditions.push(matchedMessagesExists(filter));
  }
  const rows =
    orm.all<InvocationListRow>(sql`SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              ${INVOCATION_CHAT_COLUMNS},
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0) + COALESCE(mc.cache_read_tokens, 0) + COALESCE(mc.cache_write_tokens, 0)), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT COALESCE(SUM(mc.cache_read_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_read_tokens,
              (SELECT COALESCE(SUM(mc.cache_write_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS cache_write_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       ${whereSql(conditions)}
       ORDER BY i.id DESC
       LIMIT ${BigInt(limit + 1)}`);
  const matchedByInvocation =
    filter === null
      ? null
      : loadMatchedMessages(
          orm,
          rows.map((row) => row.id),
          filter,
        );
  return page(rows, limit, (row) => {
    const item = {
      id: row.id.toString(),
      state: row.state,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      completion_reason: row.completion_reason,
      error_code: row.error_code,
      sends_used: Number(row.sends_used),
      tool_calls_used: Number(row.tool_calls_used),
      turns_used: Number(row.turns_used),
      side_effect_started: bit(row.side_effect_started),
      config_hash: row.config_hash,
      chat: invocationChat(row),
      tool_call_count: Number(row.tool_call_count),
      total_tokens: Number(row.total_tokens),
      cache_read_tokens: Number(row.cache_read_tokens),
      cache_write_tokens: Number(row.cache_write_tokens),
      total_cost: row.total_cost,
    };
    if (matchedByInvocation === null) {
      return item;
    }
    return { ...item, matched_messages: matchedByInvocation.get(row.id.toString()) ?? [] };
  });
}

/**
 * Each host names its chat in its own identity column: a Telegram chat by its
 * Telegram id, a room by its own id. The other column is always null, so a
 * reader never mistakes one host's id for the other's.
 */
export function invocationChat(row: InvocationListRow): Record<string, unknown> {
  const telegram = row.host_kind === 'telegram';
  return {
    host_kind: row.host_kind,
    telegram_chat_id: telegram ? telegramIdentity(row.telegram_chat_id, 'chats.telegram_chat_id').toString() : null,
    room_id: telegram ? null : row.chat_id.toString(),
    type: row.chat_type,
    title: row.chat_title,
    username: row.chat_username,
    message_thread_id: Number(row.message_thread_id),
  };
}
