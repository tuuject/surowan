import { usageError } from '../errors.ts';
import {
  DECIMAL_PATTERN,
  MAX_PAGE_LIMIT,
  MAX_SEARCH_LENGTH,
  MAX_SIGNED_64,
  MIN_SIGNED_64,
  MONTH_DAYS,
  SIGNED_DECIMAL_PATTERN,
  STATE_PATTERN,
  TIME_PATTERN,
} from './spec.ts';
import type { ConfigSource, MediaVariant } from './types.ts';

export function parseSource(text: string | undefined): ConfigSource | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text !== 'active' && text !== 'file') {
    throw usageError('invalid_source', 'source must be active or file');
  }
  return text;
}

export function parseVariant(text: string | undefined): MediaVariant {
  if (text === undefined || text === 'original') {
    return 'original';
  }
  if (text !== 'preview') {
    throw usageError('invalid_variant', 'variant must be original or preview');
  }
  return text;
}

export function parseLimit(text: string): number {
  if (!DECIMAL_PATTERN.test(text)) {
    throw usageError('invalid_limit', 'limit must be a decimal integer');
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw usageError('invalid_limit', `limit must be between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

export function parseSearch(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_SEARCH_LENGTH) {
    throw usageError('invalid_search', `search must be 1 to ${MAX_SEARCH_LENGTH} characters`);
  }
  return text;
}

export function parseTimeFilter(text: string | undefined, label: TimeLabel): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (parseTimeValue(text) === undefined) {
    throw usageError(
      `invalid_${label}`,
      `${label} must be a valid date-time: YYYY-MM-DD[ |T]HH:mm[:ss[.1-3 digits]][Z|±HH:mm]`,
    );
  }
  return text;
}

type TimeLabel = 'at' | 'from' | 'to';

interface ParsedTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  /** Minutes east of UTC; undefined when the value carries no explicit offset. */
  readonly offsetMinutes: number | undefined;
}

function parseTimeValue(text: string): ParsedTime | undefined {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, offsetText] =
    TIME_PATTERN.exec(text) ?? [];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined
  ) {
    return undefined;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const offsetMinutes = offsetText === undefined ? undefined : parseOffsetMinutes(offsetText);
  if (offsetText !== undefined && offsetMinutes === undefined) {
    return undefined;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: fractionText === undefined ? 0 : Number(fractionText.padEnd(3, '0')),
    offsetMinutes,
  };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_DAYS[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function parseOffsetMinutes(text: string): number | undefined {
  if (text === 'Z') {
    return 0;
  }
  const hours = Number(text.slice(1, 3));
  const minutes = Number(text.slice(4, 6));
  // The Admin API accepts real zone offsets only: -14:00 through +14:00.
  if (hours > 14 || minutes > 59 || hours * 60 + minutes > 14 * 60) {
    return undefined;
  }
  return (text.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Two values are only comparable here when both carry an explicit offset. A
 * value without one is interpreted by the server against the active chat
 * timezone (or the global default), so the CLI must not guess an order for it.
 * The server requires `from < to`; an empty or inverted range is rejected by
 * both layers with the same code.
 */
export function validateTimeRange(fromText: string | undefined, toText: string | undefined): void {
  if (fromText === undefined || toText === undefined) {
    return;
  }
  const from = parseTimeValue(fromText);
  const to = parseTimeValue(toText);
  if (from === undefined || to === undefined) {
    return;
  }
  if (from.offsetMinutes === undefined || to.offsetMinutes === undefined) {
    return;
  }
  if (timeToEpochMs(to) <= timeToEpochMs(from)) {
    throw usageError('invalid_time_range', '--from must be earlier than --to when both carry an explicit offset');
  }
}

function timeToEpochMs(value: ParsedTime): number {
  const date = new Date(0);
  // setUTCFullYear keeps four-digit years (including years below 100) exact,
  // unlike the Date constructor's 1900-based two-digit year handling.
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, value.millisecond);
  return date.getTime() - (value.offsetMinutes ?? 0) * 60_000;
}

export function parseBeforeSend(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!DECIMAL_PATTERN.test(text)) {
    throw usageError('invalid_before_send', 'before-send must be a positive signed 64-bit decimal integer');
  }
  const value = BigInt(text);
  if (value < 1n || value > MAX_SIGNED_64) {
    throw usageError('invalid_before_send', 'before-send must be a positive signed 64-bit decimal integer');
  }
  // The Admin API compares the canonical decimal form, so `0042` addresses `42`.
  return value.toString();
}

export function parseDecimalId(text: string, label: 'id' | 'cursor' | 'chat', allowNegative: boolean): string {
  const pattern = allowNegative ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(text)) {
    throw usageError(`invalid_${label}`, `${label} must be a decimal integer`);
  }
  const value = BigInt(text);
  if (value > MAX_SIGNED_64 || value < MIN_SIGNED_64) {
    throw usageError(`invalid_${label}`, `${label} is out of signed 64-bit range`);
  }
  // The Admin API parses ids as signed 64-bit integers and echoes them back in
  // canonical decimal (`42`, not `042`), so every caller must address and
  // compare ids in that same form.
  return value.toString();
}

export function parseState(text: string): string {
  if (!STATE_PATTERN.test(text)) {
    throw usageError('invalid_state', 'state filter is invalid');
  }
  return text;
}
