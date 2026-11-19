/**
 * Chat-local calendar days for group memory.
 *
 * Memories are organized by the Chat's own date, so both the sleeping worker and
 * the recall tool resolve `YYYY-MM-DD` in the configured IANA timezone. Day
 * boundaries are found by binary search over instants rather than by adding 24
 * hours, which keeps DST days (23 or 25 hours) and odd offsets correct. The host
 * machine's timezone is never consulted.
 */

import { THIRTY_HOUR_DAY_START_HOUR, type ThirtyHourClock } from './index.ts';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Any real zone offset fits inside ±14h; the search brackets 18h either side. */
const SEARCH_RADIUS_MILLISECONDS = 18 * 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, cached);
  }
  return cached;
}

function localDayAt(instantMs: number, timezone: string): string {
  const parts = formatter(timezone).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** The Chat-local date of one instant. */
export function chatLocalDay(iso: string, timezone: string): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    throw new Error(`Invalid timestamp: ${iso}`);
  }
  return localDayAt(instant, timezone);
}

/** Validates a `YYYY-MM-DD` calendar date and returns it unchanged. */
export function parseDay(day: string): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    throw new Error(`Invalid day: ${day}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) {
    throw new Error(`Invalid day: ${day}`);
  }
  return day;
}

/** The next calendar day, independent of time zones. */
export function nextDay(day: string): string {
  const match = DAY_PATTERN.exec(parseDay(day));
  if (match === null) {
    throw new Error(`Invalid day: ${day}`);
  }
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

/** The previous calendar day, independent of time zones. */
export function previousDay(day: string): string {
  const match = DAY_PATTERN.exec(parseDay(day));
  if (match === null) {
    throw new Error(`Invalid day: ${day}`);
  }
  const previous = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return previous.toISOString().slice(0, 10);
}

/**
 * First instant whose Chat-local date is `day` or later, found by binary search.
 * The local date is monotonic, so this always converges even across a DST gap at
 * midnight.
 */
function startOfDayInstant(day: string, timezone: string): number {
  const match = DAY_PATTERN.exec(parseDay(day));
  if (match === null) {
    throw new Error(`Invalid day: ${day}`);
  }
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let low = utcMidnight - SEARCH_RADIUS_MILLISECONDS;
  let high = utcMidnight + SEARCH_RADIUS_MILLISECONDS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDayAt(middle, timezone) >= day) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/** Half-open UTC window `[start, end)` covering one Chat-local day. */
export function localDayWindow(day: string, timezone: string): { readonly start: string; readonly end: string } {
  const start = startOfDayInstant(day, timezone);
  const end = startOfDayInstant(nextDay(day), timezone);
  if (end <= start) {
    throw new Error(`Day ${day} has no duration in timezone ${timezone}`);
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function hourFormatter(timezone: string): Intl.DateTimeFormat {
  let cached = hourFormatters.get(timezone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
    hourFormatters.set(timezone, cached);
  }
  return cached;
}

/**
 * First instant of `day` whose Chat-local hour is `hour` or later. Searched
 * inside the local day rather than added to midnight, because a DST jump before
 * that hour moves it by the jump. Within one local day the hour only decreases
 * during a fall-back repeat, which no real zone places across 06:00.
 */
function localHourInstant(day: string, hour: number, timezone: string): number {
  let low = startOfDayInstant(day, timezone);
  let high = startOfDayInstant(nextDay(day), timezone);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(hourFormatter(timezone).format(new Date(middle))) >= hour) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * Half-open UTC window `[start, end)` a dated group-memory search covers. Off,
 * it is the calendar day. A 30-hour day runs on to 06:00 of the next date, the
 * way Japanese broadcasting lists a 26:00 show under the previous day; it starts
 * at 06:00 (`non_overlapping`, so consecutive dates never share an hour) or at
 * midnight (`overlapping`, so the small hours also stay with their own date).
 */
export function searchDayWindow(
  day: string,
  clock: ThirtyHourClock,
  timezone: string,
): { readonly start: string; readonly end: string } {
  if (clock === 'off') {
    return localDayWindow(day, timezone);
  }
  const start =
    clock === 'overlapping'
      ? startOfDayInstant(day, timezone)
      : localHourInstant(day, THIRTY_HOUR_DAY_START_HOUR, timezone);
  const end = localHourInstant(nextDay(day), THIRTY_HOUR_DAY_START_HOUR, timezone);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
