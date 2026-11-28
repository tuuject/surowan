import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  CompletionContext,
  DeliveryPolicy,
  InvocationContext,
  JsonValue,
} from '../../platform/invocation-context.ts';
import { parseHostKind, type HostKind } from '../../platform/im-host/identity.ts';
import type { Orm } from '../store.ts';
import { chats, conversations, longTasks, taskReceipts } from '../schema/index.ts';
import { deliveryText, readDelivery } from './delivery.ts';
import { MAX_JSON, jsonText, parseJson } from './json.ts';
import { getTask, listTasks } from './list.ts';
import { assertInvocationQuota, type InvocationQuota, invocationAtQuota, TaskQuotaError } from './quota.ts';
import { cancelTask, finishTask } from './settle.ts';

export interface ListedTask {
  readonly id: bigint;
  readonly payload: JsonValue;
  readonly state: 'waiting' | 'completed' | 'failed' | 'cancelled';
  readonly scheduledAt: string | null;
  readonly createdAt: string;
}

export interface CreateTaskInput {
  readonly payload: unknown;
  readonly delivery?: DeliveryPolicy;
  readonly scheduledAt?: string;
  readonly timerResult?: unknown;
  readonly invocationQuota?: InvocationQuota;
}

export interface CancelOptions {
  readonly cancelledBy?: string;
  readonly adminCancelled?: boolean;
  readonly reason?: string;
}

export interface CompletionOptions {
  readonly notify?: boolean;
}

export interface PluginTaskScope {
  create(input: CreateTaskInput, now?: Date): { readonly taskId: bigint; readonly scheduledAt: string | null };
  get(taskId: bigint): ListedTask | undefined;
  list(): readonly ListedTask[];
  complete(taskId: bigint, result?: unknown, options?: CompletionOptions, now?: Date): boolean;
  fail(taskId: bigint, error?: unknown, options?: CompletionOptions, now?: Date): boolean;
  cancel(taskId: bigint, options?: CancelOptions, now?: Date): boolean;
}

/**
 * A schedule that produces timer tasks of its own, such as recurring alarms.
 * The service lets every source create the tasks that are due before it
 * completes due timers, and wakes for the earliest instant any source names.
 */
export interface TimerSource {
  materializeDue(now: Date): void;
  /** The earliest instant this source has work, as canonical UTC ISO-8601. */
  nextDeadline(): string | undefined;
}

function canonicalIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error('scheduledAt must be canonical UTC ISO-8601');
  }
  return value;
}

export class LongTaskService {
  readonly #orm: Orm;
  readonly #wake: (() => void) | undefined;
  /**
   * Hosts whose timer work this instance may complete. Undefined means every
   * host (the shared process); a single-host process passes its own set so a
   * due Telegram alarm is never fired by a scheduler that does not serve
   * Telegram.
   */
  readonly #hosts: readonly HostKind[] | undefined;
  readonly #sources: TimerSource[] = [];

  constructor(orm: Orm, wake?: () => void, hosts?: readonly HostKind[]) {
    this.#orm = orm;
    this.#wake = wake;
    this.#hosts = hosts === undefined || hosts.length === 0 ? undefined : hosts;
  }

  /** Registers a schedule whose due occurrences become timer tasks of this service. */
  addTimerSource(source: TimerSource): void {
    this.#sources.push(source);
  }

  /** Asks the host to run the Scheduler loop now, as task writes do. */
  wake(): void {
    this.#wake?.();
  }

