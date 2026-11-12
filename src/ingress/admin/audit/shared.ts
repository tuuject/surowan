import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Orm } from '../../../store/store.ts';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
export const MAX_SEARCH_LENGTH = 100;
/** Payload previews are truncated so one huge transcript row cannot bloat the API response. */
export const MAX_PAYLOAD_PREVIEW_LENGTH = 2_000;
/** The same bound the Playground listings use; deeper pages are a filter's job. */
const OFFSET_PATTERN = /^(0|[1-9][0-9]{0,8})$/;
const AS_OF_ID_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const AS_OF_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The time token of an empty table: every row written later is newer. */
const EMPTY_TIME_SNAPSHOT = '1970-01-01T00:00:00.000Z';

export const num = (value: unknown): number | null => (value === null ? null : Number(value));
export const bit = (value: unknown): boolean => value === 1n;

/**
 * One page of a snapshot listing. A listing pages one frozen set of rows: the
 * rows that existed when its snapshot was taken. Rows that arrive later only
 * show up in `new_count` until the client takes a new snapshot by omitting
 * `as_of`, so moving between pages never repeats or skips a row because of an
 * insert. Edits, deletions and filter changes of snapshot rows stay live.
 */
export interface Page<T> {
  readonly items: readonly T[];
  /** Snapshot rows matching the filters. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Opaque snapshot token; send it back unchanged to keep paging the same rows. */
  readonly as_of: string;
  /** Rows matching the filters that arrived after the snapshot. */
  readonly new_count: number;
}

export interface PageWindow {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Where a listing's snapshot ends: `within` keeps the rows the snapshot holds,
 * `after` selects the rows that arrived since. Both are bound SQL fragments.
 */
export interface Snapshot {
  readonly token: string;
  readonly within: SQL;
  readonly after: SQL;
}

export interface ListQuery {
  readonly limit?: string | null;
  readonly offset?: string | null;
  readonly as_of?: string | null;
  readonly state?: string | null;
  readonly chat?: string | null;
  readonly set?: string | null;
  /** Invocation host: `telegram` or `playground`. */
  readonly host?: string | null;
  readonly search?: string | null;
  /** Exact `model_calls.model` of the invocation's agent calls. */
  readonly model?: string | null;
  /** Chat-local day for group memory. */
  readonly day?: string | null;
  readonly target?: string | null;
  /** Whole-minute/second/fraction window, resolved in the Chat or global timezone. */
  readonly at?: string | null;
  /** Inclusive lower bound; `YYYY-MM-DD[T ]HH:mm[:ss[.fff]]` with optional Z/±HH:mm. */
  readonly from?: string | null;
  /** Exclusive upper bound, same timestamp grammar as `from`. */
  readonly to?: string | null;
}

export class AdminQueryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Empty filter parameters mean "no filter"; anything else is validated by the caller. */
export function optionalFilter(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

/** Literal `%`, `_` and `\` in the writer's text never turn into wildcards. */
export function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** SQL-chunk WHERE builder for drizzle `sql` templates; binds every value. */
export function whereSql(conditions: readonly SQL[]): SQL {
  return conditions.length === 0 ? sql.empty() : sql` WHERE ${sql.join([...conditions], sql` AND `)}`;
}

export function parseWindow(query: { readonly limit?: string | null; readonly offset?: string | null }): PageWindow {
  return { limit: parseLimit(query.limit), offset: parseOffset(query.offset) };
}

export function parseOffset(value: string | null | undefined): number {
  if (value === undefined || value === null || value.length === 0) {
    return 0;
  }
  if (!OFFSET_PATTERN.test(value)) {
    throw new AdminQueryError('invalid_offset', 'offset must be a canonical non-negative decimal below 1000000000');
  }
  return Number(value);
}

/** An integer snapshot token: the largest row id when the snapshot was taken. */
export function parseAsOfId(value: string): bigint {
  if (!AS_OF_ID_PATTERN.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError('invalid_as_of', 'as_of must be the token of an earlier response');
  }
  return BigInt(value);
}

/**
 * Snapshot over an integer primary key. SQLite gives a new row a larger id
 * than every existing one, so `id <= token` is exactly the rows that existed.
 * Without `as_of` the token is the table's current largest id. `column` is
 * how the listing's own query names that key (often through an alias).
 */
export function idSnapshot(
  orm: Orm,
  key: SQLiteColumn,
  column: SQL | SQLiteColumn,
  asOf: string | null | undefined,
): Snapshot {
  const requested = optionalFilter(asOf);
  const token = requested === undefined ? (currentMax(orm, key) ?? 0n) : parseAsOfId(requested);
  const bound = BigInt(token);
  return { token: bound.toString(), within: sql`${column} <= ${bound}`, after: sql`${column} > ${bound}` };
}

/**
 * Snapshot over an ISO timestamp written when a row was created (or, for
 * Conversation Contexts, last became active). Used where the id is random and
 * cannot order arrivals. Without `as_of` the token is the newest stored time.
 */
export function timeSnapshot(
  orm: Orm,
  key: SQLiteColumn,
  column: SQL | SQLiteColumn,
  asOf: string | null | undefined,
): Snapshot {
  const requested = optionalFilter(asOf);
  const token =
    requested === undefined ? String(currentMax(orm, key) ?? EMPTY_TIME_SNAPSHOT) : parseAsOfTime(requested);
  return { token, within: sql`${column} <= ${token}`, after: sql`${column} > ${token}` };
}

function parseAsOfTime(value: string): string {
  if (!AS_OF_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new AdminQueryError('invalid_as_of', 'as_of must be the token of an earlier response');
  }
  return value;
}

function currentMax(orm: Orm, key: SQLiteColumn): bigint | number | string | null {
  const row = orm.all<{ readonly value: bigint | number | string | null }>(
    sql`SELECT max(${key}) AS value FROM ${key.table}`,
  )[0];
  return row?.value ?? null;
}

/**
 * One aggregate for both counts: `total` is the snapshot, `fresh` what arrived
 * after it. Callers select them over the filtered rows without the snapshot
 * bound, so a single scan answers both.
 */
export function snapshotCounts(snapshot: Snapshot): { readonly total: SQL<unknown>; readonly fresh: SQL<unknown> } {
  return {
    total: sql<unknown>`count(*) FILTER (WHERE ${snapshot.within})`,
    fresh: sql<unknown>`count(*) FILTER (WHERE ${snapshot.after})`,
  };
}

export function snapshotPage<T>(
  items: readonly T[],
  counts: { readonly total: unknown; readonly fresh: unknown } | undefined,
  window: PageWindow,
  snapshot: Snapshot,
): Page<T> {
  return {
    items,
    total: Number(counts?.total ?? 0),
    limit: window.limit,
    offset: window.offset,
    as_of: snapshot.token,
    new_count: Number(counts?.fresh ?? 0),
  };
}

export function parseId(value: string, label: string): bigint {
  if (!/^-?\d{1,19}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must be an integer`);
  }
  const id = BigInt(value);
  if (id < -9_223_372_036_854_775_808n || id > 9_223_372_036_854_775_807n) {
    throw new AdminQueryError(`invalid_${label}`, `${label} must fit in a signed 64-bit integer`);
  }
  return id;
}

export function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value.length === 0) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d{1,3}$/.test(value)) {
    throw new AdminQueryError('invalid_limit', 'limit must be a positive integer');
  }
  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new AdminQueryError('invalid_limit', `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

export function assertToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new AdminQueryError(`invalid_${label}`, `${label} filter is invalid`);
  }
  return value;
}
