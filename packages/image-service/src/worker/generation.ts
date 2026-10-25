import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { ImageService } from '../assets.ts';
import type { ImageConfigHandle } from '../config.ts';
import type { GenerationStatus, SafeError } from '../contracts.ts';
import type { ImageDatabase } from '../db.ts';
import { AppError, storageFailure } from '../errors.ts';
import type { AttemptRow, GenerationRow } from '../generations.ts';
import type { AllowedMime } from '../image-store.ts';
import { decodeBase64Image, type ImageStore, MAX_IMAGE_BYTES } from '../image-store.ts';
import type { ImageProviderAdapter, ProviderImage } from '../provider.ts';
import { type Redactor, redactWith } from '../redactor.ts';
import { generationAttempts, generations } from '../schema.ts';
import { type ItemOutcome, roundVerdict, safeOutcome, type Semaphore, type WorkerLogger } from './support.ts';

/**
 * The state one round of execution needs from the worker. `controllers`, `onFinished`,
 * `mayExecute` and `isStopping` are live references: the worker keeps mutating them
 * while a round runs, so every read must observe the current value.
 */
export type GenerationExecution = {
  readonly db: ImageDatabase;
  readonly config: ImageConfigHandle;
  readonly images: ImageService;
  readonly store: ImageStore;
  readonly provider: ImageProviderAdapter;
  readonly semaphore: Semaphore;
  readonly providerTimeoutMs: number;
  readonly logger: WorkerLogger;
  readonly redactor: Redactor;
  readonly controllers: Map<string, AbortController>;
  readonly onFinished: Set<(generationId: string, status: GenerationStatus) => void>;
  readonly mayExecute: (generation: { readonly id: string; readonly actorId: string }) => boolean;
  readonly isStopping: () => boolean;
};

export async function runGeneration(deps: GenerationExecution, generationId: string): Promise<void> {
  const row = deps.db.select().from(generations).where(eq(generations.id, generationId)).get();
  if (row === undefined || row.status !== 'queued') {
    return;
  }
  // The last gate before a paid call: a queue entry that predates an
  // eligibility decision must not start work this process may not run.
  if (!deps.mayExecute(row)) {
    return;
  }
  const now = new Date().toISOString();
  const claimed = deps.db
    .update(generations)
    .set({ status: 'running', startedAt: now, finishedAt: null, error: null })
    .where(and(eq(generations.id, generationId), eq(generations.status, 'queued')))
    .run();
  if (claimed.changes === 0) {
    return;
  }

  const outputCount = row.snapshot.authored.outputCount;
  const items = Array.from({ length: outputCount }, (_, index) => index);
  // Round-scoped credential: resolved exactly once, when the round starts, and
  // shared by every output item. A mid-round republish never swaps the key.
  let credential: string;
  try {
    credential = deps.config.credentialFor(row.snapshot.model);
  } catch (error) {
    const safe: SafeError =
      error instanceof AppError
        ? error.toSafeError()
        : { code: 'internal_error', message: '内部错误', stage: 'provider' };
    for (const itemIndex of items) {
      recordCredentialFailure(deps, row, itemIndex, safe);
    }
    finalize(deps, generationId, row.round);
    return;
  }
  await Promise.all(items.map((itemIndex) => runItem(deps, row, itemIndex, credential)));
  finalize(deps, generationId, row.round);
}

/** Records a failed attempt for an item that never reached the provider. */
function recordCredentialFailure(
  deps: GenerationExecution,
  row: GenerationRow,
  itemIndex: number,
  error: SafeError,
): void {
  const now = new Date().toISOString();
  deps.db
    .insert(generationAttempts)
    .values({
      id: randomUUID(),
      generationId: row.id,
      round: row.round,
      itemIndex,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      error,
      providerRequestId: null,
      usage: null,
      outputAssetId: null,
    })
    .onConflictDoNothing()
    .run();
}

