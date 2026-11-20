import { sql } from 'drizzle-orm';
import { hostIntakeSettings, type FileChat, type RawConfig, resolveChatConfig } from '../../platform/config/index.ts';
import {
  type DecisionGateSettings,
  renderDecisionGateInstructions,
  resolveDecisionGate,
} from '../../platform/decision-gate.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { BusinessStore } from '../../store/store.ts';
import { bucketDirectTriggerKind } from '../direct-trigger.ts';
import { decisionEvent, failureEvent, writeEvent } from './log.ts';
import { bucketFingerprint, readDecisionMessages } from './query.ts';
import { insertPendingDecision, makeDue, pushDeadlineLater, settleDecision } from './record.ts';
import { renderDecisionState } from './request.ts';
import { failure, resolveVerdict } from './run.ts';
import { applyDecision } from './settle.ts';
import type { DecisionBegin, DecisionCandidate, DecisionGateOptions, DecisionRecord, DecisionToken } from './types.ts';

export type * from './types.ts';

/** The global in-flight cap: above it a batch enters instead of queueing a request. */
export const DECISION_GATE_MAX_CONCURRENT = 4;
/** How often one batch may be decided again after new messages arrived. */
export const DECISION_GATE_MAX_REDECISIONS = 2;
/** Slack added to the pushed deadline so a finished request's wake always lands after it. */
const DEADLINE_MARGIN_MS = 500;

/** What phase 1 learned before it failed, so the failure can be logged and closed. */
interface BeginTrace {
  settings: DecisionGateSettings | undefined;
  decisionId: bigint | undefined;
}

/**
 * The Decisions entry gate: one yes/no question about a batch that is about to
 * reach the main model. It is the counterpart of `ProactiveReplyGate` — chosen
 * probabilities instead of sampled ones — and it sits at the same two entry
 * points, `queueCollectingBucket` and `attachDueBucket`.
 *
 * The due pass is one synchronous SQLite transaction and the decision is an
 * HTTP round trip, so the work is split in two:
 *
 * 1. `begin` runs inside that transaction. It records the batch fingerprint,
 *    inserts the `pending` audit row, reads the messages and marks the Bucket
 *    "deciding". No HTTP happens here. In `enforce` it additionally pushes the
 *    deadline past the budget and keeps the Bucket collecting, so the caller
 *    neither queues nor attaches it.
 * 2. `start` runs the request after the commit and `#settle` writes the verdict
 *    in a new transaction. In `enforce` that means releasing the Bucket for the
 *    next pass, dropping it, or deciding again when new messages arrived.
 *
 * Every mark here is process state by design: a restart loses it and the Batch is
 * simply decided once more. `stop` aborts in-flight requests and
 * makes every later result a no-op, so `stop` never waits for the network.
 */
export class DecisionGate {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #options: DecisionGateOptions;
  readonly #maxConcurrent: number;
  readonly #maxRedecisions: number;
  /** Buckets with a request in flight; the due pass must not decide them twice. */
  readonly #deciding = new Set<string>();
  /** Buckets a verdict already released: the next pass skips the gate and takes the ordinary path. */
  readonly #released = new Set<string>();
  /** Per-Bucket count of decisions discarded because the batch grew meanwhile. */
  readonly #redecs = new Map<string, number>();
  readonly #inflight = new Set<Promise<void>>();
  #active = 0;
  readonly #abort = new AbortController();
  #stopped = false;

  constructor(store: BusinessStore, configStore: RuntimeConfigurationStore, options: DecisionGateOptions) {
    this.#store = store;
    this.#configStore = configStore;
    this.#options = options;
    this.#maxConcurrent = options.maxConcurrent ?? DECISION_GATE_MAX_CONCURRENT;
    this.#maxRedecisions = options.maxRedecisions ?? DECISION_GATE_MAX_REDECISIONS;
  }

  /**
   * Whether this batch has to pass an enforcing gate. When it does, the Chat no
   * longer samples proactive replies: a batch sampled out and then dropped
   * would burn the pity counter for nothing.
   */
  enforcesBatch(bucketId: bigint, hostKind: HostKind, chat: Pick<FileChat, 'decision_gate'>): boolean {
    if (this.#stopped) {
      return false;
    }
    const settings = this.#settings(this.#configStore.current().config, hostKind, chat);
    if (!settings.enabled || settings.mode !== 'enforce') {
      return false;
    }
    const kind = this.#store.orm
      .all<{ kind: string }>(sql`SELECT kind FROM buckets WHERE id = ${bucketId}`)
      .at(0)?.kind;
    return kind === 'realtime';
  }

