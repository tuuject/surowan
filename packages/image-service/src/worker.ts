import { and, asc, eq } from 'drizzle-orm';
import type { ImageService } from './assets.ts';
import type { ImageConfigHandle } from './config.ts';
import type { GenerationStatus } from './contracts.ts';
import type { ImageDatabase } from './db.ts';
import type { ImageStore } from './image-store.ts';
import type { ImageProviderAdapter } from './provider.ts';
import type { Redactor } from './redactor.ts';
import { redactWith } from './redactor.ts';
import { generationAttempts, generations } from './schema.ts';
import { attemptsForRound, type GenerationExecution, runGeneration } from './worker-generation.ts';
import {
  delay,
  type GenerationWorkerDeps,
  RESTART_ERROR,
  roundVerdict,
  Semaphore,
  type WorkerLogger,
} from './worker-support.ts';

/**
 * Durable, bounded executor: one upstream call per output item per round, a finite
 * global concurrency, no implicit retries, and honest recovery after a restart.
 * A round resolves its credential exactly once, when execution starts; all items
 * share that value even if the configuration is republished mid-round.
 */
export class GenerationWorker {
  private readonly db: ImageDatabase;
  private readonly config: ImageConfigHandle;
  private readonly images: ImageService;
  private readonly store: ImageStore;
  private readonly provider: ImageProviderAdapter;
  private readonly semaphore: Semaphore;
  private readonly providerTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: WorkerLogger;
  private readonly redactor: Redactor;
  private readonly executionEligibility: GenerationWorkerDeps['executionEligibility'];
  /** Explicit state for the round pipeline in `worker-generation.ts`; mutable members stay live references. */
  private readonly pipeline: GenerationExecution;
  private queue: string[] = [];
  private queued = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private pumping = false;
  private stopping = false;
  private started = false;
  private unsubConfig: (() => void) | null = null;
  /**
   * Terminal-state listeners, fired once per `finalize` that actually settles a
   * generation (succeeded / partial / failed / interrupted). Hosts use this to
   * reconcile delivery with their own task bookkeeping; the core itself never
   * delivers anything.
   */
  readonly onFinished = new Set<(generationId: string, status: GenerationStatus) => void>();

  constructor(deps: GenerationWorkerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.images = deps.images;
    this.store = deps.store;
    this.provider = deps.provider;
    this.semaphore = new Semaphore(deps.concurrency);
    this.providerTimeoutMs = deps.providerTimeoutMs;
    this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 5000;
    this.logger = deps.logger ?? null;
    this.redactor = deps.redactor;
    this.executionEligibility = deps.executionEligibility;
    this.pipeline = {
      db: this.db,
      config: this.config,
      images: this.images,
      store: this.store,
      provider: this.provider,
      semaphore: this.semaphore,
      providerTimeoutMs: this.providerTimeoutMs,
      logger: this.logger,
      redactor: this.redactor,
      controllers: this.controllers,
      onFinished: this.onFinished,
      mayExecute: (generation) => this.mayExecute(generation),
      isStopping: () => this.stopping,
    };
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Recovery then drain: queued work resumes, running work is recorded as interrupted. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    // Wake-up is purely event-driven: the config store notifies every publish, and
    // only a publish of a usable snapshot can make queued work runnable.
    this.unsubConfig = this.config.onChange(() => {
      this.wake();
    });
    this.recoverInterrupted();
    const pending = this.db
      .select({ id: generations.id, actorId: generations.actorId })
      .from(generations)
      .where(eq(generations.status, 'queued'))
      .orderBy(asc(generations.createdAt))
      .all();
    for (const row of pending) {
      if (!this.mayExecute(row)) {
        continue;
      }
      this.enqueue(row.id);
    }
  }

  enqueue(generationId: string): void {
    if (this.stopping || !this.started) {
      return;
    }
    if (this.queued.has(generationId)) {
      return;
    }
    const row = this.db
      .select({ id: generations.id, actorId: generations.actorId })
      .from(generations)
      .where(eq(generations.id, generationId))
      .get();
    if (row === undefined || !this.mayExecute(row)) {
      return;
    }
    this.queued.add(generationId);
    this.queue.push(generationId);
    void this.pump();
  }

