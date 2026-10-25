import { type SQL, sql } from 'drizzle-orm';
import type { RawConfig } from '../../../platform/config/index.ts';
import {
  MessageTimeError,
  type MessageTimeOptions,
  parseMessageTimeInstant,
  parseMessageTimeWindow,
} from '../../../platform/message-time.ts';
import { type Orm, resolveChatConfig } from '../../../store/store.ts';
import {
  AdminQueryError,
  escapeLike,
  type ListQuery,
  MAX_PAYLOAD_PREVIEW_LENGTH,
  MAX_SEARCH_LENGTH,
  optionalFilter,
  parseId,
} from './shared.ts';

/** Keyword/time searches report only the first few matching messages per invocation. */
const MAX_MATCHED_MESSAGES = 5;

/**
 * A keyword/time filter for `listInvocations`: an escaped LIKE pattern and UTC
 * ISO-8601 bounds, each optional but every present member required to hit the
 * same public message.
 */
interface InvocationMessageFilter {
  readonly keyword: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

/** Correlates a matched-message source with the invocation(s) being listed. */
type InvocationScope = (column: SQL) => SQL;

interface MatchedMessageRow {
  readonly invocation_id: bigint;
  readonly source: string;
  /** TEXT for frozen snapshots, INTEGER for host_sends; both stringified in the API. */
  readonly telegram_message_id: bigint | string | null;
  /** The room's own message sequence; NULL on Telegram rows, as above. */
  readonly room_seq: bigint | string | null;
  readonly telegram_send_id: bigint | null;
  readonly at: string;
  readonly text: string | null;
}

const INCOMING_INVOCATION = sql`im.invocation_id`;
const INCOMING_TEXT = sql`json_extract(im.snapshot_json, '$.text')`;
const INCOMING_CAPTION = sql`json_extract(im.snapshot_json, '$.caption')`;
// A room snapshot says so in `host`, and its `message_id` is the room's own
// sequence rather than a Telegram message id.
const INCOMING_ROOM = sql`json_extract(im.snapshot_json, '$.host') = 'playground'`;
// The snapshot froze its message time (Telegram's telegram_date, a room's
// sent_at) when the invocation ran; later edits never touch it.
const INCOMING_DATE = sql`COALESCE(json_extract(im.snapshot_json, '$.telegram_date'), json_extract(im.snapshot_json, '$.sent_at'))`;
const SEND_INVOCATION = sql`tc.invocation_id`;
// The published text lives in the outgoing message; a send whose outgoing row
// is gone falls back to the send arguments that the host accepted.
const SEND_TEXT = sql`COALESCE(r.text, r.caption, json_extract(tc.arguments_json, '$.text'))`;
const SEND_DATE = sql`COALESCE(m.telegram_date, ts.finished_at)`;
// A room delivery links its outgoing message directly; a Telegram send only
// knows the message id Telegram assigned.
const SEND_SOURCE = sql`FROM host_sends ts
       JOIN tool_calls tc ON tc.id = ts.tool_call_id
       LEFT JOIN messages m ON m.sent_by_bot = 1 AND (m.id = ts.message_id
         OR (ts.message_id IS NULL AND m.conversation_id = ts.conversation_id
           AND m.telegram_message_id = ts.telegram_message_id))
       LEFT JOIN message_revisions r ON r.id = m.current_revision_id`;

/**
 * `search` and `at`/`from`/`to` both look at the invocation's public messages:
 * frozen `section = 'new'` snapshots and successfully delivered host
 * sends. Private assistant text and tool results are never candidates, an
 * unsuccessful send never is, and a keyword must match the same message whose
 * time satisfies the bounds.
 */
export function parseInvocationMessageFilter(
  orm: Orm,
  query: ListQuery,
  config: RawConfig | undefined,
): InvocationMessageFilter | null {
  const at = optionalFilter(query.at);
  const from = optionalFilter(query.from);
  const to = optionalFilter(query.to);
  const search = optionalFilter(query.search);
  if (at !== undefined && (from !== undefined || to !== undefined)) {
    throw new AdminQueryError('invalid_time_range', 'at cannot be combined with from or to');
  }
  if (at === undefined && from === undefined && to === undefined && search === undefined) {
    return null;
  }
  if (search !== undefined && search.length > MAX_SEARCH_LENGTH) {
    throw new AdminQueryError('invalid_search', 'Search text is too long');
  }
  const timeOptions: MessageTimeOptions = { timezone: resolveFilterTimezone(orm, query, config) };
  let lower: string | null = null;
  let upper: string | null = null;
  if (at !== undefined) {
    const window = timeFilterValue('invalid_at', () => parseMessageTimeWindow(at, timeOptions));
    lower = window.from;
    upper = window.to;
  } else {
    if (from !== undefined) {
      lower = timeFilterValue('invalid_from', () => parseMessageTimeInstant(from, timeOptions));
    }
    if (to !== undefined) {
      upper = timeFilterValue('invalid_to', () => parseMessageTimeInstant(to, timeOptions));
    }
    if (lower !== null && upper !== null && lower >= upper) {
      throw new AdminQueryError('invalid_time_range', 'from must be earlier than to');
    }
  }
  return { keyword: search === undefined ? null : escapeLike(search), from: lower, to: upper };
}

/**
 * Bare timestamps resolve in the Chat's timezone when `chat` names a
 * configured Chat, otherwise in the global timezone. Timestamps carrying
 * their own offset ignore both, and the host machine's timezone is never
 * consulted.
 */
function resolveFilterTimezone(orm: Orm, query: ListQuery, config: RawConfig | undefined): string | undefined {
  if (config === undefined) {
    return undefined;
  }
  const chat = optionalFilter(query.chat);
  if (chat !== undefined) {
    const chatTimezone = resolveChatConfig(config, orm, parseId(chat, 'chat'))?.timezone;
    if (chatTimezone !== undefined && chatTimezone.length > 0) {
      return chatTimezone;
    }
  }
  return config.timezone;
}

function timeFilterValue<T>(code: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof MessageTimeError) {
      throw new AdminQueryError(code, error.message);
    }
    throw error;
  }
}

