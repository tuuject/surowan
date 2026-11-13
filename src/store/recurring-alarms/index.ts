import { and, count, eq } from 'drizzle-orm';
import { RECURRING_PER_CONVERSATION_MAX, type RecurringScheduleEngine } from '../../platform/recurring-schedule.ts';
import { deliveryBlockReason, deliveryTarget } from '../delivery-target.ts';
import type { TimerSource } from '../long-tasks/index.ts';
import { conversations, recurringAlarmFirings, recurringAlarms } from '../schema/index.ts';
import {
  createOccurrenceTask,
  hasUndelivered,
  loadAlarm,
  materializeDueOccurrences,
  nextDueInstant,
  nextOccurrence,
  type OccurrenceDeps,
  servesHost,
  suppressUndelivered,
} from './occurrences.ts';
import {
  type RecurringAlarmDraft,
  RecurringAlarmError,
  type RecurringAlarmRecord,
  toRecord,
  validateDraft,
} from './records.ts';

export type RecurringAlarmServiceOptions = OccurrenceDeps;

/**
 * Admin-defined schedules that inject a trusted prompt into one Conversation.
 *
 * Each due occurrence becomes an ordinary, already-due timer task of the
 * `recurring-alarm` plugin id, so the receipt pipeline delivers it exactly like
 * a one-shot alarm: attached to a running Invocation or in a new one, past the
 * daily budget and the sleep window. The service is a timer source of the
 * Scheduler's task service; only the persisted `next_fire_at` tells the host
 * when to wake.
 */
export class RecurringAlarmService implements TimerSource {
  readonly #deps: OccurrenceDeps;

  constructor(options: RecurringAlarmServiceOptions) {
    this.#deps = options;
  }

  get engine(): RecurringScheduleEngine {
    return this.#deps.engine;
  }

