import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import { HOST_KINDS, type HostKind } from '../../platform/im-host/identity.ts';
import {
  countOccurrences,
  RECURRING_MISSED_GRACE_MS,
  type RecurringScheduleEngine,
} from '../../platform/recurring-schedule.ts';
import { deliveryBlockReason, deliveryTarget } from '../delivery-target.ts';
import type { LongTaskService } from '../long-tasks/index.ts';
import { longTasks, recurringAlarmFirings, recurringAlarms, taskReceipts } from '../schema/index.ts';
import { asRunResult, type BusinessStore } from '../store.ts';
import { RECURRING_ALARM_PLUGIN_ID, type RecurringAlarmPayload } from './payload.ts';
import { type RecurringAlarmRecord, toRecord } from './records.ts';

/** The collaborators every occurrence operation shares with the service. */
export interface OccurrenceDeps {
  readonly store: BusinessStore;
  readonly engine: RecurringScheduleEngine;
  /** The Scheduler's task service; its host scope is the alarms' scope too. */
  readonly tasks: LongTaskService;
  readonly config: () => RawConfig;
  /**
   * Whether a host can run work right now; every host when absent. A host
   * that is down (Telegram disabled or disconnected) neither fires nor wakes
   * the Scheduler: its occurrences wait, and once it is back the missed-run
   * rule decides whether they still go out, instead of a stale receipt
   * arriving hours late.
   */
  readonly isHostReady?: (host: HostKind) => boolean;
}

/** A write raced another one inside the same occurrence; the next pass recomputes it. */
export class OccurrenceRaceError extends Error {}

export function loadAlarm(deps: OccurrenceDeps, id: bigint): RecurringAlarmRecord | undefined {
  const row = deps.store.orm.select().from(recurringAlarms).where(eq(recurringAlarms.id, id)).get();
  return row === undefined ? undefined : toRecord(row);
}

export function nextOccurrence(
  deps: OccurrenceDeps,
  rules: readonly string[],
  timeZone: string,
  now: Date,
): string | null {
  return deps.engine.nextAfter(rules, timeZone, now)?.toISOString() ?? null;
}

/** The task service's host scope narrowed to the hosts that are ready now. */
function readyHosts(deps: OccurrenceDeps): readonly HostKind[] {
  const scope = deps.tasks.hosts ?? HOST_KINDS;
  return scope.filter((host) => deps.isHostReady?.(host) ?? true);
}

/** The host filter of due and deadline queries (`c` is the chat). */
export function hostScope(deps: OccurrenceDeps): SQL {
  const hosts = readyHosts(deps);
  if (hosts.length === 0) {
    return sql`1 = 0`;
  }
  return sql`c.host_kind IN (${sql.join(
    hosts.map((host) => sql`${host}`),
    sql`, `,
  )})`;
}

/** Whether this process can run an occurrence for that host right now. */
export function servesHost(deps: OccurrenceDeps, hostKind: string): boolean {
  return readyHosts(deps).some((host) => host === hostKind);
}

/** True while an earlier occurrence's task waits or its receipt is not handled yet. */
export function hasUndelivered(deps: OccurrenceDeps, id: bigint): boolean {
  return (
    deps.store.orm
      .all<{ present: bigint }>(
        sql`SELECT 1 AS present FROM recurring_alarm_firings f
            JOIN long_tasks t ON t.id = f.task_id
            LEFT JOIN task_receipts r ON r.task_id = t.id
            WHERE f.recurring_alarm_id = ${id}
              AND (t.state = 'waiting' OR r.state IN ('pending', 'claimed'))
            LIMIT 1`,
      )
      .at(0) !== undefined
  );
}

/** Cancels the alarm's tasks whose delivery has not been claimed yet. */
export function suppressUndelivered(
  deps: OccurrenceDeps,
  alarm: RecurringAlarmRecord,
  actor: string,
  reason: string,
  now: Date,
): void {
  const tasks = deps.store.orm
    .select({ id: longTasks.id })
    .from(recurringAlarmFirings)
    .innerJoin(longTasks, eq(longTasks.id, recurringAlarmFirings.taskId))
    .leftJoin(taskReceipts, eq(taskReceipts.taskId, longTasks.id))
    .where(
      and(
        eq(recurringAlarmFirings.recurringAlarmId, alarm.id),
        sql`(${longTasks.state} = 'waiting' OR ${taskReceipts.state} = 'pending')`,
      ),
    )
    .orderBy(asc(longTasks.id))
    .all();
  const scope = deps.tasks.scoped(RECURRING_ALARM_PLUGIN_ID, alarm.conversationId);
  for (const task of tasks) {
    scope.cancel(task.id, { cancelledBy: actor, adminCancelled: true, reason }, now);
  }
}

