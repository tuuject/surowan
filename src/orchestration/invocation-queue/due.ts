import { and, eq, sql } from 'drizzle-orm';
import { completeAgentSettings, resolveAgentSettings } from '../../platform/config/resolve.ts';
import { type ChatConfigEntry, resolveChatConfig } from '../../platform/config/index.ts';
import { parseHostKind, type HostKind } from '../../platform/im-host/identity.ts';
import { buckets } from '../../store/schema/index.ts';
import type { DecisionToken } from '../decision-gate/index.ts';
import {
  enqueueBucketInvocation,
  type InvocationQueueDeps,
  logSleepingSkip,
  markBucketSkipped,
  proactiveAllows,
  runningInvocationId,
  servedConversations,
  sleepUntilFor,
} from './shared.ts';

export interface BucketRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  readonly kind: string;
  readonly first_received_at: string;
  readonly deadline_at: string;
  /** The batch's own window, recorded when it opened. */
  readonly window_seconds: bigint;
}

/**
 * Turns due collecting buckets into queued invocations, injecting them into a
 * run that is already active for the same Conversation when its round is over.
 */
export function processDueBuckets(deps: InvocationQueueDeps, now = new Date()): bigint[] {
  const store = deps.store;
  const sleepUntil = sleepUntilFor(deps, now);
  // Requests start only once the transaction is committed, so the Decision
  // gate's phase 1 writes and the request that reads them never overlap.
  const decisions: DecisionToken[] = [];
  let invocations: bigint[];
  try {
    invocations = store.transaction(() => {
      // A bucket whose conversation already has a *running* invocation is
      // injected into it (below) instead of starting its own run. Everything
      // else keeps the previous chat-level pacing: a queued invocation will
      // open with this bucket, and a running invocation of a *different*
      // conversation in the same chat still owns the chat, because agent
      // sessions stay serialized per chat.
      // No age ceiling here. A batch collects for as long as its Conversation is
      // busy — the runtime pushes its deadline one window at a time while the
      // round runs — so a batch that is entirely legitimate is older than
      // `RECOVERY_MAX_AGE_MS` by the time it comes due. Filtering those out left
      // them `collecting` forever: the run ends without taking them, nothing
      // re-queues them, and every later message of that Conversation joins the
      // same dead batch while the scheduler keeps waking on its already-passed
      // deadline (observed: invocations/1320, where a 30-minute round left the
      // next batch stranded and the chat went silent for good). The five-minute
      // rule is a *startup* rule: `recover()` expires that work before this
      // method is ever called, so nothing stale can reach the queue from here.
      deps.decisionGate?.pruneMarks();
      const due = store.orm.all<BucketRow>(
        sql`SELECT b.id, b.conversation_id, b.kind, b.first_received_at, b.deadline_at, b.window_seconds
       FROM buckets b
       JOIN conversations v ON v.id = b.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE b.state = 'collecting' AND b.deadline_at <= ${now.toISOString()}
         AND ${servedConversations(deps, sql`b.conversation_id`)}
         AND NOT EXISTS (SELECT 1 FROM chat_pause p WHERE p.chat_id = v.chat_id)
         AND NOT EXISTS (
           SELECT 1 FROM invocations i
           JOIN conversations v2 ON v2.id = i.conversation_id
           WHERE v2.chat_id = v.chat_id
             AND (i.state = 'queued' OR (i.state = 'running' AND i.conversation_id <> b.conversation_id))
         )
       ORDER BY b.deadline_at, b.id`,
      );
      const opened: bigint[] = [];
      for (const bucket of due) {
        // A batch with a request in flight is never decided twice, even when
        // another path moved its deadline earlier than the pushed one.
        if (deps.decisionGate?.isDeciding(bucket.id) === true) {
          deferDecidingBucket(deps, bucket, now);
          continue;
        }
        const running = runningInvocationId(deps, bucket.conversation_id);
        if (running !== undefined) {
          // A run that is still working on its round has not been free for the
          // batch's window yet, so the batch keeps collecting: its window starts
          // when the round ends (`AgentRuntime` pushes the deadline then). Handing
          // it over here would inject a batch that collected almost nothing, and
          // would also split the messages that arrive during a long round across
          // two batches.
          if (deps.attachment?.isRoundInProgress(bucket.conversation_id) === true) {
            deferBucket(deps, bucket, now);
            continue;
          }
          if (attachDueBucket(deps, bucket, running, now, sleepUntil, decisions)) {
            continue;
          }
          // The run is closing and cannot take this batch; leave the bucket
          // collecting so the next invocation picks it up.
          continue;
        }
        const invocationId = queueCollectingBucket(deps, bucket, now, sleepUntil, decisions);
        if (invocationId !== undefined) {
          opened.push(invocationId);
        }
      }
      return opened;
    });
  } catch (error) {
    // The rows went back with the transaction; the in-memory reservations have
    // to go back too, or the batch would look "deciding" forever.
    deps.decisionGate?.abandon(decisions);
    throw error;
  }
  for (const token of decisions) {
    deps.decisionGate?.start(token);
  }
  return invocations;
}

