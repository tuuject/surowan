import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  CompletionContext,
  DeliveryPolicy,
  InvocationContext,
  JsonValue,
} from '../../platform/invocation-context.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { Orm } from '../store.ts';
import { chats, conversations, longTasks, taskReceipts } from '../schema/index.ts';
import { deliveryText, readDelivery } from './delivery.ts';
import { MAX_ERROR, MAX_JSON, jsonText, parseJson } from './json.ts';
import { getTask, listTasks } from './list.ts';

export class TaskQuotaError extends Error {
  constructor() {
    super('Task quota exceeded for this invocation');
    this.name = 'TaskQuotaError';
  }
}

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
  readonly maxPerInvocation?: number;
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
  readonly #conversationHosts = new Map<string, HostKind>();
  /**
   * Hosts whose timer work this instance may complete. Undefined means every
   * host (the shared process); a single-host process passes its own set so a
   * due Telegram alarm is never fired by a scheduler that does not serve
   * Telegram.
   */
  readonly #hosts: readonly HostKind[] | undefined;

  constructor(orm: Orm, wake?: () => void, hosts?: readonly HostKind[]) {
    this.#orm = orm;
    this.#wake = wake;
    this.#hosts = hosts === undefined || hosts.length === 0 ? undefined : hosts;
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
  invocationScope(
    pluginId: string,
    liveContext: InvocationContext,
    hosts: readonly HostKind[] = ['telegram'],
  ): PluginTaskScope {
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
    const key = conversationId.toString();
    let hostKind = this.#conversationHosts.get(key);
    if (hostKind === undefined) {
      const [row] = this.#orm
        .select({ hostKind: chats.hostKind })
        .from(conversations)
        .innerJoin(chats, eq(conversations.chatId, chats.id))
        .where(eq(conversations.id, conversationId))
        .all();
      hostKind = row?.hostKind === 'playground' ? 'playground' : 'telegram';
      this.#conversationHosts.set(key, hostKind);
    }
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
    if (
      input.maxPerInvocation !== undefined &&
      (!Number.isSafeInteger(input.maxPerInvocation) || input.maxPerInvocation < 1)
    ) {
      throw new Error('maxPerInvocation must be a safe integer >= 1');
    }
    if (input.maxPerInvocation !== undefined && invocationId === null) {
      throw new Error('maxPerInvocation requires an invocation');
    }
    const deliveryJson = deliveryText(input.delivery);
    const at = now.toISOString();
    const created = this.#orm.transaction(
      () => {
        if (input.maxPerInvocation !== undefined && invocationId !== null) {
          const count =
            this.#orm
              .select({ count: sql<bigint>`count(*)` })
              .from(longTasks)
              .where(and(eq(longTasks.pluginId, pluginId), eq(longTasks.createdByInvocationId, invocationId)))
              .get()?.count ?? 0n;
          if (count >= BigInt(input.maxPerInvocation)) {
            throw new TaskQuotaError();
          }
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
    const json =
      value === undefined
        ? null
        : jsonText(value, status === 'completed' ? MAX_JSON : MAX_ERROR, status === 'completed' ? 'result' : 'error');
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const update = this.#orm
          .update(longTasks)
          .set({ state: status, finishedAt: at, updatedAt: at })
          .where(
            and(
              eq(longTasks.id, taskId),
              eq(longTasks.pluginId, pluginId),
              eq(longTasks.conversationId, conversationId),
              eq(longTasks.state, 'waiting'),
            ),
          )
          .run();
        if (update.changes === 0) {
          return false;
        }
        this.#orm
          .insert(taskReceipts)
          .values({
            taskId,
            status,
            resultJson: status === 'completed' ? json : null,
            errorJson: status === 'failed' ? json : null,
            state: options?.notify === false ? 'suppressed' : 'pending',
            createdAt: at,
            updatedAt: at,
          })
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.#wake?.();
    }
    return changed;
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
    if (restricted && callerId === null) {
      return false;
    }
    const at = now.toISOString();
    const changed = this.#orm.transaction(
      () => {
        const owner = restricted && callerId !== null ? eq(longTasks.createdByUserId, callerId) : undefined;
        const identity = and(
          eq(longTasks.id, taskId),
          eq(longTasks.pluginId, pluginId),
          eq(longTasks.conversationId, conversationId),
          owner,
        );
        const waiting = this.#orm
          .update(longTasks)
          .set({ state: 'cancelled', finishedAt: at, updatedAt: at })
          .where(and(identity, eq(longTasks.state, 'waiting')))
          .run();
        if (waiting.changes > 0) {
          this.#orm
            .insert(taskReceipts)
            .values({
              taskId,
              status: 'cancelled',
              state: 'suppressed',
              createdAt: at,
              updatedAt: at,
              cancelledAt: at,
              cancelledBy: options?.cancelledBy ?? null,
              adminCancelled: options?.adminCancelled ?? false,
              cancelReason: options?.reason ?? null,
            })
            .run();
          return true;
        }
        const pending = this.#orm
          .update(taskReceipts)
          .set({
            state: 'suppressed',
            updatedAt: at,
            cancelledAt: at,
            cancelledBy: options?.cancelledBy ?? null,
            adminCancelled: options?.adminCancelled ?? false,
            cancelReason: options?.reason ?? null,
          })
          .where(
            and(
              eq(taskReceipts.taskId, taskId),
              eq(taskReceipts.state, 'pending'),
              sql`EXISTS (SELECT 1 FROM long_tasks lt WHERE lt.id = ${taskReceipts.taskId} AND lt.plugin_id = ${pluginId} AND lt.conversation_id = ${conversationId}${restricted && callerId !== null ? sql` AND lt.created_by_user_id = ${callerId}` : sql``})`,
            ),
          )
          .run();
        return pending.changes > 0;
      },
      { behavior: 'immediate' },
    );
    if (changed) {
      this.#wake?.();
    }
    return changed;
  }

  processDue(now: Date): void {
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
