/**
 * Pure Memo Pad form helpers shared by the Memories page forms and list.
 * The bounds mirror the backend (`src/context/memo-pad/index.ts` and
 * `src/ingress/admin/memory.ts`): the summary is capped at 150 characters, the
 * detail at 32768, and TTL days are 1..1825 (the backend stores seconds,
 * minimum 60; the panel edits at day granularity).
 */

import i18n from './i18n.ts';

export const DAY_SECONDS = 86_400;
export const MEMORY_SUMMARY_MAX_LENGTH = 150;
export const MEMORY_DETAIL_MAX_LENGTH = 32_768;
export const TTL_MIN_DAYS = 1;
export const TTL_MAX_DAYS = 1_825;

/**
 * Create semantics: converts a TTL in days to seconds; `null`/`undefined`
 * stays `undefined` and the entry is created permanent (long-term).
 */
export function daysToTtlSeconds(days: number | null | undefined): number | undefined {
  if (days === null || days === undefined) {
    return undefined;
  }
  return days * DAY_SECONDS;
}

/**
 * Edit semantics: an empty TTL promotes the entry to permanent (`null`), a
 * number makes it short-term again.
 */
export function editTtlSeconds(days: number | null | undefined): number | null {
  return days === null || days === undefined ? null : days * DAY_SECONDS;
}

export function isTtlDaysValid(days: number | null | undefined): boolean {
  return days !== null && days !== undefined && Number.isInteger(days) && days >= TTL_MIN_DAYS && days <= TTL_MAX_DAYS;
}

/** Human-readable TTL: whole days when exact, else rounded hours (>= 1h), else raw seconds. */
export function formatTtl(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) {
    return `${seconds / DAY_SECONDS} ${i18n.t('pages.memories.ttlUnitDays')}`;
  }
  if (seconds >= 3_600) {
    return `${Math.round(seconds / 3_600)} ${i18n.t('pages.memories.ttlUnitHours')}`;
  }
  return `${seconds} ${i18n.t('pages.memories.ttlUnitSeconds')}`;
}
