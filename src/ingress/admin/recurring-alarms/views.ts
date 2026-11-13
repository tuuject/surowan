import { type SQL, sql } from 'drizzle-orm';
import type { RecurringAlarmRecord } from '../../../store/recurring-alarms/records.ts';
import { recurringAlarms } from '../../../store/schema/index.ts';
import type { Orm } from '../../../store/store.ts';
import {
  AdminQueryError,
  idSnapshot,
  type Page,
  parseId,
  parseWindow,
  snapshotCounts,
  snapshotPage,
  whereSql,
} from '../audit/shared.ts';

/** How many firings the detail view carries, newest first. */
export const RECURRING_DETAIL_FIRINGS = 50;

export interface RecurringTargetView {
  readonly conversation_id: string;
  readonly chat_id: string;
  readonly host_kind: string;
  readonly telegram_chat_id: string | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: string;
}

export interface RecurringFiringView {
  readonly id: string;
  readonly source: string;
  readonly occurrence_at: string;
  readonly outcome: string;
  readonly skip_reason: string | null;
  readonly coalesced: number;
  readonly triggered_by: string | null;
  readonly created_at: string;
  readonly task_id: string | null;
  /** `pending`, `claimed`, `handled` or `suppressed`; null before the task completes or after it is pruned. */
  readonly receipt_state: string | null;
  readonly invocation_id: string | null;
  readonly invocation_outcome: string | null;
}

export interface RecurringAlarmView {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly prompt: string;
  readonly rules: readonly string[];
  readonly input_mode: string;
  readonly time_zone: string;
  readonly enabled: boolean;
  readonly next_fire_at: string | null;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly target: RecurringTargetView;
  readonly last_firing: RecurringFiringView | null;
}

interface TargetRow {
  readonly conversation_id: bigint;
  readonly chat_id: bigint;
  readonly host_kind: string;
  readonly telegram_chat_id: bigint | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
}

interface FiringRow {
  readonly id: bigint;
  readonly recurring_alarm_id: bigint;
  readonly source: string;
  readonly occurrence_at: string;
  readonly outcome: string;
  readonly skip_reason: string | null;
  readonly coalesced: bigint;
  readonly triggered_by: string | null;
  readonly created_at: string;
  readonly task_id: bigint | null;
  readonly receipt_state: string | null;
  readonly invocation_id: bigint | null;
  readonly invocation_outcome: string | null;
}

const FIRING_SELECT = sql`SELECT f.id, f.recurring_alarm_id, f.source, f.occurrence_at, f.outcome, f.skip_reason,
    f.coalesced, f.triggered_by, f.created_at, f.task_id, r.state AS receipt_state, r.invocation_id,
    r.invocation_outcome
  FROM recurring_alarm_firings f
  LEFT JOIN task_receipts r ON r.task_id = f.task_id`;

export function targetView(row: TargetRow): RecurringTargetView {
  return {
    conversation_id: row.conversation_id.toString(),
    chat_id: row.chat_id.toString(),
    host_kind: row.host_kind,
    telegram_chat_id: row.telegram_chat_id?.toString() ?? null,
    chat_type: row.chat_type,
    chat_title: row.chat_title,
    message_thread_id: row.message_thread_id.toString(),
  };
}

function firingView(row: FiringRow): RecurringFiringView {
  return {
    id: row.id.toString(),
    source: row.source,
    occurrence_at: row.occurrence_at,
    outcome: row.outcome,
    skip_reason: row.skip_reason,
    coalesced: Number(row.coalesced),
    triggered_by: row.triggered_by,
    created_at: row.created_at,
    task_id: row.task_id?.toString() ?? null,
    receipt_state: row.receipt_state,
    invocation_id: row.invocation_id?.toString() ?? null,
    invocation_outcome: row.invocation_outcome,
  };
}

