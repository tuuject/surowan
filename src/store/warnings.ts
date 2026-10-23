import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  type EventWarningCode,
  INVOCATION_FAILURE_RATE_THRESHOLD,
  INVOCATION_FAILURE_SAMPLE_SIZE,
  LOGIN_FAILURE_THRESHOLD,
  warningDefinition,
  type WarningCode,
  type WarningSeverity,
} from '../platform/warning-catalog.ts';
import { warnings } from './schema.ts';
import type { Orm } from './store.ts';

/** Variables are a small JSON object rendered as text; bound the row and reject non-JSON values. */
export const MAX_WARNING_VARIABLES_BYTES = 8_192;
/** The running service checks expired read warnings at most hourly, well inside the allowed day. */
export const WARNING_CLEANUP_INTERVAL_MS = 60 * 60_000;

export interface EventWarning {
  readonly id: bigint;
  readonly code: WarningCode;
  readonly severity: WarningSeverity;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
  readonly read_at: string | null;
}

export interface WarningPage {
  readonly items: readonly EventWarning[];
  readonly next_cursor: string | null;
}

export interface ListWarningsOptions {
  readonly limit: number;
  readonly cursor?: bigint | undefined;
  readonly unreadOnly?: boolean;
}

export interface RecordWarningInput {
  readonly code: EventWarningCode;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly now?: Date;
}

export interface LoginWarningSink {
  loginFailed(now?: Date): void;
  loginSucceeded(): void;
}

interface WarningRow {
  readonly id: bigint;
  readonly code: string;
  readonly severity: string;
  readonly variablesJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readAt: string | null;
}

interface SampleRow {
  readonly state: string;
  readonly finished_at: string | null;
}

/**
 * Persistence and producers for event warnings. Modules call `record` (or one of
 * the built-in signal methods); unread warnings of the same code are updated in
 * place instead of duplicated. Standing warning evaluation lives in
 * `platform/warning-catalog.ts` because it has no stored state.
 */
export class WarningService implements LoginWarningSink {
  readonly #orm: Orm;
  #loginFailures = 0;
  #cleanupTimer: NodeJS.Timeout | undefined;

  constructor(orm: Orm) {
    this.#orm = orm;
  }

