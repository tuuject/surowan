import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { asRunResult, type Orm } from '../../store/store.ts';
import { memoPadEntries } from '../../store/schema/index.ts';
import { type MemoEntry, type MemoStateEntry, MEMO_SEARCH_DEFAULT_LIMIT, newMemoId } from './index.ts';

export interface CreateMemoInput {
  readonly summary: string;
  readonly detail: string;
  /** Omit for permanent; a number makes the entry short-term. */
  readonly ttlSeconds?: number | undefined;
}

export interface UpdateMemoInput {
  readonly summary?: string | undefined;
  readonly detail?: string | undefined;
  /** Omit to leave the expiry; `null` promotes the entry to permanent. */
  readonly ttlSeconds?: number | null | undefined;
}

export interface SearchMemoInput {
  readonly keywords?: readonly string[] | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
}

const ENTRY_FIELDS = {
  id: memoPadEntries.id,
  chatId: memoPadEntries.chatId,
  summary: memoPadEntries.summary,
  detail: memoPadEntries.detail,
  createdAt: memoPadEntries.createdAt,
  expiresAt: memoPadEntries.expiresAt,
  updatedAt: memoPadEntries.updatedAt,
} as const;

/**
 * Chat-scoped Memo Pad persistence. Every query is scoped by `chatId`, so a
 * record id from another Chat reads as missing exactly like an unknown id.
 */
export class MemoPadStore {
  readonly orm: Orm;

  constructor(orm: Orm) {
    this.orm = orm;
  }

  /** Every live entry of one Chat, oldest first. */
  listActive(chatId: bigint, now = new Date()): MemoEntry[] {
    const nowIso = now.toISOString();
    return this.orm
      .select(ENTRY_FIELDS)
      .from(memoPadEntries)
      .where(
        and(
          eq(memoPadEntries.chatId, chatId),
          or(isNull(memoPadEntries.expiresAt), gt(memoPadEntries.expiresAt, nowIso)),
        ),
      )
      .orderBy(memoPadEntries.createdAt, memoPadEntries.id)
      .all();
  }

  /** Live entries that expire: the only ones auto-injected into Context. */
  shortTerm(chatId: bigint, now = new Date()): MemoEntry[] {
    const nowIso = now.toISOString();
    return this.orm
      .select(ENTRY_FIELDS)
      .from(memoPadEntries)
      .where(and(eq(memoPadEntries.chatId, chatId), gt(memoPadEntries.expiresAt, nowIso)))
      .orderBy(memoPadEntries.createdAt, memoPadEntries.id)
      .all();
  }

  get(id: string, chatId: bigint): MemoEntry | undefined {
    return this.orm
      .select(ENTRY_FIELDS)
      .from(memoPadEntries)
      .where(and(eq(memoPadEntries.id, id), eq(memoPadEntries.chatId, chatId)))
      .get();
  }

  create(chatId: bigint, input: CreateMemoInput, now = new Date()): MemoEntry {
    const timestamp = now.toISOString();
    const entry: MemoEntry = {
      id: newMemoId(),
      chatId,
      summary: input.summary,
      detail: input.detail,
      createdAt: timestamp,
      expiresAt:
        input.ttlSeconds === undefined ? null : new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
      updatedAt: timestamp,
    };
    this.orm.transaction(
      () => {
        this.orm.run(
          sql`DELETE FROM memo_pad_entries WHERE chat_id = ${chatId} AND expires_at IS NOT NULL AND expires_at <= ${timestamp}`,
        );
        this.orm
          .insert(memoPadEntries)
          .values({
            id: entry.id,
            chatId,
            summary: entry.summary,
            detail: entry.detail,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
            updatedAt: entry.updatedAt,
          })
          .run();
      },
      { behavior: 'immediate' },
    );
    return entry;
  }

  /** Full-row update. Returns undefined when the id is not in this Chat. */
  update(id: string, chatId: bigint, input: UpdateMemoInput, now = new Date()): MemoEntry | undefined {
    const existing = this.get(id, chatId);
    if (existing === undefined) {
      return undefined;
    }
    const timestamp = now.toISOString();
    const expiresAt =
      input.ttlSeconds === undefined
        ? existing.expiresAt
        : input.ttlSeconds === null
          ? null
          : new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString();
    this.orm
      .update(memoPadEntries)
      .set({
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        expiresAt,
        updatedAt: timestamp,
      })
      .where(and(eq(memoPadEntries.id, id), eq(memoPadEntries.chatId, chatId)))
      .run();
    return this.get(id, chatId);
  }

  /** Idempotent: false when nothing was deleted. */
  remove(id: string, chatId: bigint, now = new Date()): boolean {
    return this.orm.transaction(
      () => {
        // Delete the requested row first so an already-expired id is still
        // reported as deleted; the opportunistic purge follows.
        const result = asRunResult(
          this.orm
            .delete(memoPadEntries)
            .where(and(eq(memoPadEntries.id, id), eq(memoPadEntries.chatId, chatId)))
            .run(),
        );
        this.orm.run(
          sql`DELETE FROM memo_pad_entries WHERE chat_id = ${chatId} AND expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}`,
        );
        return result.changes === 1;
      },
      { behavior: 'immediate' },
    );
  }

  /** Deletes expired rows; returns how many were removed. */
  purgeExpired(chatId: bigint | null = null, now = new Date()): number {
    const timestamp = now.toISOString();
    const result = asRunResult(
      chatId === null
        ? this.orm.delete(memoPadEntries).where(lte(memoPadEntries.expiresAt, timestamp)).run()
        : this.orm
            .delete(memoPadEntries)
            .where(and(eq(memoPadEntries.chatId, chatId), lte(memoPadEntries.expiresAt, timestamp)))
            .run(),
    );
    return result.changes;
  }

  /**
   * Keyword/date search. A single keyword must match; several keywords need at
   * least half of them, rounded up. Matching is a case-insensitive substring over
   * `summary` and `detail`.
   */
  search(chatId: bigint, input: SearchMemoInput, now = new Date()): MemoEntry[] {
    const from = input.from === undefined ? undefined : parsedDateBound(input.from, 'from');
    const to = input.to === undefined ? undefined : parsedDateBound(input.to, 'to', true);
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must not be later than to');
    }
    const rows = this.listActive(chatId, now).filter(
      (entry) => (from === undefined || entry.createdAt >= from) && (to === undefined || entry.createdAt <= to),
    );
    const keywords = [
      ...new Set((input.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)),
    ];
    const limit = Math.min(input.limit ?? MEMO_SEARCH_DEFAULT_LIMIT, 50);
    const matched =
      keywords.length === 0
        ? rows
        : rows.filter((entry) => {
            const summary = entry.summary.toLowerCase();
            const detail = entry.detail.toLowerCase();
            const hits = keywords.filter((keyword) => summary.includes(keyword) || detail.includes(keyword)).length;
            return hits >= Math.ceil(keywords.length / 2);
          });
    return matched.toReversed().slice(0, limit);
  }

  /** The exact short-term state used by the injected snapshot and its deltas. */
  state(chatId: bigint, now = new Date()): MemoStateEntry[] {
    return this.shortTerm(chatId, now).map((entry) => ({
      id: entry.id,
      summary: entry.summary,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  }
}

/**
 * ISO bound for `created_at`. A date-only upper bound covers the whole day, so
 * `to: "2026-10-30"` includes entries created at 23:59.
 */
function parsedDateBound(value: string, field: 'from' | 'to', endOfDay = false): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly && endOfDay ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date`);
  }
  return parsed.toISOString();
}