function incomingMatchedConditions(filter: InvocationMessageFilter, scope: InvocationScope): SQL[] {
  const conditions: SQL[] = [scope(INCOMING_INVOCATION), sql`im.section = 'new'`];
  if (filter.keyword !== null) {
    conditions.push(
      sql`(${INCOMING_TEXT} LIKE ${filter.keyword} ESCAPE '\\' OR ${INCOMING_CAPTION} LIKE ${filter.keyword} ESCAPE '\\')`,
    );
  }
  if (filter.from !== null) {
    conditions.push(sql`${INCOMING_DATE} >= ${filter.from}`);
  }
  if (filter.to !== null) {
    conditions.push(sql`${INCOMING_DATE} < ${filter.to}`);
  }
  return conditions;
}

function sendMatchedConditions(filter: InvocationMessageFilter, scope: InvocationScope): SQL[] {
  const conditions: SQL[] = [scope(SEND_INVOCATION), sql`ts.state = 'success'`];
  if (filter.keyword !== null) {
    conditions.push(sql`${SEND_TEXT} LIKE ${filter.keyword} ESCAPE '\\'`);
  }
  if (filter.from !== null) {
    conditions.push(sql`${SEND_DATE} >= ${filter.from}`);
  }
  if (filter.to !== null) {
    conditions.push(sql`${SEND_DATE} < ${filter.to}`);
  }
  return conditions;
}

export function matchedMessagesExists(filter: InvocationMessageFilter): SQL {
  const correlated: InvocationScope = (column) => sql`${column} = i.id`;
  const incoming = sql.join(incomingMatchedConditions(filter, correlated), sql` AND `);
  const send = sql.join(sendMatchedConditions(filter, correlated), sql` AND `);
  return sql`(EXISTS (SELECT 1 FROM invocation_messages im WHERE ${incoming})
        OR EXISTS (SELECT 1 ${SEND_SOURCE} WHERE ${send}))`;
}

