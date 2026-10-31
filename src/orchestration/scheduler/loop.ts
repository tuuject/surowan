import { eq, type SQL, sql } from 'drizzle-orm';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import { PlaygroundStore } from '../../store/playground/index.ts';
import { buckets, invocations } from '../../store/schema/index.ts';
import { type BusinessStore, resolveChatConfig } from '../../store/store.ts';
import { activeHosts, conversationsOfHosts, type HostReadiness } from '../host-scope.ts';
import type { InvocationQueueService } from '../invocation-queue/index.ts';
import type { ActiveInvocation, InvocationRow } from './execution.ts';

/**
 * What the scheduling pass needs from the scheduler. Every field is a live
 * object the scheduler owns: `active` is the run map itself, so the entries this
 * module adds and the sizes it reads are the scheduler's.
 */
export type SchedulerLoopDeps = {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly queue: InvocationQueueService;
  readonly tasks: LongTaskService;
  /** Hosts this scheduler serves; undefined means every host of the database. */
  readonly hosts: readonly HostKind[] | undefined;
  /** Whether one host may execute work right now. */
  readonly isHostReady: HostReadiness;
  readonly active: Map<string, ActiveInvocation>;
  /** The loop's own flag: it stops launching as soon as `stop` clears it. */
  readonly isRunning: () => boolean;
  /** Starts one invocation; resolves after its terminal state is persisted. */
  readonly execute: (
    invocation: InvocationRow,
    snapshot: InvocationConfigSnapshot,
    controller: AbortController,
  ) => Promise<void>;
};

/**
 * `conversation_id`/`bucket_id` rows of the hosts this pass may touch: the
 * process scope narrowed by live connection readiness. Work of a host that is
 * not ready is never launched, recovered or waited on here.
 */
function servedConversations(deps: SchedulerLoopDeps, column: SQL): SQL {
  return conversationsOfHosts(activeHosts(deps.hosts, deps.isHostReady), column);
}

/**
 * How long the loop may sleep before its next pass, from the current
 * deadlines. Exported because it is the governor's own contract: work that
 * cannot run right now (no free slot, a chat already running) must not make
 * the loop spin, and that is asserted directly instead of by timing.
 */
export function nextDelayMilliseconds(deps: SchedulerLoopDeps): number {
  const deadlines: number[] = [];
  // Buckets of a Conversation whose invocation is already running still need
  // a wake-up: the run attaches them as soon as their window closes, so the
  // chat-level exclusion here only covers queued and other-conversation runs.
  const bucket = deps.store.orm
    .all<{ deadline_at: string }>(
      sql`SELECT b.deadline_at FROM buckets b
         JOIN conversations v ON v.id = b.conversation_id
         WHERE b.state = 'collecting'
           AND ${servedConversations(deps, sql`b.conversation_id`)}
           AND NOT EXISTS (
             SELECT 1 FROM invocations i
             JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id
               AND (i.state = 'queued' OR (i.state = 'running' AND i.conversation_id <> b.conversation_id))
           )
         ORDER BY b.deadline_at, b.id LIMIT 1`,
    )
    .at(0);
  if (bucket !== undefined) {
    deadlines.push(Date.parse(bucket.deadline_at));
  }
  const timerDeadline = deps.tasks.nextDeadline();
  if (timerDeadline !== undefined) {
    deadlines.push(Date.parse(timerDeadline));
  }
  const sleepUntil = deps.queue.sleepUntil(new Date());
  if (sleepUntil !== null) {
    deadlines.push(Date.parse(sleepUntil));
  }
  const receipt = deps.store.orm
    .all<{ created_at: string }>(
      sql`SELECT r.created_at FROM task_receipts r JOIN long_tasks t ON t.id = r.task_id
         JOIN conversations v ON v.id = t.conversation_id
         JOIN chats c ON c.id = v.chat_id
         WHERE r.state = 'pending'
           AND ${servedConversations(deps, sql`t.conversation_id`)}
           AND (c.host_kind = 'playground' OR ${sleepUntil} IS NULL OR json_extract(t.delivery_json, '$.bypassDailyBudget') = 1)
           AND NOT EXISTS (
             SELECT 1 FROM invocations i JOIN conversations v2 ON v2.id = i.conversation_id
             WHERE v2.chat_id = v.chat_id AND i.state = 'running'
           )
         ORDER BY r.created_at, r.task_id LIMIT 1`,
    )
    .at(0);
  if (receipt !== undefined) {
    deadlines.push(Date.parse(receipt.created_at));
  }
  // A queued invocation that can actually launch must not wait for the next
  // full poll. One blocked behind a running invocation in the same chat, or
  // behind a full concurrency limit, is excluded: its past deadline would
  // busy-loop the scheduler, and a finishing run wakes it anyway.
  const slotsFull = deps.active.size >= deps.configStore.current().config.agent.max_concurrency;
  const queued = slotsFull
    ? undefined
    : deps.store.orm
        .all<{ deadline_at: string }>(
          sql`SELECT b.deadline_at FROM invocations i
         JOIN buckets b ON b.id = i.bucket_id
         JOIN conversations v ON v.id = i.conversation_id
         WHERE i.state = 'queued'
           AND ${servedConversations(deps, sql`i.conversation_id`)}
           AND NOT EXISTS (
             SELECT 1 FROM invocations r JOIN conversations v2 ON v2.id = r.conversation_id
             WHERE v2.chat_id = v.chat_id AND r.state = 'running'
           )
         ORDER BY b.deadline_at LIMIT 1`,
        )
        .at(0);
  if (queued !== undefined) {
    deadlines.push(Date.parse(queued.deadline_at));
  }
  if (activeHosts(deps.hosts, deps.isHostReady).includes('playground')) {
    const expiry = new PlaygroundStore(deps.store.orm).nextQueuedExpiry();
    if (expiry !== undefined) {
      deadlines.push(expiry);
    }
  }
  if (deadlines.length === 0) {
    return 60_000;
  }
  const next = Math.min(...deadlines);
  return Math.max(0, Math.min(60_000, next - Date.now()));
}