  /** Aborts in-flight calls, waits a bounded time for their attempts to be recorded. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    this.unsubConfig?.();
    this.unsubConfig = null;
    this.queue = [];
    this.queued.clear();
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    const deadline = Date.now() + this.shutdownTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.all([...this.inFlight]), delay(25)]);
    }
    if (this.inFlight.size > 0) {
      this.logger?.warn('关闭超时：仍有上游调用未收尾，已标记为中断');
    }
  }

  private recoverInterrupted(): void {
    const runningAttempts = this.db
      .select()
      .from(generationAttempts)
      .where(eq(generationAttempts.status, 'running'))
      .all();
    const now = new Date().toISOString();
    const affected = new Set<string>();
    for (const attempt of runningAttempts) {
      affected.add(attempt.generationId);
    }
    // Recompute every generation that claims to be running: attempts that were
    // in flight become interrupted, and a round with no attempt at all (crash or
    // shutdown before the call was made) returns to queued so it can be resumed.
    // A round that already has attempts but is missing items stays partial or
    // interrupted: those items were never sent, so they are not a success.
    const claimed = this.db
      .select({ id: generations.id })
      .from(generations)
      .where(eq(generations.status, 'running'))
      .all();
    for (const row of claimed) {
      affected.add(row.id);
    }

    for (const generationId of affected) {
      const row = this.db.select().from(generations).where(eq(generations.id, generationId)).get();
      if (row === undefined) {
        continue;
      }
      // A generation this process may not execute keeps its previous state: the
      // process that serves its host recovers it then. Rewriting it here would
      // turn another host's in-flight work into a fabricated outcome.
      if (!this.mayExecute(row)) {
        continue;
      }
      this.db
        .update(generationAttempts)
        .set({ status: 'interrupted', finishedAt: now, error: RESTART_ERROR })
        .where(and(eq(generationAttempts.generationId, generationId), eq(generationAttempts.status, 'running')))
        .run();
      const attempts = attemptsForRound(this.db, generationId, row.round);
      const verdict = roundVerdict(attempts, row.snapshot.authored.outputCount);
      this.db
        .update(generations)
        .set({
          status: verdict.status,
          error: verdict.error,
          finishedAt: verdict.status === 'queued' || verdict.status === 'running' ? null : now,
        })
        .where(eq(generations.id, generationId))
        .run();
    }
  }

  /** Whether this process is allowed to execute one generation. */
  private mayExecute(generation: { readonly id: string; readonly actorId: string }): boolean {
    return this.executionEligibility?.(generation) ?? true;
  }

  /** Coalesced wake-up for publish events; pump() itself is re-entrancy safe. */
  private wake(): void {
    if (this.stopping || !this.started) {
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.stopping) {
        // No usable config snapshot means a queued generation cannot be attempted at
        // all: claiming it would record an attempt that failed before any provider
        // call, which is not an execution outcome and must not force a manual paid
        // retry. The generation stays queued in SQLite and in this queue; start()
        // subscribes to publishes above, so the next valid publish resumes it.
        // Nothing polls while the configuration is invalid.
        if (!this.config.hasValidConfig()) {
          break;
        }
        const next = this.queue.shift();
        if (next === undefined) {
          break;
        }
        this.queued.delete(next);
        const task = this.runGeneration(next).catch((error: unknown) => {
          this.logger?.warn(`生成任务执行异常：${redactWith(this.redactor, error)}`);
        });
        this.inFlight.add(task);
        void task.finally(() => {
          this.inFlight.delete(task);
        });
        // Phase 1 throughput simplification: generations are drained one at a time;
        // parallelism lives inside a round, where items share the bounded semaphore.
        await task;
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runGeneration(generationId: string): Promise<void> {
    await runGeneration(this.pipeline, generationId);
  }
}
