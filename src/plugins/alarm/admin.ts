import { and, eq, type SQL, sql } from 'drizzle-orm';
import {
  AdminQueryError,
  idSnapshot,
  type ListQuery,
  type Page,
  parseId,
  parseWindow,
  snapshotCounts,
  snapshotPage,
  whereSql,
} from '../../ingress/admin/audit/shared.ts';
import type { Orm } from '../../store/store.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import { longTasks } from '../../store/schema/index.ts';

const ALARM_STATES = new Set(['pending', 'firing', 'fired', 'cancelled']);

export interface AlarmAdminItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: string | null;
  readonly fired_at: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: boolean;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly chat: {
    readonly telegram_chat_id: string;
    readonly type: string;
    readonly title: string | null;
    readonly message_thread_id: string;
  };
}

interface AlarmRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly state: string;
  readonly scheduled_at: string;
  readonly created_at: string;
  readonly created_by_invocation_id: bigint | null;
  readonly fired_at: string | null;
  readonly invocation_id: bigint | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
  readonly admin_cancelled: bigint | null;
  readonly cancel_reason: string | null;
  readonly updated_at: string;
  readonly target_user_id: string;
  readonly target_display_name: string;
  readonly summary: string;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
}

const ALARM_SELECT = `SELECT lt.id, lt.conversation_id,
  CASE
    WHEN lt.state = 'cancelled' OR tr.state = 'suppressed' THEN 'cancelled'
    WHEN tr.state = 'claimed' THEN 'firing'
    WHEN tr.state = 'handled' THEN 'fired'
    ELSE 'pending'
  END AS state,
  lt.scheduled_at, lt.created_at, lt.created_by_invocation_id, tr.claimed_at AS fired_at,
  tr.invocation_id, tr.invocation_outcome, tr.completion_reason, tr.cancelled_at, tr.cancelled_by,
  tr.admin_cancelled, tr.cancel_reason, COALESCE(tr.updated_at, lt.updated_at) AS updated_at,
  json_extract(lt.payload_json, '$.target_user_id') AS target_user_id,
  json_extract(lt.payload_json, '$.target_display_name') AS target_display_name,
  json_extract(lt.payload_json, '$.summary') AS summary,
  ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id
FROM long_tasks lt
LEFT JOIN task_receipts tr ON tr.task_id = lt.id
JOIN conversations c ON c.id = lt.conversation_id
JOIN chats ch ON ch.id = c.chat_id
WHERE lt.plugin_id = 'alarm'`;

/**
 * Pending alarms first in firing order, then the history newest first. The
 * snapshot is the `long_tasks` id, so an alarm created later stays out until
 * the client takes a new snapshot; a pending alarm that fires moves to the
 * history part immediately, because its state is live.
 */
const ALARM_ORDER = sql`CASE WHEN state = 'pending' THEN 0 ELSE 1 END,
  CASE WHEN state = 'pending' THEN scheduled_at END,
  CASE WHEN state = 'pending' THEN id END,
  COALESCE(fired_at, cancelled_at, updated_at) DESC,
  id DESC`;

export function listAlarms(orm: Orm, query: ListQuery): Page<AlarmAdminItem> {
  const window = parseWindow(query);
  const snapshot = idSnapshot(orm, longTasks.id, sql`id`, query.as_of);
  const state = parseState(query.state);
  const conditions: SQL[] = [];
  if (state !== undefined) {
    conditions.push(sql`state = ${state}`);
  }
  if (query.chat) {
    conditions.push(sql`telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  if (query.target) {
    conditions.push(sql`target_user_id = ${parsePositiveId(query.target, 'target').toString()}`);
  }
  const alarms = sql`(${sql.raw(ALARM_SELECT)})`;
  const counts = snapshotCounts(snapshot);
  const [count] = orm.all<{ readonly total: unknown; readonly fresh: unknown }>(
    sql`SELECT ${counts.total} AS total, ${counts.fresh} AS fresh FROM ${alarms} ${whereSql(conditions)}`,
  );
  const rows = orm.all<AlarmRow>(
    sql`SELECT * FROM ${alarms} ${whereSql([...conditions, snapshot.within])} ORDER BY ${ALARM_ORDER} LIMIT ${BigInt(window.limit)} OFFSET ${BigInt(window.offset)}`,
  );
  return snapshotPage(rows.map(toItem), count, window, snapshot);
}

export function cancelAlarm(
  tasks: LongTaskService,
  orm: Orm,
  id: bigint,
  adminUsername: string,
  now = new Date(),
): { status: string } {
  const row = orm
    .select({ conversation_id: longTasks.conversationId })
    .from(longTasks)
    .where(and(eq(longTasks.id, id), eq(longTasks.pluginId, 'alarm')))
    .get();
  if (row === undefined) {
    throw new AdminQueryError('not_found', 'Alarm does not exist', 404);
  }
  if (
    !tasks
      .scoped('alarm', row.conversation_id)
      .cancel(id, { cancelledBy: adminUsername, adminCancelled: true, reason: 'admin_cancelled' }, now)
  ) {
    throw new AdminQueryError('alarm_not_pending', 'Only pending alarms can be cancelled', 409);
  }
  return { status: 'cancelled' };
}

export function parseAlarmId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError('invalid_id', 'id must be a positive integer');
  }
  return BigInt(value);
}

function parseState(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!ALARM_STATES.has(value)) {
    throw new AdminQueryError('invalid_state', 'state must be pending, firing, fired, or cancelled');
  }
  return value;
}
function parsePositiveId(value: string, label: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must be a positive integer`);
  }
  return BigInt(value);
}
function toItem(row: AlarmRow): AlarmAdminItem {
  return {
    id: row.id.toString(),
    conversation_id: row.conversation_id.toString(),
    state: row.state,
    scheduled_at: row.scheduled_at,
    created_at: row.created_at,
    created_by_invocation_id: row.created_by_invocation_id?.toString() ?? null,
    fired_at: row.fired_at,
    invocation_id: row.invocation_id?.toString() ?? null,
    invocation_outcome: row.invocation_outcome,
    completion_reason: row.completion_reason,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    admin_cancelled: row.admin_cancelled === 1n,
    cancel_reason: row.cancel_reason,
    updated_at: row.updated_at,
    target_user_id: row.target_user_id,
    target_display_name: row.target_display_name,
    summary: row.summary,
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: row.message_thread_id.toString(),
    },
  };
}
