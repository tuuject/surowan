import { type SQL, sql } from 'drizzle-orm';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
export const MAX_SEARCH_LENGTH = 100;
/** Payload previews are truncated so one huge transcript row cannot bloat the API response. */
export const MAX_PAYLOAD_PREVIEW_LENGTH = 2_000;

export const num = (value: unknown): number | null => (value === null ? null : Number(value));
export const bit = (value: unknown): boolean => value === 1n;

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ListQuery {
  readonly limit?: string | null;
  readonly cursor?: string | null;
  readonly state?: string | null;
  readonly chat?: string | null;
  readonly set?: string | null;
  /** Invocation host: `telegram` or `playground`. */
  readonly host?: string | null;
  readonly search?: string | null;
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

export function page<Row extends { readonly id: bigint | string }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    next_cursor: rows.length > limit && last !== undefined ? last.id.toString() : null,
  };
}

/** SQL-chunk WHERE builder for drizzle `sql` templates; binds every value. */
export function whereSql(conditions: readonly SQL[]): SQL {
  return conditions.length === 0 ? sql.empty() : sql` WHERE ${sql.join([...conditions], sql` AND `)}`;
}

export function appendCursor(conditions: SQL[], column: SQL, cursor: string | null | undefined): void {
  if (cursor === undefined || cursor === null || cursor.length === 0) {
    return;
  }
  conditions.push(sql`${column} < ${parseId(cursor, 'cursor')}`);
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
