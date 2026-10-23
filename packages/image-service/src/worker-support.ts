import type { ImageService } from './assets.ts';
import type { ImageConfigHandle } from './config.ts';
import type { GenerationStatus, SafeError } from './contracts.ts';
import type { ImageDatabase } from './db.ts';
import { AppError } from './errors.ts';
import { type AttemptRow, computeStatus, firstError } from './generations.ts';
import type { ImageStore } from './image-store.ts';
import { ProviderCallError } from './openrouter.ts';
import type { ImageProviderAdapter } from './provider.ts';
import type { Redactor } from './redactor.ts';

/** Simple FIFO counting semaphore; bounds provider calls across the whole process. */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

export type WorkerLogger = { warn: (message: string) => void } | null;

export type GenerationWorkerDeps = {
  db: ImageDatabase;
  config: ImageConfigHandle;
  images: ImageService;
  store: ImageStore;
  provider: ImageProviderAdapter;
  concurrency: number;
  providerTimeoutMs: number;
  shutdownTimeoutMs?: number;
  logger?: WorkerLogger;
  redactor: Redactor;
  /**
   * Whether this process may execute one generation at all. The host supplies
   * it when it serves only part of the hosts that share the database, so a
   * standalone process never resumes work that belongs to a host it does not
   * serve. Absent means every generation may run.
   */
  executionEligibility?: (generation: { readonly id: string; readonly actorId: string }) => boolean;
};

export type ItemOutcome = { status: 'succeeded' | 'failed' | 'interrupted'; error: SafeError | null };

export const RESTART_ERROR: SafeError = {
  code: 'server_restart',
  message: '服务重启中断了该次上游调用，结果不确定',
  stage: 'interrupted',
};

/** The round was cut short while later items had no attempt yet; they were never sent. */
const INCOMPLETE_ROUND_ERROR: SafeError = {
  code: 'shutdown_incomplete',
  message: '服务中断了本轮执行，未执行的输出项不会自动重发',
  stage: 'interrupted',
};

type RoundVerdict = { status: GenerationStatus; error: SafeError | null };

/**
 * Verdict for a round from its recorded attempts and the item count it was authored
 * with. An item without an attempt was never sent upstream, so it counts as
 * interrupted: a round that is missing items can only be partial (something was
 * delivered) or interrupted, never succeeded. A round with no attempt at all stays
 * queued — nothing was sent, so a restart can resume it with no paid retry.
 */
export function roundVerdict(attempts: AttemptRow[], expectedOutputCount: number): RoundVerdict {
  if (attempts.length === 0) {
    return { status: 'queued', error: null };
  }
  const status = computeStatus(attempts);
  const covered = new Set(attempts.map((attempt) => attempt.itemIndex));
  const missingItems = Array.from({ length: expectedOutputCount }, (_, itemIndex) => itemIndex).some(
    (itemIndex) => !covered.has(itemIndex),
  );
  if (!missingItems) {
    return { status, error: status === 'succeeded' ? null : firstError(attempts) };
  }
  let incomplete: GenerationStatus = status;
  if (status === 'succeeded') {
    incomplete = 'partial';
  } else if (status === 'failed') {
    incomplete = 'interrupted';
  }
  return { status: incomplete, error: firstError(attempts) ?? INCOMPLETE_ROUND_ERROR };
}

export function safeOutcome(error: unknown): ItemOutcome {
  if (error instanceof ProviderCallError) {
    return {
      status: error.kind === 'interrupted' ? 'interrupted' : 'failed',
      error: error.toSafeError(),
    };
  }
  if (error instanceof AppError) {
    return { status: 'failed', error: error.toSafeError() };
  }
  return { status: 'failed', error: { code: 'internal_error', message: '内部错误', stage: 'storage' } };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