  isDeciding(bucketId: bigint): boolean {
    return this.#deciding.has(bucketId.toString());
  }

  /**
   * Drops marks of Buckets that already left `collecting`. The send barrier and
   * the queue take batches without passing through the due pass, so nothing
   * else would ever clear their marks; one cheap query keeps both sets bounded.
   */
  pruneMarks(): void {
    if (this.#released.size === 0 && this.#redecs.size === 0) {
      return;
    }
    const tracked = new Set<string>([...this.#released, ...this.#redecs.keys()]);
    const ids = [...tracked].map((key) => sql`${BigInt(key)}`);
    const alive = new Set(
      this.#store.orm
        .all<{ id: bigint }>(
          sql`SELECT id FROM buckets WHERE state = 'collecting' AND id IN (${sql.join(ids, sql`, `)})`,
        )
        .map((row) => row.id.toString()),
    );
    for (const key of tracked) {
      if (!alive.has(key)) {
        this.#released.delete(key);
        this.#redecs.delete(key);
      }
    }
  }

  /**
   * Phase 1, inside the due transaction. Never throws: a failure here (an
   * unreadable batch, a renderer that throws, a database error) admits the batch
   * through the ordinary path and leaves no reservation behind, because one
   * broken decision must not take scheduling down for every Chat.
   *
   * Returns `undefined` when the batch takes the ordinary path without a
   * decision, `held` when `enforce` withholds it, and a token the caller must
   * hand to `start` after the commit otherwise.
   */
  begin(candidate: DecisionCandidate): DecisionBegin | undefined {
    if (this.#stopped) {
      return undefined;
    }
    const trace: BeginTrace = { settings: undefined, decisionId: undefined };
    try {
      return this.#open(candidate, trace);
    } catch (error) {
      this.#failOpen(candidate, trace, error);
      return undefined;
    }
  }

  #open(candidate: DecisionCandidate, trace: BeginTrace): DecisionBegin | undefined {
    const settings = this.#eligible(candidate);
    if (settings === undefined) {
      return undefined;
    }
    trace.settings = settings;
    const key = candidate.bucketId.toString();
    if (this.#deciding.has(key)) {
      // Another pass already asked; the deadline may have moved earlier than
      // the pushed one, but this batch must not be decided twice. `shadow`
      // still lets the batch take the ordinary path, exactly as it would have.
      return settings.mode === 'enforce' ? { held: true, token: undefined } : undefined;
    }
    if (this.#directTrigger(candidate)) {
      return undefined;
    }
    const now = candidate.now;
    const createdAt = now.toISOString();
    if (this.#active >= this.#maxConcurrent) {
      const record: DecisionRecord = {
        state: 'error',
        outcome: 'enter',
        probability: null,
        threshold: settings.threshold,
        inputTokens: null,
        cost: null,
        durationMs: null,
        errorCode: 'concurrency_limit',
        errorDetail: `${this.#maxConcurrent} decisions are already in flight`,
      };
      const decisionId = insertPendingDecision(this.#store, {
        bucketId: candidate.bucketId,
        conversationId: candidate.conversationId,
        mode: settings.mode,
        model: settings.model,
        threshold: settings.threshold,
        historyCount: 0n,
        pendingCount: 0n,
        createdAt,
      });
      trace.decisionId = decisionId;
      settleDecision(this.#store, decisionId, record, settings.mode === 'enforce', createdAt);
      return {
        held: false,
        token: {
          decisionId,
          candidate,
          settings,
          instructions: '',
          plan: { kind: 'settled', record, applied: settings.mode === 'enforce' },
        },
      };
    }
    const bot = { name: this.#options.bot.displayName, username: this.#options.bot.username ?? '' };
    const messages = readDecisionMessages({
      orm: this.#store.orm,
      bucketId: candidate.bucketId,
      conversationId: candidate.conversationId,
      historyMessages: settings.history_messages,
      pendingMessages: settings.pending_messages,
    });
    const decisionId = insertPendingDecision(this.#store, {
      bucketId: candidate.bucketId,
      conversationId: candidate.conversationId,
      mode: settings.mode,
      model: settings.model,
      threshold: settings.threshold,
      historyCount: BigInt(messages.history.length),
      pendingCount: BigInt(messages.pending.length),
      createdAt,
    });
    trace.decisionId = decisionId;
    const hold = settings.mode === 'enforce';
    const instructions = renderDecisionGateInstructions(settings.instructions, bot);
    const state = renderDecisionState({ ...messages, bot });
    const fingerprint = bucketFingerprint(this.#store.orm, candidate.bucketId);
    if (hold) {
      // The request is bounded by `timeout_ms`; the pushed deadline keeps the
      // scheduler from waking on an already-passed deadline during the request,
      // and re-processing the batch a moment later if this process dies. This
      // write happens before the reservation: a throw has to leave no mark.
      pushDeadlineLater(
        this.#store,
        candidate.bucketId,
        new Date(now.getTime() + settings.timeout_ms + DEADLINE_MARGIN_MS),
        now,
      );
    }
    const token: DecisionToken = {
      decisionId,
      candidate,
      settings,
      instructions,
      plan: {
        kind: 'request',
        content: {
          state,
          historyCount: BigInt(messages.history.length),
          pendingCount: BigInt(messages.pending.length),
        },
        fingerprint,
      },
    };
    // Last, and the only statements that must not throw: the in-memory
    // reservation. `abandon` undoes it when the due transaction rolls back.
    this.#active += 1;
    this.#deciding.add(key);
    return { held: hold, token };
  }

  /**
   * A phase-1 failure: close the row it already wrote, log one redacted line,
   * and let the batch take the ordinary path. The due transaction stays usable
   * — this is one more statement in it — so the pass continues with its other
   * Buckets.
   */
  #failOpen(candidate: DecisionCandidate, trace: BeginTrace, error: unknown): void {
    const detail = this.#redact(error);
    const at = new Date();
    const applied = trace.settings?.mode === 'enforce' && trace.decisionId !== undefined;
    if (trace.decisionId !== undefined) {
      try {
        settleDecision(
          this.#store,
          trace.decisionId,
          {
            state: 'error',
            outcome: 'enter',
            probability: null,
            threshold: trace.settings?.threshold ?? 0,
            inputTokens: null,
            cost: null,
            durationMs: null,
            errorCode: 'internal_error',
            errorDetail: detail,
          },
          applied,
          at.toISOString(),
        );
      } catch {
        // The connection itself is failing; startup recovery closes the row.
      }
    }
    writeEvent(
      failureEvent({
        chatId: candidate.hostChatId,
        conversationId: candidate.conversationId,
        bucketId: candidate.bucketId,
        decisionId: trace.decisionId ?? null,
        mode: trace.settings?.mode ?? null,
        model: trace.settings?.model ?? null,
        applied,
        detail,
        at,
      }),
    );
  }

  /**
   * Phase 1 rolled back: forget the reservations `begin` made. No database work
   * — the rows went back with the transaction.
   */
  abandon(tokens: readonly DecisionToken[]): void {
    for (const token of tokens) {
      this.#forget(token);
    }
  }

  /** Runs one decided token after the due transaction committed. Never rejects. */
  start(token: DecisionToken): void {
    if (this.#stopped) {
      this.#forget(token);
      return;
    }
    let task: Promise<void>;
    task = this.#run(token)
      .catch((error: unknown) => {
        this.#logUnhandled(token, error);
      })
      .finally(() => {
        this.#inflight.delete(task);
      });
    this.#inflight.add(task);
  }

  /** Resolves when no decision is in flight; used by shutdown checks and tests. */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /**
   * Process shutdown: in-flight requests are aborted and every later result is
   * dropped without touching the database. Leftover `pending` rows are closed by
   * startup recovery, because the store may be gone by the time a result lands.
   */
  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
    this.#deciding.clear();
    this.#released.clear();
    this.#redecs.clear();
  }