function targetsOf(orm: Orm, conversationIds: readonly bigint[]): Map<string, TargetRow> {
  if (conversationIds.length === 0) {
    return new Map();
  }
  const rows = orm.all<TargetRow>(
    sql`SELECT v.id AS conversation_id, c.id AS chat_id, c.host_kind, c.telegram_chat_id, c.type AS chat_type,
               c.title AS chat_title, v.message_thread_id
        FROM conversations v JOIN chats c ON c.id = v.chat_id
        WHERE v.id IN (${sql.join(
          conversationIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
  );
  return new Map(rows.map((row) => [row.conversation_id.toString(), row]));
}

function lastFirings(orm: Orm, alarmIds: readonly bigint[]): Map<string, RecurringFiringView> {
  if (alarmIds.length === 0) {
    return new Map();
  }
  const rows = orm.all<FiringRow>(
    sql`${FIRING_SELECT}
        WHERE f.id IN (
          SELECT max(id) FROM recurring_alarm_firings
          WHERE recurring_alarm_id IN (${sql.join(
            alarmIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          GROUP BY recurring_alarm_id
        )`,
  );
  return new Map(rows.map((row) => [row.recurring_alarm_id.toString(), firingView(row)]));
}

function views(orm: Orm, records: readonly RecurringAlarmRecord[]): RecurringAlarmView[] {
  const targets = targetsOf(
    orm,
    records.map((record) => record.conversationId),
  );
  const firings = lastFirings(
    orm,
    records.map((record) => record.id),
  );
  return records.map((record) => {
    const target = targets.get(record.conversationId.toString());
    if (target === undefined) {
      throw new Error('recurring alarm target conversation is missing');
    }
    return {
      id: record.id.toString(),
      revision: record.revision.toString(),
      title: record.title,
      prompt: record.prompt,
      rules: record.rules,
      input_mode: record.inputMode,
      time_zone: record.timeZone,
      enabled: record.enabled,
      next_fire_at: record.nextFireAt,
      created_by: record.createdBy,
      updated_by: record.updatedBy,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      target: targetView(target),
      last_firing: firings.get(record.id.toString()) ?? null,
    };
  });
}

export function recurringAlarmView(orm: Orm, record: RecurringAlarmRecord): RecurringAlarmView {
  const [view] = views(orm, [record]);
  if (view === undefined) {
    throw new Error('recurring alarm view is missing');
  }
  return view;
}

export interface RecurringListQuery {
  readonly limit?: string | null;
  readonly offset?: string | null;
  readonly as_of?: string | null;
  /** Telegram chat id, the deep-link filter every page shares. */
  readonly chat?: string | null;
  readonly enabled?: string | null;
}

/**
 * Enabled alarms first in firing order, then the disabled ones newest first.
 * The snapshot is the definition id; edits stay live.
 */
export function listRecurringAlarms(
  orm: Orm,
  query: RecurringListQuery,
  load: (ids: readonly bigint[]) => RecurringAlarmRecord[],
): Page<RecurringAlarmView> {
  const window = parseWindow(query);
  const snapshot = idSnapshot(orm, recurringAlarms.id, sql`a.id`, query.as_of);
  const conditions: SQL[] = [];
  if (query.chat) {
    conditions.push(sql`c.telegram_chat_id = ${parseId(query.chat, 'chat')}`);
  }
  if (query.enabled) {
    if (query.enabled !== 'true' && query.enabled !== 'false') {
      throw new AdminQueryError('invalid_enabled', 'enabled must be true or false');
    }
    conditions.push(sql`a.enabled = ${query.enabled === 'true' ? 1 : 0}`);
  }
  const from = sql`FROM recurring_alarms a JOIN conversations v ON v.id = a.conversation_id JOIN chats c ON c.id = v.chat_id`;
  const counts = snapshotCounts(snapshot);
  const [count] = orm.all<{ readonly total: unknown; readonly fresh: unknown }>(
    sql`SELECT ${counts.total} AS total, ${counts.fresh} AS fresh ${from} ${whereSql(conditions)}`,
  );
  const ids = orm
    .all<{ id: bigint }>(
      sql`SELECT a.id ${from} ${whereSql([...conditions, snapshot.within])}
          ORDER BY a.enabled DESC, a.next_fire_at IS NULL, a.next_fire_at, a.id DESC
          LIMIT ${BigInt(window.limit)} OFFSET ${BigInt(window.offset)}`,
    )
    .map((row) => row.id);
  return snapshotPage(views(orm, load(ids)), count, window, snapshot);
}

/** The definition plus its most recent firings, each joined to its delivery. */
export function recurringAlarmDetail(
  orm: Orm,
  record: RecurringAlarmRecord,
): RecurringAlarmView & { readonly firings: readonly RecurringFiringView[] } {
  const firings = orm
    .all<FiringRow>(
      sql`${FIRING_SELECT} WHERE f.recurring_alarm_id = ${record.id} ORDER BY f.id DESC LIMIT ${BigInt(RECURRING_DETAIL_FIRINGS)}`,
    )
    .map(firingView);
  return { ...recurringAlarmView(orm, record), firings };
}
