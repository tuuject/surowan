import { sql } from 'drizzle-orm';
import { asRunResult, type Orm } from '../../store/store.ts';
import { groupMemories, groupMemoryState } from '../../store/schema/index.ts';
import {
  GROUP_MEMORY_CLAIM_STALE_MS,
  GROUP_MEMORY_RETRY_DELAY_MS,
  GROUP_MEMORY_SEARCH_DEFAULT_LIMIT,
  GROUP_MEMORY_SEARCH_MAX_LIMIT,
  type GroupMemoryEntry,
  type GroupMemoryEvent,
  type GroupMemoryStateRow,
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
 * Chat-scoped group memory persistence and the sleeping worker's watermark.
 *
 * Every read and write is scoped by `chatId`; an id from another Chat reads as
 * missing. The state row is the only claim authority: a worker must win
 * `claim()` before it calls a model, and a crash leaves `running` behind only
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

  state(chatId: bigint): GroupMemoryStateRow | undefined {
    return this.#orm
      .select({
        chatId: groupMemoryState.chatId,
        consolidatedThroughMessageId: groupMemoryState.consolidatedThroughMessageId,
        state: groupMemoryState.state,
        claimedAt: groupMemoryState.claimedAt,
        lastAttemptAt: groupMemoryState.lastAttemptAt,
        lastSuccessAt: groupMemoryState.lastSuccessAt,
        nextAttemptAt: groupMemoryState.nextAttemptAt,
        errorCode: groupMemoryState.errorCode,
        updatedAt: groupMemoryState.updatedAt,
      })
      .from(groupMemoryState)
      .where(sql`${groupMemoryState.chatId} = ${chatId}`)
      .get();
  }

  /**
   * Atomically takes the consolidation slot for one Chat. Returns false when
   * another claim is live, a backoff is still waiting, or the previous claim has
   * not gone stale.
   */
  claim(chatId: bigint, now = new Date()): boolean {
    const timestamp = now.toISOString();
    const staleBefore = new Date(now.getTime() - GROUP_MEMORY_CLAIM_STALE_MS).toISOString();
    const result = asRunResult(
      this.#orm.run(sql`
      INSERT INTO group_memory_state (
        chat_id, consolidated_through_message_id, state, claimed_at, last_attempt_at, updated_at
      ) VALUES (${chatId}, 0, 'running', ${timestamp}, ${timestamp}, ${timestamp})
      ON CONFLICT(chat_id) DO UPDATE SET
        state = 'running',
        claimed_at = excluded.claimed_at,
        last_attempt_at = excluded.last_attempt_at,
        updated_at = excluded.updated_at
      WHERE group_memory_state.state <> 'running'
        AND (group_memory_state.claimed_at IS NULL OR group_memory_state.claimed_at < ${staleBefore})
        AND (group_memory_state.next_attempt_at IS NULL OR group_memory_state.next_attempt_at <= ${timestamp})
    `),
    );
    return result.changes === 1;
  }

  /**
   * Persists one successful batch and advances the watermark in one transaction.
   * `through` is the highest Telegram message id the batch read, so messages the
   * model chose not to summarize are still not retried forever.
   */
  commit(chatId: bigint, day: string, events: readonly GroupMemoryEvent[], through: bigint, now = new Date()): void {
    const timestamp = now.toISOString();
    this.#orm.transaction(
      () => {
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
        this.#orm.run(sql`
          UPDATE group_memory_state
          SET consolidated_through_message_id = MAX(consolidated_through_message_id, ${through}),
              state = 'idle',
              claimed_at = NULL,
              last_success_at = ${timestamp},
              next_attempt_at = NULL,
              error_code = NULL,
              updated_at = ${timestamp}
          WHERE chat_id = ${chatId}
        `);
      },
      { behavior: 'immediate' },
    );
  }

  /** Releases a failed claim with a backoff so a bad batch is not hammered. */
  fail(
    chatId: bigint,
    errorCode: string,
    now = new Date(),
    retryDelayMilliseconds = GROUP_MEMORY_RETRY_DELAY_MS,
  ): void {
    const timestamp = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + retryDelayMilliseconds).toISOString();
    this.#orm.run(sql`
      UPDATE group_memory_state
      SET state = 'idle',
          claimed_at = NULL,
          next_attempt_at = ${nextAttemptAt},
          error_code = ${errorCode},
          updated_at = ${timestamp}
      WHERE chat_id = ${chatId} AND state = 'running'
    `);
  }

  /** Returns stale `running` claims after a crash to `idle`; used at startup and each tick. */
  recoverStale(now = new Date()): number {
    const staleBefore = new Date(now.getTime() - GROUP_MEMORY_CLAIM_STALE_MS).toISOString();
    const timestamp = now.toISOString();
    const result = asRunResult(
      this.#orm.run(sql`
      UPDATE group_memory_state
      SET state = 'idle', claimed_at = NULL, error_code = 'stale_claim', updated_at = ${timestamp}
      WHERE state = 'running' AND claimed_at IS NOT NULL AND claimed_at < ${staleBefore}
    `),
    );
    return result.changes;
  }
}