  #eligible(candidate: DecisionCandidate): DecisionGateSettings | undefined {
    if (candidate.bucketKind !== 'realtime' || candidate.chatType === 'private') {
      return undefined;
    }
    const settings = this.#settings(this.#configStore.current().config, candidate.hostKind, candidate.chat);
    if (!settings.enabled) {
      return undefined;
    }
    // A released batch was already decided; it must take the whole existing
    // path, including a later `deferBucket`, without a second request.
    return this.#released.has(candidate.bucketId.toString()) ? undefined : settings;
  }

  #directTrigger(candidate: DecisionCandidate): boolean {
    return (
      bucketDirectTriggerKind({
        orm: this.#store.orm,
        config: this.#configStore.current().config,
        hostKind: candidate.hostKind,
        bucketId: candidate.bucketId,
        bot: this.#options.bot,
        keywords: candidate.keywords,
      }) !== null
    );
  }

  #settings(config: RawConfig, hostKind: HostKind, chat: Pick<FileChat, 'decision_gate'>): DecisionGateSettings {
    return resolveDecisionGate({ decision_gate: hostIntakeSettings(config, hostKind).decision_gate }, chat);
  }

  /** The Chat's settings under the currently published configuration, or undefined when it left the file. */
  #currentSettings(candidate: DecisionCandidate): DecisionGateSettings | undefined {
    const config = this.#configStore.current().config;
    const chat = resolveChatConfig(config, this.#store.orm, {
      hostKind: candidate.hostKind,
      hostChatId: candidate.hostChatId,
    });
    return chat === undefined ? undefined : this.#settings(config, candidate.hostKind, chat);
  }

  async #run(token: DecisionToken): Promise<void> {
    const plan = token.plan;
    try {
      if (plan.kind === 'settled') {
        this.#emit(token, plan.record, plan.applied, new Date());
        return;
      }
      const record = await resolveVerdict({
        settings: token.settings,
        instructions: token.instructions,
        state: plan.content.state,
        secrets: this.#options.secrets,
        signal: this.#abort.signal,
        stopped: () => this.#stopped,
        redact: this.#redact,
        ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
      });
      if (this.#stopped) {
        return;
      }
      this.#settle(token, record);
    } catch (error) {
      if (this.#stopped) {
        return;
      }
      try {
        this.#settle(
          token,
          failure({ settings: token.settings, redact: this.#redact }, 'internal_error', this.#redact(error), null),
        );
      } catch (settleError) {
        this.#logUnhandled(token, settleError);
      }
    } finally {
      this.#forget(token);
    }
  }

  #settle(token: DecisionToken, record: DecisionRecord): void {
    if (this.#stopped) {
      return;
    }
    const finishedAt = new Date();
    let final: { readonly record: DecisionRecord; readonly applied: boolean } = { record, applied: false };
    this.#store.transaction(() => {
      final = applyDecision(
        {
          store: this.#store,
          marks: { released: this.#released, redecs: this.#redecs },
          maxRedecisions: this.#maxRedecisions,
          currentSettings: (candidate) => this.#currentSettings(candidate),
          makeDue: (bucketId, at) => this.#makeDue(bucketId, at),
        },
        token,
        record,
        finishedAt,
      );
    });
    this.#emit(token, final.record, final.applied, finishedAt);
  }

  #makeDue(bucketId: bigint, now: Date): void {
    makeDue(this.#store, bucketId, now);
    this.#options.wake();
  }

  #forget(token: DecisionToken): void {
    if (token.plan.kind === 'request') {
      this.#active -= 1;
    }
    this.#deciding.delete(token.candidate.bucketId.toString());
  }

  readonly #redact = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return this.#options.secrets.redact(message);
  };

  #emit(token: DecisionToken, record: DecisionRecord, applied: boolean, at: Date): void {
    writeEvent(decisionEvent(token, record, applied, at));
  }

  /** A failure that escaped the settle path still lands as one line, never as a throw. */
  #logUnhandled(token: DecisionToken, error: unknown): void {
    writeEvent(
      failureEvent({
        chatId: token.candidate.hostChatId,
        conversationId: token.candidate.conversationId,
        bucketId: token.candidate.bucketId,
        decisionId: token.decisionId,
        mode: token.settings.mode,
        model: token.settings.model,
        applied: false,
        detail: this.#redact(error),
        at: new Date(),
      }),
    );
  }
}
