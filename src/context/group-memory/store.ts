import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { asRunResult, type Orm } from '../../store/store.ts';
import { groupMemories, groupMemoryLanes, groupMemoryRuns } from '../../store/schema/index.ts';
import {
  GROUP_MEMORY_CLAIM_STALE_MS,
  GROUP_MEMORY_RETRY_DELAY_MS,
  GROUP_MEMORY_SEARCH_DEFAULT_LIMIT,
  GROUP_MEMORY_SEARCH_MAX_LIMIT,
  type GroupMemoryEntry,
  type GroupMemoryEvent,
  type GroupMemoryLaneKind,
  type GroupMemoryLaneRow,
  newGroupMemoryId,
} from './index.ts';

/** Rows read per keyset page while a keyword search looks for matches. */
const SEARCH_SCAN_PAGE_SIZE = 500;

export interface SearchGroupMemory {
  readonly day?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

interface EntryRow {
  readonly id: string;
  readonly chat_id: bigint;
  readonly day: string;
  readonly summary: string;
  readonly first_message_id: bigint;
  readonly last_message_id: bigint;
  readonly created_at: string;
}

function toEntry(row: EntryRow): GroupMemoryEntry {
  return {
    id: row.id,
    chatId: row.chat_id,
    day: row.day,
    summary: row.summary,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at,
  };
}

/**
 * Chat-scoped group memory persistence, the sleeping worker's lanes and its run
 * audit.
 *
 * Every read and write is scoped by `chatId`; an id from another Chat reads as
 * missing. A lane row is the only claim authority: a worker must win `claim()`
 * before it calls a model, and its `claimed_at` is the fence `commit()` and
 * `fail()` check, so a lane that was deleted or re-created while the model ran
 * takes no write from the stale batch. A crash leaves `running` behind only
 * until `recoverStale()` expires it.
 */
export class GroupMemoryStore {
  readonly #orm: Orm;

  constructor(orm: Orm) {
    this.#orm = orm;
  }

  /**
   * Newest entries first. Keywords match the summary case-insensitively; with
   * several keywords at least half must match, the same rule Memo Pad uses.
   *
   * Matching is done in JavaScript (Unicode-aware lowercasing, which SQLite's
   * `lower()` is not), so the rows are scanned in keyset pages until `limit`
   * matches are found or the Chat's history is exhausted: an old entry stays
   * reachable however many newer ones exist.
   */
  list(chatId: bigint, input: SearchGroupMemory = {}): GroupMemoryEntry[] {
    const limit = Math.min(input.limit ?? GROUP_MEMORY_SEARCH_DEFAULT_LIMIT, GROUP_MEMORY_SEARCH_MAX_LIMIT);
    const keywords = (input.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const needed = keywords.length === 0 ? 0 : Math.ceil(keywords.length / 2);
    const matches = (entry: GroupMemoryEntry): boolean =>
      needed === 0 || keywords.filter((keyword) => entry.summary.toLowerCase().includes(keyword)).length >= needed;
    const pageSize = needed === 0 ? limit : SEARCH_SCAN_PAGE_SIZE;
    const found: GroupMemoryEntry[] = [];
    let after: EntryRow | undefined;
    while (found.length < limit) {
      const rows = this.#orm.all<EntryRow>(
        sql`SELECT id, chat_id, day, summary, first_message_id, last_message_id, created_at
            FROM group_memories
            WHERE chat_id = ${chatId}${input.day === undefined ? sql`` : sql` AND day = ${input.day}`}${
              after === undefined
                ? sql``
                : sql` AND (day < ${after.day}
                    OR (day = ${after.day} AND first_message_id > ${after.first_message_id})
                    OR (day = ${after.day} AND first_message_id = ${after.first_message_id} AND id > ${after.id}))`
            }
            ORDER BY day DESC, first_message_id ASC, id ASC
            LIMIT ${BigInt(pageSize)}`,
      );
      for (const row of rows) {
        const entry = toEntry(row);
        if (matches(entry)) {
          found.push(entry);
          if (found.length >= limit) {
            break;
          }
        }
      }
      if (rows.length < pageSize) {
        break;
      }
      after = rows.at(-1);
    }
    return found;
  }