export function launchQueued(deps: SchedulerLoopDeps): void {
  // Room invocations that queued too long are expired visibly; Telegram
  // collecting/debounce buckets keep their own lifecycle. A scheduler that
  // does not serve rooms leaves their queue to the process that does.
  if (activeHosts(deps.hosts, deps.isHostReady).includes('playground')) {
    new PlaygroundStore(deps.store.orm).expireQueued();
  }
  while (deps.isRunning()) {
    const now = new Date();
    deps.queue.suppressInvalidQueuedReceipts(now);
    const sleepUntil = deps.queue.sleepUntil(now);
    if (sleepUntil !== null) {
      deps.queue.skipQueuedInvocations(sleepUntil, now);
    }
    if (deps.active.size >= deps.configStore.current().config.agent.max_concurrency) {
      return;
    }
    const launched = deps.store.transaction(() => {
      const candidate = deps.store.orm
        .all<InvocationRow & { host_kind: string; telegram_chat_id: bigint | null }>(
          sql`SELECT i.id, i.bucket_id, i.conversation_id, c.host_kind, c.telegram_chat_id FROM invocations i
             JOIN buckets b ON b.id = i.bucket_id
             JOIN conversations v ON v.id = i.conversation_id
             JOIN chats c ON c.id = v.chat_id
             LEFT JOIN task_receipts r ON r.invocation_id = i.id AND r.state = 'claimed'
             WHERE i.state = 'queued' AND b.deadline_at <= ${new Date().toISOString()}
               AND ${servedConversations(deps, sql`i.conversation_id`)}
               AND NOT EXISTS (
                 SELECT 1 FROM invocations r
                 JOIN conversations v2 ON v2.id = r.conversation_id
                 WHERE v2.chat_id = v.chat_id AND r.state = 'running'
               )
             ORDER BY CASE WHEN r.task_id IS NOT NULL THEN 0 ELSE 1 END, i.id
             LIMIT 1`,
        )
        .at(0);
      if (candidate === undefined) {
        return null;
      }
      // The snapshot is taken in the same synchronous block as the state
      // transition: a configuration published after this point can never
      // reach the run that is starting here. `config_hash` is written here
      // rather than at queue time so it names the configuration the run
      // actually used.
      const snapshot = deps.configStore.beginInvocation();
      const now = new Date().toISOString();
      if (
        candidate.host_kind === 'telegram' &&
        (candidate.telegram_chat_id === null ||
          resolveChatConfig(snapshot.config, deps.store.orm, candidate.telegram_chat_id) === undefined)
      ) {
        deps.store.orm
          .update(invocations)
          .set({ state: 'aborted', completionReason: 'chat_removed', finishedAt: now })
          .where(eq(invocations.id, candidate.id))
          .run();
        deps.store.orm
          .update(buckets)
          .set({ state: 'aborted', errorCode: 'chat_removed', finishedAt: now, updatedAt: now })
          .where(eq(buckets.id, candidate.bucket_id))
          .run();
        return undefined;
      }
      deps.store.orm
        .update(invocations)
        .set({ state: 'running', startedAt: now, configHash: snapshot.hash })
        .where(eq(invocations.id, candidate.id))
        .run();
      deps.store.orm
        .update(buckets)
        .set({ state: 'running', startedAt: now, updatedAt: now })
        .where(eq(buckets.id, candidate.bucket_id))
        .run();
      return { invocation: candidate, snapshot };
    });
    if (launched === null) {
      return;
    }
    if (launched === undefined) {
      continue;
    }
    const controller = new AbortController();
    const promise = deps.execute(launched.invocation, launched.snapshot, controller);
    deps.active.set(launched.invocation.id.toString(), { controller, promise });
  }
}