  record(input: RecordWarningInput): EventWarning {
    const definition = warningDefinition(input.code);
    const now = input.now ?? new Date();
    const iso = now.toISOString();
    const variablesJson = serializeVariables(input.variables);
    const id = this.#orm.transaction(
      () => {
        const existing = this.#orm
          .select({ id: warnings.id })
          .from(warnings)
          .where(and(eq(warnings.code, input.code), isNull(warnings.readAt)))
          .get();
        if (existing !== undefined) {
          this.#orm
            .update(warnings)
            .set({ severity: definition.severity, variablesJson, updatedAt: iso })
            .where(and(eq(warnings.id, existing.id), isNull(warnings.readAt)))
            .run();
          return existing.id;
        }
        const inserted = this.#orm
          .insert(warnings)
          .values({
            code: input.code,
            severity: definition.severity,
            variablesJson,
            createdAt: iso,
            updatedAt: iso,
            readAt: null,
          })
          .returning({ id: warnings.id })
          .get();
        if (inserted === undefined) {
          throw new Error('warnings insert returned no row');
        }
        return inserted.id;
      },
      { behavior: 'immediate' },
    );
    const created = this.#selectById(id);
    if (created === null) {
      throw new Error('Warning disappeared immediately after being recorded');
    }
    return created;
  }

  list(options: ListWarningsOptions): WarningPage {
    // One extra row decides whether a next page exists without a COUNT.
    const rows = this.#orm
      .select()
      .from(warnings)
      .where(
        and(
          options.cursor === undefined ? undefined : lt(warnings.id, options.cursor),
          options.unreadOnly === true ? isNull(warnings.readAt) : undefined,
        ),
      )
      .orderBy(desc(warnings.id))
      .limit(options.limit + 1)
      .all();
    const visible = rows.slice(0, options.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toEventWarning),
      next_cursor: rows.length > options.limit && last !== undefined ? last.id.toString() : null,
    };
  }

  unreadCount(): number {
    const row = this.#orm.select({ count: sql<bigint>`count(*)` }).from(warnings).where(isNull(warnings.readAt)).get();
    return Number(row?.count ?? 0n);
  }

  markRead(id: bigint, now = new Date()): EventWarning | null {
    this.#orm
      .update(warnings)
      .set({ readAt: now.toISOString() })
      .where(and(eq(warnings.id, id), isNull(warnings.readAt)))
      .run();
    return this.#selectById(id);
  }

  /** Removes every event warning; standing warnings are derived and unaffected. */
  clear(): number {
    return this.#orm.delete(warnings).run().changes;
  }

  purgeReadOlderThan(days: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return this.#orm
      .delete(warnings)
      .where(sql`${warnings.readAt} IS NOT NULL AND ${warnings.readAt} <= ${cutoff}`)
      .run().changes;
  }

  /**
   * Startup cleanup plus an hourly sweep. A warning that expires while the
   * service is down is removed by the immediate sweep on the next start.
   */
  start(options: { readonly retentionDays: () => number; readonly intervalMs?: number }): void {
    if (this.#cleanupTimer !== undefined) {
      return;
    }
    const sweep = (): void => {
      try {
        this.purgeReadOlderThan(options.retentionDays());
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'warning_cleanup_failed',
            error: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          }),
        );
      }
    };
    sweep();
    this.#cleanupTimer = setInterval(sweep, options.intervalMs ?? WARNING_CLEANUP_INTERVAL_MS);
    this.#cleanupTimer.unref();
  }

  stop(): void {
    if (this.#cleanupTimer !== undefined) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
  }

  /**
   * Samples the most recent completed/failed invocations (up to 100) after one
   * run finishes. The denominator never includes aborted, unknown or
   * budget-skipped rows: those are not runtime failures, and counting them as
   * successes would hide a genuinely broken model.
   */
  observeInvocation(now = new Date()): void {
    try {
      const sample = this.#orm.all<SampleRow>(
        sql`SELECT state, finished_at FROM invocations
            WHERE state IN ('completed', 'failed')
            ORDER BY id DESC
            LIMIT ${INVOCATION_FAILURE_SAMPLE_SIZE}`,
      );
      if (sample.length === 0) {
        return;
      }
      const failedRows = sample.filter((row) => row.state === 'failed');
      const total = sample.length;
      const failureRate = failedRows.length / total;
      if (failureRate <= INVOCATION_FAILURE_RATE_THRESHOLD) {
        return;
      }
      const lastFailedAt = failedRows
        .map((row) => row.finished_at)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1);
      this.record({
        code: 'invocation_failure_rate',
        variables: {
          failed: failedRows.length,
          total,
          failure_rate: Math.round(failureRate * 10_000) / 10_000,
          threshold: INVOCATION_FAILURE_RATE_THRESHOLD,
          sample_size: INVOCATION_FAILURE_SAMPLE_SIZE,
          last_failed_at: lastFailedAt ?? null,
        },
        now,
      });
    } catch (error) {
      this.#logRecordFailure('invocation_failure_rate', error);
    }
  }

  loginFailed(now = new Date()): void {
    this.#loginFailures += 1;
    if (this.#loginFailures < LOGIN_FAILURE_THRESHOLD) {
      return;
    }
    try {
      this.record({
        code: 'admin_login_failures',
        variables: {
          consecutive_failures: this.#loginFailures,
          threshold: LOGIN_FAILURE_THRESHOLD,
          last_failed_at: now.toISOString(),
        },
        now,
      });
    } catch (error) {
      this.#logRecordFailure('admin_login_failures', error);
    }
  }

  loginSucceeded(): void {
    this.#loginFailures = 0;
  }

  #selectById(id: bigint): EventWarning | null {
    const row = this.#orm.select().from(warnings).where(eq(warnings.id, id)).get();
    return row === undefined ? null : toEventWarning(row);
  }

  #logRecordFailure(code: EventWarningCode, error: unknown): void {
    console.error(
      JSON.stringify({
        event: 'warning_record_failed',
        code,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }),
    );
  }
}

function toEventWarning(row: WarningRow): EventWarning {
  return {
    id: row.id,
    code: row.code as WarningCode,
    severity: row.severity as WarningSeverity,
    variables: parseVariables(row.variablesJson),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    read_at: row.readAt,
  };
}

function parseVariables(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored warning variables are not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Rejects values JSON cannot represent cleanly and keeps the stored object small. */
export function serializeVariables(variables: Readonly<Record<string, unknown>>): string {
  assertJsonValue(variables, 0);
  const serialized = JSON.stringify(variables);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WARNING_VARIABLES_BYTES) {
    throw new Error(`Warning variables exceed ${MAX_WARNING_VARIABLES_BYTES} bytes`);
  }
  return serialized;
}

function assertJsonValue(value: unknown, depth: number): void {
  if (depth > 8) {
    throw new Error('Warning variables are nested too deeply');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Warning variables must be finite JSON numbers');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Warning variables must contain only plain JSON objects');
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(item, depth + 1);
    }
    return;
  }
  throw new Error('Warning variables must be JSON values');
}