/**
 * Keeps a batch with a request in flight out of the loop's zero-delay path. Such
 * a batch is only in the due list because the request outlived the deadline
 * phase 1 pushed (a slow event loop), and phase 2 makes it due again as soon as
 * the verdict lands, so the floor is all it needs.
 */
function deferDecidingBucket(deps: InvocationQueueDeps, bucket: BucketRow, now: Date): void {
  const atLeast = new Date(now.getTime() + deps.minimumDeferMs).toISOString();
  deps.store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${atLeast}, updated_at = ${now.toISOString()}
       WHERE id = ${bucket.id} AND state = 'collecting' AND deadline_at < ${atLeast}`,
  );
}

/**
 * Hands one due batch to the Decisions gate, after every ordinary check passed.
 * `hold` means `enforce` is waiting for the verdict and the caller must not
 * queue or attach the batch; a collected token is started once the transaction
 * commits and the ordinary path continues meanwhile.
 *
 * `begin` contains its own failures and admits the batch (fail-open), so this
 * function cannot throw for a gate reason: the pass always keeps going.
 */
function decide(
  deps: InvocationQueueDeps,
  bucket: BucketRow,
  hostKind: HostKind,
  chat: { readonly chat_id: bigint; readonly telegram_chat_id: bigint; readonly type: string },
  chatConfig: Pick<ChatConfigEntry, 'decision_gate'>,
  now: Date,
  decisions: DecisionToken[],
): 'hold' | undefined {
  const gate = deps.decisionGate;
  if (gate === undefined) {
    return undefined;
  }
  const rule = deps.participation.ruleFor(deps.store.orm, { hostKind, hostChatId: chat.telegram_chat_id }, chat.type);
  const begun = gate.begin({
    bucketId: bucket.id,
    conversationId: bucket.conversation_id,
    bucketKind: bucket.kind,
    hostChatId: chat.telegram_chat_id,
    hostKind,
    chatType: chat.type,
    chat: chatConfig,
    keywords: rule?.keywords ?? [],
    now,
  });
  if (begun === undefined) {
    return undefined;
  }
  if (begun.token !== undefined) {
    decisions.push(begun.token);
  }
  return begun.held ? 'hold' : undefined;
}

/**
 * Hands one due bucket to the invocation already running for its
 * Conversation. The frozen-input invariant is kept: the batch is snapshotted
 * into `invocation_messages` now, so later edits cannot change what the model
 * will see.
 */
export function attachDueBucket(
  deps: InvocationQueueDeps,
  bucket: BucketRow,
  invocationId: bigint,
  now: Date,
  sleepUntil: string | null,
  decisions: DecisionToken[],
): boolean {
  const store = deps.store;
  const attachment = deps.attachment;
  if (attachment === undefined || attachment.isClosing(bucket.conversation_id)) {
    return false;
  }
  // Paused chats never reach here: the due query excludes them.
  const chat = store.orm
    .all<{ chat_id: bigint; telegram_chat_id: bigint; host_kind: string; type: string }>(
      sql`SELECT c.id AS chat_id, c.host_chat_id AS telegram_chat_id, c.host_kind, c.type FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ${bucket.conversation_id}`,
    )
    .at(0);
  if (chat === undefined) {
    throw new Error(`Bucket ${bucket.id} has no chat`);
  }
  const hostKind = parseHostKind(chat.host_kind);
  // The same gates as opening a run: a batch that could not start its own
  // invocation must not reach a running one either. Skipping it here also
  // keeps the waiter asleep, so a run idling through its grace period is not
  // woken for another model turn while the bot sleeps.
  const attachChat = resolveChatConfig(deps.configStore.current().config, store.orm, {
    hostKind,
    hostChatId: chat.telegram_chat_id,
  });
  if (attachChat === undefined) {
    markBucketSkipped(deps, bucket.id, now, 'chat_removed');
    return true;
  }
  // A batch that could not open its own invocation must not reach a running
  // one either; the same is true when no complete agent identity exists.
  if (completeAgentSettings(resolveAgentSettings(deps.configStore.current().config, attachChat)) === undefined) {
    markBucketSkipped(deps, bucket.id, now, 'agent_unconfigured');
    return true;
  }
  if (sleepUntil !== null) {
    markBucketSkipped(deps, bucket.id, now, 'sleeping');
    logSleepingSkip(chat.telegram_chat_id, bucket.id, invocationId, sleepUntil);
    return true;
  }
  if (
    !proactiveAllows(
      deps,
      bucket.id,
      chat.chat_id,
      hostKind,
      chat.telegram_chat_id,
      chat.type,
      bucket.conversation_id,
      attachChat,
      now,
    )
  ) {
    markBucketSkipped(deps, bucket.id, now, 'proactive_reply_skipped');
    return true;
  }
  // A rejected batch must not be attached either: the gate covers this path
  // exactly like opening a run.
  if (decide(deps, bucket, hostKind, chat, attachChat, now, decisions) === 'hold') {
    return true;
  }
  const timestamp = now.toISOString();
  deps.attachBucketToInvocation(
    store,
    deps.configStore.current().config.agent.history_messages,
    invocationId,
    bucket.id,
    bucket.conversation_id,
    hostKind,
    now,
  );
  attachment.queueInjection(bucket.conversation_id, bucket.id);
  console.log(
    JSON.stringify({
      event: 'bucket_attached',
      invocation_id: invocationId.toString(),
      bucket_id: bucket.id.toString(),
      conversation_id: bucket.conversation_id.toString(),
      chat_id: chat.telegram_chat_id.toString(),
      at: timestamp,
    }),
  );
  return true;
}

/**
 * Keeps a due batch collecting because its conversation is mid-round. The
 * batch's own window restarts from now, which is only an approximation — the
 * exact anchor is the round end, which the runtime writes when it gets there —
 * but it also keeps the scheduler from waking on an already-passed deadline
 * over and over.
 */
export function deferBucket(deps: InvocationQueueDeps, bucket: BucketRow, now: Date): void {
  const deferMilliseconds = Math.max(Number(bucket.window_seconds) * 1_000, deps.minimumDeferMs);
  const atLeast = new Date(now.getTime() + deferMilliseconds).toISOString();
  deps.store.orm.run(
    sql`UPDATE buckets SET deadline_at = ${atLeast}, updated_at = ${now.toISOString()}
       WHERE id = ${bucket.id} AND state = 'collecting' AND deadline_at < ${atLeast}`,
  );
}

/** Opens a run for a due bucket, or closes it as skipped with the reason that blocked it. */
export function queueCollectingBucket(
  deps: InvocationQueueDeps,
  bucket: BucketRow,
  now: Date,
  sleepUntil: string | null,
  decisions: DecisionToken[],
): bigint | undefined {
  const store = deps.store;
  const chat = store.orm
    .all<{ chat_id: bigint; telegram_chat_id: bigint; host_kind: string; type: string; paused: bigint }>(
      sql`SELECT c.id AS chat_id, c.host_chat_id AS telegram_chat_id, c.host_kind, c.type,
              EXISTS(SELECT 1 FROM chat_pause p WHERE p.chat_id = c.id) AS paused
       FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ${bucket.conversation_id}`,
    )
    .at(0);
  if (chat === undefined) {
    throw new Error(`Bucket ${bucket.id} has no chat`);
  }
  if (chat.paused === 1n) {
    markBucketSkipped(deps, bucket.id, now, 'chat_paused');
    return undefined;
  }
  const hostKind = parseHostKind(chat.host_kind);
  const current = deps.configStore.current().config;
  const chatConfig = resolveChatConfig(current, store.orm, { hostKind, hostChatId: chat.telegram_chat_id });
  if (chatConfig === undefined) {
    markBucketSkipped(deps, bucket.id, now, 'chat_removed');
    return undefined;
  }
  // Without a complete provider/model/thinking_level no invocation may ever
  // start: close the bucket as skipped and leave the reason for audit reads.
  if (completeAgentSettings(resolveAgentSettings(current, chatConfig)) === undefined) {
    markBucketSkipped(deps, bucket.id, now, 'agent_unconfigured');
    return undefined;
  }
  if (sleepUntil !== null) {
    markBucketSkipped(deps, bucket.id, now, 'sleeping');
    logSleepingSkip(chat.telegram_chat_id, bucket.id, null, sleepUntil);
    return undefined;
  }
  if (
    !proactiveAllows(
      deps,
      bucket.id,
      chat.chat_id,
      hostKind,
      chat.telegram_chat_id,
      chat.type,
      bucket.conversation_id,
      chatConfig,
      now,
    )
  ) {
    markBucketSkipped(deps, bucket.id, now, 'proactive_reply_skipped');
    return undefined;
  }
  // `enforce` keeps the batch collecting until the verdict arrives; `shadow`
  // carries on here and only records what the model would have said.
  if (decide(deps, bucket, hostKind, chat, chatConfig, now, decisions) === 'hold') {
    return undefined;
  }
  store.orm
    .update(buckets)
    .set({ state: 'queued', queuedAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(and(eq(buckets.id, bucket.id), eq(buckets.state, 'collecting')))
    .run();
  return enqueueBucketInvocation(deps, bucket.id, bucket.conversation_id, hostKind, now, true);
}