  lane(chatId: bigint, lane: GroupMemoryLaneKind): GroupMemoryLaneRow | undefined {
    return this.#orm
      .select()
      .from(groupMemoryLanes)
      .where(and(eq(groupMemoryLanes.chatId, chatId), eq(groupMemoryLanes.lane, lane)))
      .get();
  }

  /** The Chat's lanes, live first. */
  lanes(chatId: bigint): GroupMemoryLaneRow[] {
    return this.#orm
      .select()
      .from(groupMemoryLanes)
      .where(eq(groupMemoryLanes.chatId, chatId))
      .all()
      .sort((left, right) => (left.lane === right.lane ? 0 : left.lane === 'live' ? -1 : 1));
  }

  /**
   * Starts group memory for a Chat whose switch is on: a live lane that begins
   * after `through` (the newest message stored when the switch was seen on).
   * History before it is never queued. An existing live lane is kept, so calling
   * this again is harmless. True when a lane was created.
   */
  activate(chatId: bigint, through: bigint, now = new Date()): boolean {
    const timestamp = now.toISOString();
    const result = asRunResult(
      this.#orm.run(sql`
        INSERT INTO group_memory_lanes (chat_id, lane, through_message_id, state, created_at, updated_at)
        VALUES (${chatId}, 'live', ${through}, 'idle', ${timestamp}, ${timestamp})
        ON CONFLICT(chat_id, lane) DO NOTHING
      `),
    );
    return result.changes === 1;
  }

  /**
   * Drops every lane of the Chats whose switch is off, so switching it on again
   * starts after the newest message instead of replaying the gap. Summaries and
   * raw messages stay. Returns the number of lanes removed.
   */
  deactivate(chatIds: readonly bigint[]): number {
    if (chatIds.length === 0) {
      return 0;
    }
    return asRunResult(
      this.#orm
        .delete(groupMemoryLanes)
        .where(inArray(groupMemoryLanes.chatId, [...chatIds]))
        .run(),
    ).changes;
  }

  /** `deactivate` for every Chat that is not in `activeChatIds`. */
  deactivateAllExcept(activeChatIds: readonly bigint[]): number {
    const query = this.#orm.delete(groupMemoryLanes);
    return asRunResult(
      (activeChatIds.length === 0 ? query : query.where(notInArray(groupMemoryLanes.chatId, [...activeChatIds]))).run(),
    ).changes;
  }

  /**
   * Hands the live lane's backlog up to `splitPoint` to a new backfill lane, so
   * the live lane continues from there. Only an idle live lane without a
   * backfill lane is split. The backfill lane starts without backoff; the live
   * lane keeps its own. True when the split happened.
   */
  split(chatId: bigint, splitPoint: bigint, now = new Date()): boolean {
    const timestamp = now.toISOString();
    return this.#orm.transaction(
      () => {
        const live = this.lane(chatId, 'live');
        if (
          live === undefined ||
          live.state !== 'idle' ||
          splitPoint <= live.throughMessageId ||
          this.lane(chatId, 'backfill') !== undefined
        ) {
          return false;
        }
        this.#orm
          .insert(groupMemoryLanes)
          .values({
            chatId,
            lane: 'backfill',
            throughMessageId: live.throughMessageId,
            untilMessageId: splitPoint,
            state: 'idle',
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
        this.#orm
          .update(groupMemoryLanes)
          .set({ throughMessageId: splitPoint, updatedAt: timestamp })
          .where(and(eq(groupMemoryLanes.chatId, chatId), eq(groupMemoryLanes.lane, 'live')))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  /** Removes an idle backfill lane that has nothing left to read. */
  finishBackfill(chatId: bigint): boolean {
    return (
      asRunResult(
        this.#orm
          .delete(groupMemoryLanes)
          .where(
            and(
              eq(groupMemoryLanes.chatId, chatId),
              eq(groupMemoryLanes.lane, 'backfill'),
              eq(groupMemoryLanes.state, 'idle'),
            ),
          )
          .run(),
      ).changes === 1
    );
  }

  /**
   * Atomically takes one lane's consolidation slot. Returns the claim token, or
   * undefined when the lane is missing, another claim is live, a backoff is
   * still waiting, or the previous claim has not gone stale.
   */
  claim(chatId: bigint, lane: GroupMemoryLaneKind, now = new Date()): string | undefined {
    const timestamp = now.toISOString();
    const staleBefore = new Date(now.getTime() - GROUP_MEMORY_CLAIM_STALE_MS).toISOString();
    const result = asRunResult(
      this.#orm.run(sql`
        UPDATE group_memory_lanes
        SET state = 'running', claimed_at = ${timestamp}, last_attempt_at = ${timestamp}, updated_at = ${timestamp}
        WHERE chat_id = ${chatId} AND lane = ${lane}
          AND state <> 'running'
          AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${timestamp})
      `),
    );
    return result.changes === 1 ? timestamp : undefined;
  }

  /**
   * Persists one successful batch and advances the lane in one transaction.
   * `through` is the highest Telegram message id the batch read, so messages the
   * model chose not to summarize are still not retried forever. A backfill lane
   * that reaches its end is removed. Returns false, writing nothing, when the
   * claim is gone (the lane was switched off, re-created or recovered as stale).
   */
  commit(
    chatId: bigint,
    lane: GroupMemoryLaneKind,
    claimedAt: string,
    day: string,
    events: readonly GroupMemoryEvent[],
    through: bigint,
    now = new Date(),
  ): boolean {
    const timestamp = now.toISOString();
    return this.#orm.transaction(
      () => {
        const advanced = asRunResult(
          this.#orm.run(sql`
            UPDATE group_memory_lanes
            SET through_message_id = MAX(through_message_id, ${through}),
                state = 'idle',
                claimed_at = NULL,
                last_success_at = ${timestamp},
                next_attempt_at = NULL,
                error_code = NULL,
                consecutive_failures = 0,
                updated_at = ${timestamp}
            WHERE chat_id = ${chatId} AND lane = ${lane} AND state = 'running' AND claimed_at = ${claimedAt}
          `),
        );
        if (advanced.changes !== 1) {
          return false;
        }
        this.record(chatId, day, events, now);
        this.#orm.run(sql`
          DELETE FROM group_memory_lanes
          WHERE chat_id = ${chatId} AND lane = 'backfill' AND ${lane} = 'backfill'
            AND through_message_id >= until_message_id
        `);
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  /** Inserts event summaries without touching a lane; `commit` and fixtures use it. */
  record(chatId: bigint, day: string, events: readonly GroupMemoryEvent[], now = new Date()): void {
    const timestamp = now.toISOString();
    for (const event of events) {
      this.#orm
        .insert(groupMemories)
        .values({
          id: newGroupMemoryId(),
          chatId,
          day,
          summary: event.summary,
          firstMessageId: event.firstMessageId,
          lastMessageId: event.lastMessageId,
          createdAt: timestamp,
        })
        .run();
    }
  }

  /** Releases a failed claim with a backoff so a bad batch is not hammered. */
  fail(
    chatId: bigint,
    lane: GroupMemoryLaneKind,
    claimedAt: string,
    errorCode: string,
    now = new Date(),
    retryDelayMilliseconds = GROUP_MEMORY_RETRY_DELAY_MS,
  ): void {
    const timestamp = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + retryDelayMilliseconds).toISOString();
    this.#orm.run(sql`
      UPDATE group_memory_lanes
      SET state = 'idle',
          claimed_at = NULL,
          next_attempt_at = ${nextAttemptAt},
          error_code = ${errorCode},
          consecutive_failures = consecutive_failures + 1,
          updated_at = ${timestamp}
      WHERE chat_id = ${chatId} AND lane = ${lane} AND state = 'running' AND claimed_at = ${claimedAt}
    `);
  }

  /** Returns stale `running` claims after a crash to `idle`; used at startup and each tick. */
  recoverStale(now = new Date()): number {
    const staleBefore = new Date(now.getTime() - GROUP_MEMORY_CLAIM_STALE_MS).toISOString();
    const timestamp = now.toISOString();
    const result = asRunResult(
      this.#orm.run(sql`
        UPDATE group_memory_lanes
        SET state = 'idle', claimed_at = NULL, error_code = 'stale_claim', updated_at = ${timestamp}
        WHERE state = 'running' AND claimed_at IS NOT NULL AND claimed_at < ${staleBefore}
      `),
    );
    return result.changes;
  }

  /** Opens the audit row of one batch. */
  startRun(
    run: {
      readonly chatId: bigint;
      readonly lane: GroupMemoryLaneKind;
      readonly day: string;
      readonly firstMessageId: bigint;
      readonly throughMessageId: bigint;
      readonly messages: number;
    },
    now = new Date(),
  ): bigint {
    const row = this.#orm
      .insert(groupMemoryRuns)
      .values({
        chatId: run.chatId,
        lane: run.lane,
        day: run.day,
        firstMessageId: run.firstMessageId,
        throughMessageId: run.throughMessageId,
        messages: BigInt(run.messages),
        state: 'running',
        startedAt: now.toISOString(),
      })
      .returning({ id: groupMemoryRuns.id })
      .get();
    if (row === undefined) {
      throw new Error('group_memory_runs insert returned no row');
    }
    return row.id;
  }

  /** Count requests before dispatch, so an interrupted process cannot erase them. */
  recordRunCall(
    id: bigint,
    progress: { readonly through: bigint; readonly messages: number; readonly modelCalls: number },
  ): void {
    const updated = asRunResult(
      this.#orm
        .update(groupMemoryRuns)
        .set({
          throughMessageId: progress.through,
          messages: BigInt(progress.messages),
          modelCalls: BigInt(progress.modelCalls),
        })
        .where(and(eq(groupMemoryRuns.id, id), eq(groupMemoryRuns.state, 'running')))
        .run(),
    );
    if (updated.changes !== 1) {
      throw new Error('Group memory run is no longer active');
    }
  }

  /** Closes a batch's audit row with what it actually read and how it ended. */
  finishRun(
    id: bigint,
    outcome: {
      readonly state: 'success' | 'error';
      readonly throughMessageId: bigint;
      readonly messages: number;
      readonly events: number | null;
      readonly modelCalls: number;
      readonly errorCode: string | null;
      readonly errorDetail: string | null;
    },
    now = new Date(),
  ): void {
    this.#orm
      .update(groupMemoryRuns)
      .set({
        state: outcome.state,
        throughMessageId: sql`MAX(first_message_id, ${outcome.throughMessageId})`,
        messages: BigInt(outcome.messages),
        events: outcome.events === null ? null : BigInt(outcome.events),
        modelCalls: BigInt(outcome.modelCalls),
        errorCode: outcome.errorCode,
        errorDetail: outcome.errorDetail,
        finishedAt: now.toISOString(),
      })
      .where(eq(groupMemoryRuns.id, id))
      .run();
  }

  /** Closes runs a previous process left open; only one process consolidates. */
  interruptRuns(now = new Date()): number {
    return asRunResult(
      this.#orm
        .update(groupMemoryRuns)
        .set({ state: 'error', errorCode: 'interrupted', finishedAt: now.toISOString() })
        .where(eq(groupMemoryRuns.state, 'running'))
        .run(),
    ).changes;
  }
}
