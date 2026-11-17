/**
 * The online-retention sweep owned by the serve lifecycle: one run at startup —
 * before the Scheduler may launch work, so a first run after an upgrade can
 * absorb a large backlog without racing it — then once every 24 hours for as
 * long as the process runs. Every run reads `retention.online_days` from the
 * currently published configuration, so a reloaded value reaches the next run
 * without a restart. A run that throws is logged and the schedule keeps going;
 * the timer never keeps the process alive on its own and `stop()` cancels it on
 * shutdown and takeover. `backup` keeps its own call to the same purge.
 */
import type { RawConfig } from '../../../platform/config/index.ts';
import { type Orm, purgeExpiredData } from '../../../store/store.ts';
import { logEvent } from './support.ts';

/** The fixed cadence of the periodic cleanup. */
export const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export class RetentionCleanup {
  readonly #orm: Orm;
  readonly #config: () => RawConfig;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(orm: Orm, config: () => RawConfig, options: { readonly intervalMs?: number } = {}) {
    this.#orm = orm;
    this.#config = config;
    this.#intervalMs = options.intervalMs ?? RETENTION_CLEANUP_INTERVAL_MS;
  }

  /** Runs once now, then on the interval. A second call is a no-op. */
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.runNow();
    this.#timer = setInterval(() => this.runNow(), this.#intervalMs);
    this.#timer.unref();
  }

  /** One cleanup pass against the published configuration; never throws. */
  runNow(): void {
    const startedAt = Date.now();
    try {
      purgeExpiredData(this.#orm, this.#config());
      logEvent('retention_cleanup', { duration_ms: Date.now() - startedAt });
    } catch (error) {
      logEvent('retention_cleanup_failed', {
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