function matchedMessagesSelect(filter: InvocationMessageFilter, scope: InvocationScope): SQL {
  const preview =
    filter.keyword === null
      ? sql`COALESCE(${INCOMING_TEXT}, ${INCOMING_CAPTION})`
      : sql`CASE WHEN ${INCOMING_TEXT} LIKE ${filter.keyword} ESCAPE '\\' THEN ${INCOMING_TEXT} ELSE ${INCOMING_CAPTION} END`;
  const incoming = sql`SELECT im.invocation_id AS invocation_id, 'incoming' AS source,
              CASE WHEN ${INCOMING_ROOM} THEN NULL ELSE json_extract(im.snapshot_json, '$.message_id') END AS telegram_message_id,
              CASE WHEN ${INCOMING_ROOM} THEN json_extract(im.snapshot_json, '$.message_id') END AS room_seq,
              NULL AS telegram_send_id,
              ${INCOMING_DATE} AS at,
              ${preview} AS text
       FROM invocation_messages im
       WHERE ${sql.join(incomingMatchedConditions(filter, scope), sql` AND `)}`;
  const send = sql`SELECT tc.invocation_id AS invocation_id, 'bot' AS source,
              COALESCE(ts.telegram_message_id, m.telegram_message_id) AS telegram_message_id,
              m.local_sequence_no AS room_seq,
              ts.id AS telegram_send_id,
              ${SEND_DATE} AS at,
              ${SEND_TEXT} AS text
       ${SEND_SOURCE}
       WHERE ${sql.join(sendMatchedConditions(filter, scope), sql` AND `)}`;
  return sql`${incoming} UNION ALL ${send}`;
}

/**
 * Total order inside one invocation: newest public time first, then the host
 * message ID (Telegram's, or a room's sequence — an invocation has only one
 * host) compared as an integer (`json_extract` returns the snapshots' frozen
 * TEXT ids while `host_sends` stores integers), then the send row ID and source
 * so same-second matches still have one deterministic order.
 */
const matchedMessageOrder = (row: SQL): SQL => sql`${row}.at DESC,
      CASE WHEN COALESCE(${row}.telegram_message_id, ${row}.room_seq) IS NULL THEN 1 ELSE 0 END,
      CAST(COALESCE(${row}.telegram_message_id, ${row}.room_seq) AS INTEGER) DESC,
      CASE WHEN ${row}.telegram_send_id IS NULL THEN 1 ELSE 0 END,
      ${row}.telegram_send_id DESC,
      ${row}.source`;

/**
 * Newest first, at most {@link MAX_MATCHED_MESSAGES} per invocation: the SQL
 * window keeps each invocation's latest matches only, so a caller can pick the
 * first matching bot message's `telegram_send_id` as a replay-slice candidate.
 * Preflight still validates it: an invocation can send to another conversation.
 */
export function loadMatchedMessages(
  orm: Orm,
  invocationIds: readonly bigint[],
  filter: InvocationMessageFilter,
): Map<string, Record<string, unknown>[]> {
  const byInvocation = new Map<string, Record<string, unknown>[]>();
  if (invocationIds.length === 0) {
    return byInvocation;
  }
  const scope: InvocationScope = (column) =>
    sql`${column} IN (${sql.join(
      invocationIds.map((id) => sql`${id}`),
      sql`, `,
    )})`;
  // `rank_no` already encodes the per-invocation order, so the outer query
  // reuses it instead of repeating the window's ORDER BY expression.
  const rows = orm.all<MatchedMessageRow>(
    sql`SELECT mm.invocation_id, mm.source, mm.telegram_message_id, mm.room_seq, mm.telegram_send_id, mm.at, mm.text
       FROM (
         SELECT ranked.*,
                ROW_NUMBER() OVER (PARTITION BY ranked.invocation_id ORDER BY ${matchedMessageOrder(sql`ranked`)}) AS rank_no
         FROM (${matchedMessagesSelect(filter, scope)}) ranked
       ) mm
       WHERE mm.rank_no <= ${BigInt(MAX_MATCHED_MESSAGES)}
       ORDER BY mm.invocation_id, mm.rank_no`,
  );
  for (const row of rows) {
    const key = row.invocation_id.toString();
    const messages = byInvocation.get(key) ?? [];
    messages.push({
      source: row.source,
      telegram_message_id: row.telegram_message_id === null ? null : row.telegram_message_id.toString(),
      room_seq: row.room_seq === null ? null : row.room_seq.toString(),
      telegram_send_id: row.telegram_send_id === null ? null : row.telegram_send_id.toString(),
      at: row.at,
      text: row.text === null ? null : row.text.slice(0, MAX_PAYLOAD_PREVIEW_LENGTH),
    });
    byInvocation.set(key, messages);
  }
  return byInvocation;
}