  /**
   * Whether the invocation already holds `quota.max` tasks of the plugin under
   * the quota's counting rule. Task creation re-checks this inside its write
   * transaction; a creator whose paid work starts before its task exists asks
   * here first, so both decisions use the same rule.
   */
  atInvocationQuota(pluginId: string, invocationId: bigint, quota: InvocationQuota): boolean {
    return invocationAtQuota(this.#orm, pluginId, invocationId, quota);
  }

  /** The hosts whose timers this instance completes; undefined means every host. */
  get hosts(): readonly HostKind[] | undefined {
    return this.#hosts;
  }

  /** The host filter for one query, or undefined when this instance serves all hosts. */
  #hostScope(): SQL | undefined {
    const hosts = this.#hosts;
    if (hosts === undefined) {
      return undefined;
    }
    return sql`c.host_kind IN (${sql.join(
      hosts.map((host) => sql`${host}`),
      sql`, `,
    )})`;
  }

  /**
   * Scope bound to a fixed invocation id, for creators acting outside a live
   * invocation (completion bridges): quota accounting still attributes the task
   * to the invocation that submitted the work.
   */
  taskScope(pluginId: string, conversationId: bigint, invocationId: bigint | null): PluginTaskScope {
    return this.#scope(
      pluginId,
      conversationId,
      () => invocationId,
      () => null,
      false,
    );
  }

  scoped(pluginId: string, conversationId: bigint): PluginTaskScope {
    return this.#scope(
      pluginId,
      conversationId,
      () => null,
      () => null,
      false,
    );
  }

  /**
   * Scope for a plugin acting inside a live invocation.
   *
   * The plugin must be registered for the host that owns the conversation.
   * Without this check a tool that is not mounted on a host could still create
   * work for it through the generic task service and bypass the tool layer.
   */
  invocationScope(pluginId: string, liveContext: InvocationContext, hosts: readonly HostKind[]): PluginTaskScope {
    this.#assertPluginHost(pluginId, liveContext.conversationId, hosts);
    return this.#scope(
      pluginId,
      liveContext.conversationId,
      () => liveContext.invocationId,
      () => liveContext.callerUserId,
      true,
    );
  }

  #assertPluginHost(pluginId: string, conversationId: bigint, hosts: readonly HostKind[]): void {
    // The host is read from the stored row on every scope: conversation ids
    // are recycled after a chat deletion, so a cached answer could admit a
    // plugin to a conversation of a host it does not serve.
    const [row] = this.#orm
      .select({ hostKind: chats.hostKind })
      .from(conversations)
      .innerJoin(chats, eq(conversations.chatId, chats.id))
      .where(eq(conversations.id, conversationId))
      .all();
    if (row === undefined) {
      throw new Error(`Plugin ${pluginId}: conversation ${conversationId} does not exist`);
    }
    const hostKind = parseHostKind(row.hostKind);
    if (!hosts.includes(hostKind)) {
      throw new Error(`Plugin ${pluginId} is not enabled on the ${hostKind} host`);
    }
  }

  #scope(
    pluginId: string,
    conversationId: bigint,
    invocation: () => bigint | null,
    caller: () => bigint | null,
    restricted: boolean,
  ): PluginTaskScope {
    return {
      create: (input, now) => this.#create(pluginId, conversationId, invocation(), caller(), input, now),
      get: (taskId) => this.#get(pluginId, conversationId, taskId, caller(), restricted),
      list: () => this.#list(pluginId, conversationId, caller(), restricted),
      complete: (taskId, result, options, now) =>
        this.#finish(pluginId, conversationId, taskId, 'completed', result, options, now),
      fail: (taskId, error, options, now) =>
        this.#finish(pluginId, conversationId, taskId, 'failed', error, options, now),
      cancel: (taskId, options, now) =>
        this.#cancel(pluginId, conversationId, taskId, caller(), restricted, options, now),
    };
  }

  #create(
    pluginId: string,
    conversationId: bigint,
    invocationId: bigint | null,
    callerId: bigint | null,
    input: CreateTaskInput,
    now = new Date(),
  ): { taskId: bigint; scheduledAt: string | null } {
    const payloadJson = jsonText(input.payload, MAX_JSON, 'payload');
    const scheduledAt = input.scheduledAt === undefined ? null : canonicalIso(input.scheduledAt);
    const timerResultJson =
      scheduledAt === null
        ? input.timerResult === undefined
          ? null
          : (() => {
              throw new Error('timerResult requires scheduledAt');
            })()
        : jsonText(input.timerResult === undefined ? input.payload : input.timerResult, MAX_JSON, 'timerResult');
    const quota = input.invocationQuota;
    if (quota !== undefined) {
      assertInvocationQuota(quota);
      if (invocationId === null) {
        throw new Error('invocationQuota requires an invocation');
      }
    }
    const deliveryJson = deliveryText(input.delivery);
    const at = now.toISOString();
    const created = this.#orm.transaction(
      () => {
        if (quota !== undefined && invocationId !== null && this.atInvocationQuota(pluginId, invocationId, quota)) {
          throw new TaskQuotaError();
        }
        const row = this.#orm
          .insert(longTasks)
          .values({
            pluginId,
            conversationId,
            createdByInvocationId: invocationId,
            createdByUserId: callerId,
            payloadJson,
            state: 'waiting',
            scheduledAt,
            timerResultJson,
            deliveryJson,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: longTasks.id, scheduledAt: longTasks.scheduledAt })
          .get();
        if (row === undefined) {
          throw new Error('Task creation returned no row');
        }
        return row;
      },
      { behavior: 'immediate' },
    );
    this.#wake?.();
    return { taskId: created.id, scheduledAt: created.scheduledAt };
  }

  #get(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    callerId: bigint | null,
    restricted: boolean,
  ): ListedTask | undefined {
    return getTask(this.#orm, pluginId, conversationId, taskId, callerId, restricted);
  }

  #list(pluginId: string, conversationId: bigint, callerId: bigint | null, restricted: boolean): ListedTask[] {
    return listTasks(this.#orm, pluginId, conversationId, callerId, restricted);
  }

  #finish(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    status: 'completed' | 'failed',
    value: unknown | undefined,
    options: CompletionOptions | undefined,
    now = new Date(),
  ): boolean {
    const changed = finishTask(this.#orm, pluginId, conversationId, taskId, status, value, options, now);
    if (changed) {
      this.#wake?.();
    }
    return changed;
  }

  /**
   * Cancels waiting tasks and suppresses still-pending receipts for every given
   * Conversation. Used when a Chat leaves the configuration: its runs must stop,
   * but the data stays until an Admin deletes it.
   */
  cancelForConversations(conversationIds: readonly bigint[], reason = 'chat_removed'): number {
    if (conversationIds.length === 0) {
      return 0;
    }
    const rows = this.#orm
      .select({ id: longTasks.id, pluginId: longTasks.pluginId, conversationId: longTasks.conversationId })
      .from(longTasks)
      .where(
        and(
          inArray(longTasks.conversationId, [...conversationIds]),
          inArray(longTasks.state, ['waiting', 'completed']),
        ),
      )
      .all();
    let cancelled = 0;
    for (const row of rows) {
      if (
        this.#cancel(row.pluginId, row.conversationId, row.id, null, false, {
          adminCancelled: true,
          reason,
        })
      ) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  #cancel(
    pluginId: string,
    conversationId: bigint,
    taskId: bigint,
    callerId: bigint | null,
    restricted: boolean,
    options: CancelOptions | undefined,
    now = new Date(),
  ): boolean {
    const changed = cancelTask(this.#orm, pluginId, conversationId, taskId, callerId, restricted, options, now);
    if (changed) {
      this.#wake?.();
    }
    return changed;
  }

  processDue(now: Date): void {
    for (const source of this.#sources) {
      source.materializeDue(now);
    }
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const scope = this.#hostScope();
        const due =
          scope === undefined
            ? this.#orm
                .select({ id: longTasks.id, timerResultJson: longTasks.timerResultJson })
                .from(longTasks)
                .where(and(eq(longTasks.state, 'waiting'), sql`${longTasks.scheduledAt} <= ${at}`))
                .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
                .all()
            : this.#orm.all<{ id: bigint; timerResultJson: string | null }>(
                sql`SELECT t.id, t.timer_result_json AS timerResultJson FROM long_tasks t
                    JOIN conversations v ON v.id = t.conversation_id
                    JOIN chats c ON c.id = v.chat_id
                    WHERE t.state = 'waiting' AND t.scheduled_at <= ${at} AND ${scope}
                    ORDER BY t.scheduled_at, t.id`,
              );
        let count = 0;
        for (const task of due) {
          if (task.timerResultJson === null) {
            throw new Error('Timer task has no timer result');
          }
          const update = this.#orm
            .update(longTasks)
            .set({ state: 'completed', finishedAt: at, updatedAt: at })
            .where(and(eq(longTasks.id, task.id), eq(longTasks.state, 'waiting')))
            .run();
          if (update.changes === 0) {
            continue;
          }
          this.#orm
            .insert(taskReceipts)
            .values({
              taskId: task.id,
              status: 'completed',
              resultJson: task.timerResultJson,
              state: 'pending',
              createdAt: at,
              updatedAt: at,
            })
            .run();
          count += 1;
        }
        return count;
      },
      { behavior: 'immediate' },
    );
    if (changed > 0) {
      this.#wake?.();
    }
  }

  nextDeadline(): string | undefined {
    let earliest = this.#timerDeadline();
    for (const source of this.#sources) {
      const deadline = source.nextDeadline();
      if (deadline !== undefined && (earliest === undefined || deadline < earliest)) {
        earliest = deadline;
      }
    }
    return earliest;
  }

  #timerDeadline(): string | undefined {
    const scope = this.#hostScope();
    if (scope === undefined) {
      return (
        this.#orm
          .select({ scheduledAt: longTasks.scheduledAt })
          .from(longTasks)
          .where(and(eq(longTasks.state, 'waiting'), sql`${longTasks.scheduledAt} IS NOT NULL`))
          .orderBy(asc(longTasks.scheduledAt), asc(longTasks.id))
          .get()?.scheduledAt ?? undefined
      );
    }
    return (
      this.#orm
        .all<{ scheduled_at: string | null }>(
          sql`SELECT t.scheduled_at FROM long_tasks t
              JOIN conversations v ON v.id = t.conversation_id
              JOIN chats c ON c.id = v.chat_id
              WHERE t.state = 'waiting' AND t.scheduled_at IS NOT NULL AND ${scope}
              ORDER BY t.scheduled_at, t.id LIMIT 1`,
        )
        .at(0)?.scheduled_at ?? undefined
    );
  }

  getCompletion(invocationId: bigint, bucketId: bigint): CompletionContext | undefined {
    const row = this.#orm
      .select({
        taskId: taskReceipts.taskId,
        pluginId: longTasks.pluginId,
        payloadJson: longTasks.payloadJson,
        status: taskReceipts.status,
        resultJson: taskReceipts.resultJson,
        errorJson: taskReceipts.errorJson,
        deliveryJson: longTasks.deliveryJson,
      })
      .from(taskReceipts)
      .innerJoin(longTasks, eq(taskReceipts.taskId, longTasks.id))
      .where(and(eq(taskReceipts.invocationId, invocationId), eq(taskReceipts.bucketId, bucketId)))
      .get();
    if (row === undefined) {
      return undefined;
    }
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled') {
      throw new Error('Invalid receipt status in database');
    }
    return {
      taskId: row.taskId,
      pluginId: row.pluginId,
      payload: parseJson(row.payloadJson, 'task payload'),
      status: row.status,
      delivery: readDelivery(row.deliveryJson),
      ...(row.resultJson === null ? {} : { resultJson: parseJson(row.resultJson, 'receipt result') }),
      ...(row.errorJson === null ? {} : { errorJson: parseJson(row.errorJson, 'receipt error') }),
    };
  }
}