/** One already-due timer task: the same Scheduler pass completes it and claims its receipt. */
export function createOccurrenceTask(
  deps: OccurrenceDeps,
  alarm: RecurringAlarmRecord,
  source: 'schedule' | 'manual',
  occurrenceAt: string,
  coalesced: number,
  now: Date,
): bigint {
  const payload: RecurringAlarmPayload = {
    recurring_alarm_id: alarm.id.toString(),
    source,
    title: alarm.title,
    prompt: alarm.prompt,
    time_zone: alarm.timeZone,
    occurrence_at: occurrenceAt,
    coalesced,
  };
  return deps.tasks.taskScope(RECURRING_ALARM_PLUGIN_ID, alarm.conversationId, null).create(
    {
      payload,
      scheduledAt: occurrenceAt,
      timerResult: { occurrence_at: occurrenceAt },
      delivery: { bypassDailyBudget: true },
    },
    now,
  ).taskId;
}

/**
 * Handles one due occurrence in a single transaction: decide whether it is
 * delivered or skipped, record the firing, create the task, and advance
 * `next_fire_at`. Any failure rolls all of it back, the nested task write
 * included (better-sqlite3 turns it into a savepoint).
 */
export function fireScheduledOccurrence(deps: OccurrenceDeps, id: bigint, now: Date): void {
  const at = now.toISOString();
  const { store } = deps;
  store.transaction(() => {
    const current = loadAlarm(deps, id);
    if (current === undefined || !current.enabled || current.nextFireAt === null || current.nextFireAt > at) {
      return;
    }
    const due = current.nextFireAt;
    const dueDate = new Date(due);
    // Occurrences after `due` that also passed while nothing ran fold into this one.
    const coalesced = countOccurrences(deps.engine, current.rules, current.timeZone, dueDate, now);
    const target = deliveryTarget(store.orm, current.conversationId);
    const skipReason =
      now.getTime() - dueDate.getTime() > RECURRING_MISSED_GRACE_MS
        ? 'missed'
        : target === undefined
          ? 'chat_removed'
          : (deliveryBlockReason(store.orm, deps.config(), target) ??
            (hasUndelivered(deps, id) ? 'previous_pending' : undefined));
    const firing = store.orm
      .insert(recurringAlarmFirings)
      .values({
        recurringAlarmId: id,
        source: 'schedule',
        occurrenceAt: due,
        outcome: skipReason === undefined ? 'scheduled' : 'skipped',
        skipReason: skipReason ?? null,
        coalesced: BigInt(coalesced),
        createdAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: recurringAlarmFirings.id })
      .get();
    if (firing !== undefined && skipReason === undefined) {
      const taskId = createOccurrenceTask(deps, current, 'schedule', due, coalesced, now);
      store.orm.update(recurringAlarmFirings).set({ taskId }).where(eq(recurringAlarmFirings.id, firing.id)).run();
    }
    const advanced = store.orm
      .update(recurringAlarms)
      .set({ nextFireAt: nextOccurrence(deps, current.rules, current.timeZone, now) })
      .where(and(eq(recurringAlarms.id, id), eq(recurringAlarms.nextFireAt, due), eq(recurringAlarms.enabled, true)))
      .run();
    if (asRunResult(advanced).changes !== 1) {
      throw new OccurrenceRaceError('recurring alarm changed while its occurrence was handled');
    }
  });
}

/** Every due alarm of this process's hosts, each in its own transaction. */
export function materializeDueOccurrences(deps: OccurrenceDeps, now: Date): void {
  const at = now.toISOString();
  const due = deps.store.orm.all<{ id: bigint }>(
    sql`SELECT a.id FROM recurring_alarms a
        JOIN conversations v ON v.id = a.conversation_id
        JOIN chats c ON c.id = v.chat_id
        WHERE a.enabled = 1 AND a.next_fire_at IS NOT NULL AND a.next_fire_at <= ${at} AND ${hostScope(deps)}
        ORDER BY a.next_fire_at, a.id`,
  );
  for (const { id } of due) {
    try {
      fireScheduledOccurrence(deps, id, now);
    } catch (error) {
      if (error instanceof OccurrenceRaceError) {
        continue;
      }
      // A definition the engine cannot evaluate any more must not make the
      // Scheduler spin on a past deadline: park it until an Admin saves it.
      deps.store.orm.update(recurringAlarms).set({ nextFireAt: null }).where(eq(recurringAlarms.id, id)).run();
      console.log(
        JSON.stringify({
          event: 'recurring_alarm_failed',
          recurring_alarm_id: id.toString(),
          message: error instanceof Error ? error.message : String(error),
          at,
        }),
      );
    }
  }
}

export function nextDueInstant(deps: OccurrenceDeps): string | undefined {
  return (
    deps.store.orm
      .all<{ next_fire_at: string }>(
        sql`SELECT a.next_fire_at FROM recurring_alarms a
            JOIN conversations v ON v.id = a.conversation_id
            JOIN chats c ON c.id = v.chat_id
            WHERE a.enabled = 1 AND a.next_fire_at IS NOT NULL AND ${hostScope(deps)}
            ORDER BY a.next_fire_at, a.id LIMIT 1`,
      )
      .at(0)?.next_fire_at ?? undefined
  );
}
