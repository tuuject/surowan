import { sql } from 'drizzle-orm';
import type { HostKind } from '../platform/im-host.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import { LongTaskService } from '../store/long-tasks.ts';
import type { BusinessStore } from '../store/store.ts';
import type { WarningService } from '../store/warnings.ts';
import { everyHostReady, type HostReadiness } from './host-scope.ts';
import { type BucketAttachmentTarget, InvocationQueueService } from './invocation-queue.ts';
import type { ProactiveReplyGateOptions } from './proactive-reply.ts';
import {
  type ActiveInvocation,
  executeInvocation,
  type InvocationExecutionDeps,
  type InvocationExecutionState,
} from './scheduler-execution.ts';
import {
  nextDelayMilliseconds as computeNextDelayMilliseconds,
  launchQueued,
  type SchedulerLoopDeps,
} from './scheduler-loop.ts';

export interface InvocationOutcome {
  readonly state: 'completed' | 'failed' | 'aborted' | 'outcome_unknown';
  readonly reason: string;
}

export type InvocationHandler = (
  invocationId: bigint,
  snapshot: InvocationConfigSnapshot,
  signal: AbortSignal,
) => Promise<InvocationOutcome>;

export { STARTUP_CATCH_UP_STATE_KEY } from './invocation-queue.ts';

/**
 * Event loop and concurrency governor. Delegates bucket/receipt state
 * transitions to InvocationQueueService and agent execution to the
 * InvocationHandler, then persists terminal outcomes.
 */
export class BucketScheduler {
  readonly #store: BusinessStore;
  readonly #queue: InvocationQueueService;
  readonly #hosts: readonly HostKind[] | undefined;
  readonly #active = new Map<string, ActiveInvocation>();
  readonly #executionState: InvocationExecutionState = { lastForcedGcAt: 0 };
  readonly #executionDeps: InvocationExecutionDeps;
  readonly #loopDeps: SchedulerLoopDeps;
  #running = false;
  #wakeResolver: (() => void) | undefined;
  #loopPromise: Promise<void> | undefined;

  constructor(
    store: BusinessStore,
    configStore: RuntimeConfigurationStore,
    handler: InvocationHandler,
    attachment?: BucketAttachmentTarget,
    tasks = new LongTaskService(store.orm),
    proactive?: ProactiveReplyGateOptions,
    /** Hosts this scheduler serves; undefined means every host of the database. */
    hosts?: readonly HostKind[],
    warnings?: WarningService,
    /** Whether one host may execute work right now; every host by default. */
    isHostReady: HostReadiness = everyHostReady,
  ) {
    this.#store = store;
    this.#hosts = hosts === undefined || hosts.length === 0 ? undefined : hosts;
    this.#queue = new InvocationQueueService(
      store,
      configStore,
      attachment,
      tasks,
      proactive,
      this.#hosts,
      isHostReady,
    );
    this.#executionDeps = {
      store,
      configStore,
      queue: this.#queue,
      handler,
      active: this.#active,
      state: this.#executionState,
      ...(warnings === undefined ? {} : { warnings }),
      processDue: (now) => this.processDue(now),
      processTasksDue: (now) => this.processTasksDue(now),
      wake: () => this.wake(),
    };
    this.#loopDeps = {
      store,
      configStore,
      queue: this.#queue,
      tasks,
      hosts: this.#hosts,
      isHostReady,
      active: this.#active,
      isRunning: () => this.#running,
      execute: (invocation, snapshot, controller) =>
        executeInvocation(this.#executionDeps, invocation, snapshot, controller),
    };
  }

  start(now = new Date()): void {
    if (this.#running) {
      throw new Error('Bucket scheduler is already running');
    }
    this.#queue.recover(now);
    this.#running = true;
    this.#loopPromise = this.#loop();
  }

  wake(): void {
    this.#wakeResolver?.();
    this.#wakeResolver = undefined;
  }

  // Aborts invocations currently running in a chat (used by /pause). The
  // queued-invocation and bucket state transitions happen in the command
  // service; this only interrupts live agent work.
  pauseChat(chatId: bigint): void {
    for (const [id, entry] of this.#active) {
      const row = this.#store.orm
        .all<{ chat_id: bigint }>(
          sql`SELECT v.chat_id FROM invocations i JOIN conversations v ON v.id = i.conversation_id WHERE i.id = ${BigInt(id)}`,
        )
        .at(0);
      if (row !== undefined && row.chat_id === chatId) {
        entry.controller.abort(new Error('chat_paused'));
      }
    }
  }

  // Aborts the invocation running for one Conversation (used by /cut_topic). The
  // run holds the pre-cut transcript in memory and its own view of `head_seq`, so
  // leaving it alive would both keep answering from history the admin just cut and
  // let it write on top of the cut.
  abortConversation(conversationId: bigint): void {
    for (const [id, entry] of this.#active) {
      const row = this.#store.orm
        .all<{ conversation_id: bigint }>(sql`SELECT conversation_id FROM invocations WHERE id = ${BigInt(id)}`)
        .at(0);
      if (row !== undefined && row.conversation_id === conversationId) {
        entry.controller.abort(new Error('context_cut'));
      }
    }
  }

  // Aborts every running invocation (used by the admin "Cancel ongoing"). Returns
  // how many were signalled; each one persists its own terminal state.
  abortAll(): number {
    for (const entry of this.#active.values()) {
      entry.controller.abort(new Error('admin_cancel'));
    }
    return this.#active.size;
  }

  // Aborts the listed running invocations (used by the scoped prompt cancel).
  // Like abortAll, this only interrupts live agent work; each run persists its
  // own terminal state.
  abortInvocations(ids: readonly bigint[], reason = 'admin_cancel'): number {
    const wanted = new Set(ids);
    let signaled = 0;
    for (const [id, entry] of this.#active) {
      if (wanted.has(BigInt(id))) {
        entry.controller.abort(new Error(reason));
        signaled += 1;
      }
    }
    return signaled;
  }

  async stop(graceMilliseconds = 30_000): Promise<void> {
    this.#running = false;
    this.wake();
    await this.#loopPromise;
    const active = [...this.#active.values()];
    if (active.length === 0) {
      return;
    }
    const finished = Promise.allSettled(active.map((entry) => entry.promise));
    let graceTimer: NodeJS.Timeout | undefined;
    const graceElapsed = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), graceMilliseconds);
    });
    const result = await Promise.race([finished, graceElapsed]);
    clearTimeout(graceTimer);
    if (result === 'timeout') {
      for (const entry of active) {
        entry.controller.abort(new Error('shutdown'));
      }
      await finished;
    }
  }

  recover(now = new Date()): void {
    this.#queue.recover(now);
  }

  finishStartupCatchUp(startedAt: Date, now = new Date()): bigint[] {
    return this.#queue.finishStartupCatchUp(startedAt, now);
  }

  processDue(now = new Date()): bigint[] {
    return this.#queue.processDue(now);
  }

  processTasksDue(now = new Date()): bigint[] {
    return this.#queue.processTasksDue(now);
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      this.processTasksDue();
      this.processDue();
      launchQueued(this.#loopDeps);
      const delay = this.nextDelayMilliseconds();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        this.#wakeResolver = finish;
      });
    }
  }

  /**
   * How long the loop may sleep before its next pass, from the current
   * deadlines. Public because it is the governor's own contract: work that
   * cannot run right now (no free slot, a chat already running) must not make
   * the loop spin, and that is asserted directly instead of by timing.
   */
  nextDelayMilliseconds(): number {
    return computeNextDelayMilliseconds(this.#loopDeps);
  }
}
