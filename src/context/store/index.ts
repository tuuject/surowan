import { and, eq, gte, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { contextMessages, contextRefs, conversationContexts } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import { decodeContextMessage } from '../codec.ts';
import {
  type ContextBudget,
  type ContextHeader,
  type ContextMessageInput,
  type ContextRebuildReason,
  type ContextStats,
  type ContextWindowRow,
  type OpenContextOptions,
  type RetainedContextMessage,
  StaleContextError,
} from './types.ts';

/**
 * Canonical Conversation Context storage.
 *
 * One row in `conversation_contexts` per Conversation, and the retained
 * transcript lives in `context_messages[head_seq, next_seq)`. This class is the
 * only writer of that history: the in-memory Pi agent is a disposable cache
 * seeded from here, never the other way around.
 */
export class ConversationContextStore {
  readonly #store: BusinessStore;

  constructor(store: BusinessStore) {
    this.#store = store;
  }

  /**
   * Returns the Conversation Context, creating it on first use.
   *
   * A different `systemPromptHash` means the stable system prompt changed,
   * which the design treats as "rebuild the context": continuity across two
   * different prompts is not something the model can be trusted to reconcile.
   *
   * A changed model budget (hot-reloaded `context_window` / `max_tokens`) only
   * rebuilds when the retained transcript no longer fits it. The persisted chat
   * history is untouched either way, so the next injection renders the recent
   * messages again under the new budget.
   */
  open(
    conversationId: bigint,
    systemPromptHash: string,
    options: OpenContextOptions = {},
  ): { header: ContextHeader; rebuilt: boolean; reason: ContextRebuildReason | null } {
    const timestamp = (options.now ?? new Date()).toISOString();
    const budget = options.budget;
    const existing = this.#selectHeader(conversationId);
    if (existing === undefined) {
      const created = this.#store.orm
        .insert(conversationContexts)
        .values({
          conversationId,
          systemPromptHash,
          ...(budget === undefined
            ? {}
            : {
                contextWindow: BigInt(budget.contextWindow),
                maxOutputTokens: BigInt(budget.maxOutputTokens),
              }),
          lastActiveAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: conversationContexts.id })
        .get();
      if (created === undefined) {
        throw new Error('conversation_contexts insert returned no row');
      }
      return { header: this.#requireHeader(conversationId), rebuilt: false, reason: null };
    }
    if (existing.systemPromptHash !== systemPromptHash) {
      this.#reset(existing, timestamp, { systemPromptHash, ...(budget === undefined ? {} : { budget }) });
      return { header: this.#requireHeader(conversationId), rebuilt: true, reason: 'system_prompt' };
    }
    if (budget === undefined) {
      return { header: existing, rebuilt: false, reason: null };
    }
    const storedWindow = existing.contextWindow;
    const storedMaxOutput = existing.maxOutputTokens;
    if (storedWindow === null || storedMaxOutput === null) {
      // A Context written before 052 has no recorded budget. Adopt the current
      // one without discarding continuity, unless the retained transcript
      // already exceeds it (for example a window lowered before the upgrade).
      if (this.stats(existing).retainedTokens > budget.maxRetainedTokens) {
        this.#reset(existing, timestamp, { budget });
        return { header: this.#requireHeader(conversationId), rebuilt: true, reason: 'context_window' };
      }
      this.#store.orm
        .update(conversationContexts)
        .set({
          contextWindow: BigInt(budget.contextWindow),
          maxOutputTokens: BigInt(budget.maxOutputTokens),
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, existing.id))
        .run();
      existing.contextWindow = BigInt(budget.contextWindow);
      existing.maxOutputTokens = BigInt(budget.maxOutputTokens);
      return { header: existing, rebuilt: false, reason: null };
    }
    if (storedWindow === BigInt(budget.contextWindow) && storedMaxOutput === BigInt(budget.maxOutputTokens)) {
      return { header: existing, rebuilt: false, reason: null };
    }
    if (this.stats(existing).retainedTokens > budget.maxRetainedTokens) {
      this.#reset(existing, timestamp, { budget });
      return { header: this.#requireHeader(conversationId), rebuilt: true, reason: 'context_window' };
    }
    // The retained transcript still fits; keep continuity and remember the
    // budget it now runs under so the next open does not re-check.
    this.#store.orm
      .update(conversationContexts)
      .set({
        contextWindow: BigInt(budget.contextWindow),
        maxOutputTokens: BigInt(budget.maxOutputTokens),
        updatedAt: timestamp,
      })
      .where(eq(conversationContexts.id, existing.id))
      .run();
    existing.contextWindow = BigInt(budget.contextWindow);
    existing.maxOutputTokens = BigInt(budget.maxOutputTokens);
    return { header: existing, rebuilt: false, reason: null };
  }

  /**
   * Drops the canonical transcript and starts the sequence space over. The
   * generation bump fences every writer that still holds the old header.
   */
  #reset(
    header: ContextHeader,
    timestamp: string,
    values: { readonly systemPromptHash?: string; readonly budget?: ContextBudget },
  ): void {
    const budget = values.budget;
    this.#store.transaction(() => {
      this.#store.orm.delete(contextMessages).where(eq(contextMessages.contextId, header.id)).run();
      this.#store.orm.delete(contextRefs).where(eq(contextRefs.contextId, header.id)).run();
      this.#store.orm
        .update(conversationContexts)
        .set({
          headSeq: 1n,
          nextSeq: 1n,
          sendCountTotal: 0n,
          ...(values.systemPromptHash === undefined ? {} : { systemPromptHash: values.systemPromptHash }),
          ...(budget === undefined
            ? {}
            : {
                contextWindow: BigInt(budget.contextWindow),
                maxOutputTokens: BigInt(budget.maxOutputTokens),
              }),
          activeInvocationId: null,
          lastGcAt: null,
          memoRefreshSeq: null,
          memoStateJson: null,
          memoRefreshPending: true,
          generation: sql`${conversationContexts.generation} + 1`,
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
  }

  header(conversationId: bigint): ContextHeader | undefined {
    return this.#selectHeader(conversationId);
  }

  /** Appends one persisted message and returns its sequence number. */
  append(header: ContextHeader, input: ContextMessageInput, now = new Date()): bigint {
    const seq = header.nextSeq;
    const timestamp = now.toISOString();
    const countedSend = input.countedSend === true;
    const memoState = input.isCheckpoint ? input.memoState : undefined;
    // Queued batches render before their real sequence is known.
    const memoRefreshSeq =
      memoState === undefined
        ? header.memoRefreshSeq
        : memoState.refresh
          ? seq
          : (header.memoRefreshSeq ?? memoState.refreshSeq);
    this.#store.transaction(() => {
      this.#assertGeneration(header);
      this.#store.orm
        .insert(contextMessages)
        .values({
          contextId: header.id,
          seq,
          role: input.role,
          payloadJson: input.json,
          invocationId: input.invocationId,
          isCheckpoint: input.isCheckpoint,
          sendSeq: countedSend ? header.sendCountTotal + 1n : null,
          estTokens: BigInt(input.estTokens),
          createdAt: timestamp,
        })
        .run();
      this.#store.orm
        .update(conversationContexts)
        .set({
          nextSeq: seq + 1n,
          ...(countedSend ? { sendCountTotal: header.sendCountTotal + 1n } : {}),
          ...(memoState === undefined
            ? {}
            : {
                memoRefreshSeq,
                memoStateJson: memoState.stateJson,
                memoRefreshPending: memoState.pending,
              }),
          lastActiveAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.nextSeq = seq + 1n;
    if (countedSend) {
      header.sendCountTotal += 1n;
    }
    if (memoState !== undefined) {
      header.memoRefreshSeq = memoRefreshSeq;
      header.memoStateJson = memoState.stateJson;
      header.memoRefreshPending = memoState.pending;
    }
    return seq;
  }

  /**
   * Retained rows in transcript order, decoded for seeding a Pi agent.
   *
   * Eviction is authoritative on its own, not only through `head_seq`: a caller
   * holding a header from before a concurrent `/cut_topic` has a stale, lower
   * `headSeq`, and a range read would resurrect exactly the history the cut
   * dropped. Filtering on `evicted_at` makes a dropped row stay dropped whatever
   * `head_seq` any live handle believes in.
   */
  retained(header: ContextHeader): RetainedContextMessage[] {
    return this.#store.orm
      .select({ seq: contextMessages.seq, payloadJson: contextMessages.payloadJson })
      .from(contextMessages)
      .where(this.#retainedRange(header))
      .orderBy(contextMessages.seq)
      .all()
      .map((row) => ({ seq: row.seq, message: decodeContextMessage(row.payloadJson) }));
  }

  window(header: ContextHeader): ContextWindowRow[] {
    return this.#store.orm
      .select({
        seq: contextMessages.seq,
        role: contextMessages.role,
        estTokens: contextMessages.estTokens,
        isCheckpoint: contextMessages.isCheckpoint,
        sendSeq: contextMessages.sendSeq,
      })
      .from(contextMessages)
      .where(this.#retainedRange(header))
      .orderBy(contextMessages.seq)
      .all();
  }

  #retainedRange(header: ContextHeader): SQL | undefined {
    return and(
      eq(contextMessages.contextId, header.id),
      gte(contextMessages.seq, header.headSeq),
      isNull(contextMessages.evictedAt),
    );
  }

  /**
   * Advances `head_seq`, soft-marking every dropped row and revoking the
   * references that were carried by them.
   */
  advanceHead(header: ContextHeader, targetSeq: bigint, now = new Date()): void {
    if (targetSeq <= header.headSeq || targetSeq >= header.nextSeq) {
      throw new Error(`Refusing to advance head_seq to ${targetSeq}`);
    }
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#assertGeneration(header);
      this.#store.orm
        .update(contextMessages)
        .set({ evictedAt: timestamp })
        .where(and(eq(contextMessages.contextId, header.id), lt(contextMessages.seq, targetSeq)))
        .run();
      this.#store.orm
        .delete(contextRefs)
        .where(and(eq(contextRefs.contextId, header.id), lt(contextRefs.sourceSeq, targetSeq)))
        .run();
      this.#store.orm
        .update(conversationContexts)
        .set({ headSeq: targetSeq, lastGcAt: timestamp, updatedAt: timestamp })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.headSeq = targetSeq;
    header.lastGcAt = timestamp;
  }

  /** `/cut_topic`: drop the whole retained history of one Conversation. */
  clear(header: ContextHeader, now = new Date()): void {
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      this.#assertGeneration(header);
      this.#store.orm
        .update(contextMessages)
        .set({ evictedAt: timestamp })
        .where(and(eq(contextMessages.contextId, header.id), gte(contextMessages.seq, header.headSeq)))
        .run();
      this.#store.orm.delete(contextRefs).where(eq(contextRefs.contextId, header.id)).run();
      this.#store.orm
        .update(conversationContexts)
        .set({
          headSeq: header.nextSeq,
          generation: sql`${conversationContexts.generation} + 1`,
          updatedAt: timestamp,
        })
        .where(eq(conversationContexts.id, header.id))
        .run();
    });
    header.headSeq = header.nextSeq;
    header.generation += 1n;
  }

  /** Chat-level variant used when a configuration reload removes a Chat. */
  requestMemoRefreshForConversations(conversationIds: readonly bigint[], now = new Date()): void {
    if (conversationIds.length === 0) {
      return;
    }
    const timestamp = now.toISOString();
    this.#store.transaction(() => {
      for (const conversationId of conversationIds) {
        this.#store.orm
          .update(conversationContexts)
          .set({ memoRefreshPending: true, updatedAt: timestamp })
          .where(eq(conversationContexts.conversationId, conversationId))
          .run();
      }
    });
  }

  /**
   * Drops the canonical transcript and resets the sequence counters for the
   * listed Conversations. The next run opens the same header (same stable prompt
   * hash) but starts from a clean context; the caller must have aborted and
   * forgotten every in-memory run first, otherwise a stale Agent could append on
   * top of the reset.
   */
  rebuildForConversations(conversationIds: readonly bigint[], now = new Date()): number {
    if (conversationIds.length === 0) {
      return 0;
    }
    const timestamp = now.toISOString();
    return this.#store.transaction(() => {
      let rebuilt = 0;
      for (const conversationId of conversationIds) {
        const header = this.#selectHeader(conversationId);
        if (header === undefined) {
          continue;
        }
        this.#store.orm.delete(contextMessages).where(eq(contextMessages.contextId, header.id)).run();
        this.#store.orm.delete(contextRefs).where(eq(contextRefs.contextId, header.id)).run();
        this.#store.orm
          .update(conversationContexts)
          .set({
            headSeq: 1n,
            nextSeq: 1n,
            sendCountTotal: 0n,
            activeInvocationId: null,
            lastGcAt: null,
            memoRefreshSeq: null,
            memoStateJson: null,
            memoRefreshPending: true,
            generation: sql`${conversationContexts.generation} + 1`,
            updatedAt: timestamp,
          })
          .where(eq(conversationContexts.id, header.id))
          .run();
        rebuilt += 1;
      }
      return rebuilt;
    });
  }

  /** Records that the invocation owning this context started or ended. */
  touch(header: ContextHeader, activeInvocationId: bigint | null, now = new Date()): void {
    this.#store.orm
      .update(conversationContexts)
      .set({ activeInvocationId, lastActiveAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(and(eq(conversationContexts.id, header.id), eq(conversationContexts.generation, header.generation)))
      .run();
  }

  clearActiveInvocation(invocationId: bigint, now = new Date()): void {
    this.#store.orm
      .update(conversationContexts)
      .set({ activeInvocationId: null, updatedAt: now.toISOString() })
      .where(eq(conversationContexts.activeInvocationId, invocationId))
      .run();
  }

  stats(header: ContextHeader): ContextStats {
    const row = this.#store.orm
      .all<{ count: bigint; sends: bigint; tokens: bigint | null }>(
        sql`SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN send_seq IS NOT NULL THEN 1 ELSE 0 END), 0) AS sends,
                SUM(est_tokens) AS tokens
         FROM context_messages WHERE context_id = ${header.id} AND seq >= ${header.headSeq} AND evicted_at IS NULL`,
      )
      .at(0);
    return {
      headSeq: header.headSeq,
      nextSeq: header.nextSeq,
      messageCount: Number(row?.count ?? 0n),
      retainedSends: Number(row?.sends ?? 0n),
      retainedTokens: Number(row?.tokens ?? 0n),
      lastGcAt: header.lastGcAt,
    };
  }

  /**
   * Rejects a writer whose header predates a canonical reset. The check runs
   * inside the write transaction, so a reset that commits just before it is
   * observed and the stale append/head move is refused instead of resurrecting
   * the discarded transcript.
   */
  #assertGeneration(header: ContextHeader): void {
    const current = this.#store.orm
      .select({ generation: conversationContexts.generation })
      .from(conversationContexts)
      .where(eq(conversationContexts.id, header.id))
      .get();
    if (current === undefined || current.generation !== header.generation) {
      throw new StaleContextError(header.id);
    }
  }

  #selectHeader(conversationId: bigint): ContextHeader | undefined {
    const row = this.#store.orm
      .select({
        id: conversationContexts.id,
        conversationId: conversationContexts.conversationId,
        headSeq: conversationContexts.headSeq,
        nextSeq: conversationContexts.nextSeq,
        sendCountTotal: conversationContexts.sendCountTotal,
        systemPromptHash: conversationContexts.systemPromptHash,
        generation: conversationContexts.generation,
        contextWindow: conversationContexts.contextWindow,
        maxOutputTokens: conversationContexts.maxOutputTokens,
        lastGcAt: conversationContexts.lastGcAt,
        memoRefreshSeq: conversationContexts.memoRefreshSeq,
        memoStateJson: conversationContexts.memoStateJson,
        memoRefreshPending: conversationContexts.memoRefreshPending,
      })
      .from(conversationContexts)
      .where(eq(conversationContexts.conversationId, conversationId))
      .get();
    return row;
  }

  #requireHeader(conversationId: bigint): ContextHeader {
    const header = this.#selectHeader(conversationId);
    if (header === undefined) {
      throw new Error(`Conversation ${conversationId} has no context row`);
    }
    return header;
  }
}
