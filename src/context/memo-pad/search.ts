import { MEMO_SEARCH_DEFAULT_LIMIT, MEMO_SEARCH_MAX_LIMIT, type MemoEntry } from './index.ts';

export interface SearchMemoInput {
  readonly keywords?: readonly string[] | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
}

type SearchableMemo = Pick<MemoEntry, 'id' | 'summary' | 'detail' | 'createdAt' | 'expiresAt'>;

export function isMemoActive(entry: Pick<MemoEntry, 'expiresAt'>, now = new Date()): boolean {
  return entry.expiresAt === null || entry.expiresAt > now.toISOString();
}

/** Shared live/replay matching, including expiry and inclusive date-only bounds. */
export function searchMemoEntries<T extends SearchableMemo>(
  entries: readonly T[],
  input: SearchMemoInput,
  now = new Date(),
): T[] {
  const from = input.from === undefined ? undefined : parsedDateBound(input.from, 'from');
  const to = input.to === undefined ? undefined : parsedDateBound(input.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error('from must not be later than to');
  }
  const keywords = [...new Set((input.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  return entries
    .filter((entry) => {
      if (
        !isMemoActive(entry, now) ||
        (from !== undefined && entry.createdAt < from) ||
        (to !== undefined && entry.createdAt > to)
      ) {
        return false;
      }
      const summary = entry.summary.toLowerCase();
      const detail = entry.detail.toLowerCase();
      const hits = keywords.filter((keyword) => summary.includes(keyword) || detail.includes(keyword)).length;
      return hits >= Math.ceil(keywords.length / 2);
    })
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? 1 : -1;
      }
      return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
    })
    .slice(0, Math.min(input.limit ?? MEMO_SEARCH_DEFAULT_LIMIT, MEMO_SEARCH_MAX_LIMIT));
}

function parsedDateBound(value: string, field: 'from' | 'to'): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly && field === 'to' ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date`);
  }
  return parsed.toISOString();
}