  get(id: bigint): RecurringAlarmRecord | undefined {
    return loadAlarm(this.#deps, id);
  }

  /**
   * Finds or creates the Conversation of one Chat and thread. A Topic on the
   * allowlist may have no Conversation yet because nobody wrote there; the
   * row is keyed exactly like ingestion's, so later messages join it.
   */
  ensureConversation(chatId: bigint, messageThreadId: bigint, now = new Date()): bigint {
    const { orm } = this.#deps.store;
    const at = now.toISOString();
    orm
      .insert(conversations)
      .values({ chatId, messageThreadId, createdAt: at, updatedAt: at })
      .onConflictDoNothing({ target: [conversations.chatId, conversations.messageThreadId] })
      .run();
    const row = orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, messageThreadId)))
      .get();
    if (row === undefined) {
      throw new Error('Conversation upsert returned no row');
    }
    return row.id;
  }

  create(conversationId: bigint, draft: RecurringAlarmDraft, actor: string, now = new Date()): RecurringAlarmRecord {
    const { store, engine } = this.#deps;
    const valid = validateDraft(engine, draft, now);
    const at = now.toISOString();
    const created = store.transaction(() => {
      this.#assertDeliverable(conversationId);
      const existing =
        store.orm
          .select({ value: count() })
          .from(recurringAlarms)
          .where(eq(recurringAlarms.conversationId, conversationId))
          .get()?.value ?? 0;
      if (existing >= RECURRING_PER_CONVERSATION_MAX) {
        throw new RecurringAlarmError(
          'too_many_recurring_alarms',
          `A conversation holds at most ${RECURRING_PER_CONVERSATION_MAX} recurring alarms`,
        );
      }
      const row = store.orm
        .insert(recurringAlarms)
        .values({
          conversationId,
          title: valid.title,
          prompt: draft.prompt,
          rulesJson: JSON.stringify(valid.rules),
          inputMode: draft.inputMode,
          timeZone: valid.timeZone,
          enabled: draft.enabled,
          nextFireAt: draft.enabled ? nextOccurrence(this.#deps, valid.rules, valid.timeZone, now) : null,
          createdBy: actor,
          updatedBy: actor,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
      if (row === undefined) {
        throw new Error('recurring_alarms insert returned no row');
      }
      return toRecord(row);
    });
    this.#deps.tasks.wake();
    return created;
  }

  /**
   * Replaces a definition under its revision. A new schedule, time zone or a
   * re-enable recomputes the next occurrence from now; a prompt edit only
   * affects later occurrences. Disabling suppresses the delivery of an
   * occurrence that has not been claimed yet. The target is not checked here,
   * so an alarm of a paused Chat can still be fixed or disabled.
   */
  update(
    id: bigint,
    expectedRevision: bigint,
    draft: RecurringAlarmDraft,
    actor: string,
    now = new Date(),
  ): RecurringAlarmRecord {
    const { store, engine } = this.#deps;
    const valid = validateDraft(engine, draft, now);
    const updated = store.transaction(() => {
      const current = this.#require(id);
      if (current.revision !== expectedRevision) {
        throw new RecurringAlarmError('revision_conflict', 'The recurring alarm changed; reload before editing');
      }
      const rulesJson = JSON.stringify(valid.rules);
      const scheduleChanged =
        rulesJson !== JSON.stringify(current.rules) || valid.timeZone !== current.timeZone || !current.enabled;
      const nextFireAt = !draft.enabled
        ? null
        : scheduleChanged
          ? nextOccurrence(this.#deps, valid.rules, valid.timeZone, now)
          : current.nextFireAt;
      const row = store.orm
        .update(recurringAlarms)
        .set({
          title: valid.title,
          prompt: draft.prompt,
          rulesJson,
          inputMode: draft.inputMode,
          timeZone: valid.timeZone,
          enabled: draft.enabled,
          nextFireAt,
          revision: current.revision + 1n,
          updatedBy: actor,
          updatedAt: now.toISOString(),
        })
        .where(and(eq(recurringAlarms.id, id), eq(recurringAlarms.revision, expectedRevision)))
        .returning()
        .get();
      if (row === undefined) {
        throw new RecurringAlarmError('revision_conflict', 'The recurring alarm changed; reload before editing');
      }
      if (current.enabled && !draft.enabled) {
        suppressUndelivered(this.#deps, current, actor, 'recurring_alarm_disabled', now);
      }
      return toRecord(row);
    });
    this.#deps.tasks.wake();
    return updated;
  }

  /** Deletes a definition and its firing history; tasks it created stay as audit rows. */
  delete(id: bigint, actor: string, now = new Date()): void {
    const { store } = this.#deps;
    store.transaction(() => {
      const current = this.#require(id);
      suppressUndelivered(this.#deps, current, actor, 'recurring_alarm_deleted', now);
      store.orm.delete(recurringAlarms).where(eq(recurringAlarms.id, id)).run();
    });
    this.#deps.tasks.wake();
  }

  /**
   * One extra occurrence now, from the saved definition. It travels the same
   * path as a scheduled one but never touches the schedule; it works while the
   * alarm is disabled, and it is refused instead of queued while an earlier
   * occurrence is still undelivered.
   */
  runNow(
    id: bigint,
    actor: string,
    now = new Date(),
  ): { readonly firingId: bigint; readonly taskId: bigint; readonly occurrenceAt: string } {
    const { store, config } = this.#deps;
    const at = now.toISOString();
    const result = store.transaction(() => {
      const current = this.#require(id);
      const target = deliveryTarget(store.orm, current.conversationId);
      if (
        target === undefined ||
        !servesHost(this.#deps, target.hostKind) ||
        deliveryBlockReason(store.orm, config(), target) !== undefined
      ) {
        throw new RecurringAlarmError('target_unavailable', 'The target conversation cannot receive messages now');
      }
      if (hasUndelivered(this.#deps, id)) {
        throw new RecurringAlarmError('previous_pending', 'The previous occurrence has not been delivered yet');
      }
      const firing = store.orm
        .insert(recurringAlarmFirings)
        .values({
          recurringAlarmId: id,
          source: 'manual',
          occurrenceAt: at,
          outcome: 'scheduled',
          coalesced: 0n,
          triggeredBy: actor,
          createdAt: at,
        })
        .returning({ id: recurringAlarmFirings.id })
        .get();
      if (firing === undefined) {
        throw new Error('recurring_alarm_firings insert returned no row');
      }
      const taskId = createOccurrenceTask(this.#deps, current, 'manual', at, 0, now);
      store.orm.update(recurringAlarmFirings).set({ taskId }).where(eq(recurringAlarmFirings.id, firing.id)).run();
      return { firingId: firing.id, taskId, occurrenceAt: at };
    });
    this.#deps.tasks.wake();
    return result;
  }

  materializeDue(now: Date): void {
    materializeDueOccurrences(this.#deps, now);
  }

  nextDeadline(): string | undefined {
    return nextDueInstant(this.#deps);
  }

  #assertDeliverable(conversationId: bigint): void {
    const { store, config } = this.#deps;
    const target = deliveryTarget(store.orm, conversationId);
    if (target === undefined || deliveryBlockReason(store.orm, config(), target) !== undefined) {
      throw new RecurringAlarmError('target_unavailable', 'The target conversation cannot receive messages now');
    }
  }

  #require(id: bigint): RecurringAlarmRecord {
    const current = this.get(id);
    if (current === undefined) {
      throw new RecurringAlarmError('not_found', 'Recurring alarm does not exist');
    }
    return current;
  }
}