async function runItem(
  deps: GenerationExecution,
  row: GenerationRow,
  itemIndex: number,
  credential: string,
): Promise<void> {
  if (deps.isStopping()) {
    return;
  }
  await deps.semaphore.acquire();
  const attemptId = randomUUID();
  const controller = new AbortController();
  deps.controllers.set(attemptId, controller);
  try {
    if (deps.isStopping()) {
      return;
    }
    const startedAt = new Date().toISOString();
    deps.db
      .insert(generationAttempts)
      .values({
        id: attemptId,
        generationId: row.id,
        round: row.round,
        itemIndex,
        status: 'running',
        startedAt,
        finishedAt: null,
        error: null,
        providerRequestId: null,
        usage: null,
        outputAssetId: null,
      })
      .run();
    const outcome = await executeItem(deps, row, itemIndex, credential, controller.signal);
    deps.db
      .update(generationAttempts)
      .set({
        status: outcome.status,
        finishedAt: new Date().toISOString(),
        error: outcome.error,
        providerRequestId: outcome.providerRequestId ?? null,
        usage: outcome.usage ?? null,
        outputAssetId: outcome.outputAssetId ?? null,
      })
      .where(eq(generationAttempts.id, attemptId))
      .run();
  } catch (error) {
    // Never let an unexpected failure escape without a recorded attempt.
    deps.db
      .update(generationAttempts)
      .set({
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: { code: 'internal_error', message: '内部错误', stage: 'storage' },
      })
      .where(eq(generationAttempts.id, attemptId))
      .run();
    deps.logger?.warn(`尝试记录失败：${redactWith(deps.redactor, error)}`);
  } finally {
    deps.controllers.delete(attemptId);
    deps.semaphore.release();
  }
}

async function executeItem(
  deps: GenerationExecution,
  row: GenerationRow,
  itemIndex: number,
  credential: string,
  signal: AbortSignal,
): Promise<
  ItemOutcome & {
    providerRequestId?: string | null;
    usage?: Record<string, number> | null;
    outputAssetId?: string | null;
  }
> {
  const snapshot = row.snapshot;
  try {
    const references = snapshot.imageAssets.map((asset) => {
      const { bytes } = deps.images.readContent(asset.id);
      // Persisted assets were verified by sharp against AllowedMime; the text
      // column only widens the type at rest.
      return { mime: asset.mime as AllowedMime, base64: bytes.toString('base64') };
    });
    const result = await deps.provider.generate({
      model: snapshot.model,
      credential,
      prompt: snapshot.finalPrompt,
      inputImages: references,
      aspectRatio: snapshot.authored.aspectRatio,
      resolution: snapshot.authored.resolution,
      extendedData: snapshot.authored.extendedData,
      timeoutMs: deps.providerTimeoutMs,
      signal,
    });
    const asset = await storeOutput(deps, row, itemIndex, result);
    return {
      status: 'succeeded',
      error: null,
      providerRequestId: result.providerRequestId,
      usage: result.usage,
      outputAssetId: asset.id,
    };
  } catch (error) {
    return { ...safeOutcome(error), providerRequestId: null, usage: null, outputAssetId: null };
  }
}

async function storeOutput(deps: GenerationExecution, row: GenerationRow, itemIndex: number, result: ProviderImage) {
  let bytes: Buffer;
  try {
    bytes = decodeBase64Image(result.base64);
  } catch {
    throw storageFailure('output_decode_failed', '上游返回的图像数据无法解码');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw storageFailure('output_too_large', '输出图片超过 20MiB 上限');
  }
  let verified: Awaited<ReturnType<ImageStore['verifyBytes']>>;
  try {
    verified = await deps.store.verifyBytes(bytes);
  } catch (error) {
    throw storageFailure('output_format_rejected', error instanceof AppError ? error.message : '输出图片格式不受支持');
  }
  if (result.mediaType !== null && result.mediaType !== verified.mime) {
    throw storageFailure('output_format_rejected', '上游声明的图片格式与实际内容不一致');
  }
  const stored = await deps.store.store({ bytes });
  return deps.images.persist(stored, {
    name: `${row.snapshot.model.name} 输出 ${itemIndex + 1}`,
    description: '',
    category: '',
    source: 'generation',
    generationId: row.id,
    outputIndex: itemIndex,
  });
}

function finalize(deps: GenerationExecution, generationId: string, round: number): void {
  const row = deps.db.select().from(generations).where(eq(generations.id, generationId)).get();
  if (row === undefined || row.status !== 'running') {
    return;
  }
  const attempts = attemptsForRound(deps.db, generationId, round);
  const verdict = roundVerdict(attempts, row.snapshot.authored.outputCount);
  const settled = verdict.status !== 'queued' && verdict.status !== 'running';
  deps.db
    .update(generations)
    .set({
      status: verdict.status,
      error: verdict.error,
      finishedAt: settled ? new Date().toISOString() : null,
    })
    .where(eq(generations.id, generationId))
    .run();
  if (settled) {
    for (const listener of deps.onFinished) {
      try {
        listener(generationId, verdict.status);
      } catch (error) {
        deps.logger?.warn(
          `image generation finished listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export function attemptsForRound(db: ImageDatabase, generationId: string, round: number): AttemptRow[] {
  return db
    .select()
    .from(generationAttempts)
    .where(and(eq(generationAttempts.generationId, generationId), eq(generationAttempts.round, round)))
    .orderBy(asc(generationAttempts.itemIndex))
    .all();
}
