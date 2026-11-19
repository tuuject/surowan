import type { GenerationStatus, ImageAsset } from '@surowan/image-service';
import { and, eq } from 'drizzle-orm';
import type { BusinessStore } from '../../store/store.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import { longTasks } from '../../store/schema/index.ts';
import { agentActor } from './submission.ts';
import { RECEIPT_PROMPT_PREVIEW_LENGTH, type GenerationDelivery, type SendableOutput } from './shared.ts';
import type { ImageCoreHandle } from './index.ts';

/**
 * The reconciliation half of the image bridge: a generation settles → the
 * long task that represents it completes → the scheduler delivers a receipt
 * into the conversation. Also owns the send-side projections (deliverable
 * outputs, raw asset bytes) that the delivery tools read.
 */

export interface ReconcileDeps {
  readonly core: ImageCoreHandle;
  readonly store: BusinessStore;
  readonly tasks: LongTaskService;
  /** Whether this process may execute one generation (host execution gate). */
  readonly canExecute: (generation: { readonly id: string; readonly actorId: string }) => boolean;
}

export function createReconcile(deps: ReconcileDeps) {
  const { core, store, tasks, canExecute } = deps;

  /**
   * Completion reconciliation for one generation: settles the long task that
   * represents it. Called by the core's finished listener and by `reconcile`
   * after a restart (a restart interrupts in-flight rounds without firing the
   * listener).
   */
  function reconcileOne(generationId: string): void {
    const rows = store.orm
      .select({ id: longTasks.id, conversationId: longTasks.conversationId, payloadJson: longTasks.payloadJson })
      .from(longTasks)
      .where(and(eq(longTasks.pluginId, 'image'), eq(longTasks.state, 'waiting')))
      .all();
    const row = rows.find((candidate) => generationIdOfPayload(candidate.payloadJson) === generationId);
    if (row === undefined) {
      return;
    }
    const rowGeneration = core.generations.getRow(generationId);
    if (rowGeneration === null) {
      return;
    }
    // A generation that can still run settles its own task: the worker's
    // finished listener reconciles it the moment the round ends. Completing
    // the task here would record a failure for work that has not happened yet
    // and swallow the real result, because a task settles exactly once.
    if (rowGeneration.status === 'queued' || rowGeneration.status === 'running') {
      return;
    }
    // Work belonging to a disabled host is not this process's to settle.
    if (!canExecute({ id: generationId, actorId: rowGeneration.actorId })) {
      return;
    }
    const generation = core.generations.get(generationId, agentActor(row.conversationId));
    const delivery = deliveryOf(generation);
    const scope = tasks.scoped('image', row.conversationId);
    if (delivery === null) {
      scope.fail(row.id, { generation_id: generationId, status: generation.status }, undefined, new Date());
      return;
    }
    scope.complete(row.id, delivery, undefined, new Date());
  }

  function deliveryOf(generation: {
    readonly id: string;
    readonly status: GenerationStatus;
    readonly snapshot: {
      readonly model: { readonly id: string };
      readonly authored: { readonly authoredPrompt: string };
    };
    readonly outputs: readonly ImageAsset[];
    readonly error: { readonly message: string } | null;
  }): GenerationDelivery | null {
    const outputs = generation.outputs.map(toSendable);
    if (generation.status === 'succeeded' || generation.status === 'partial') {
      if (outputs.length === 0) {
        return null;
      }
      return {
        generation_id: generation.id,
        status: generation.status,
        model_id: generation.snapshot.model.id,
        prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
        outputs,
        error: generation.error?.message ?? null,
      };
    }
    // A failed or interrupted round still completes the task: the receipt
    // carries the error so the conversation learns the outcome instead of
    // waiting forever.
    return {
      generation_id: generation.id,
      status: generation.status,
      model_id: generation.snapshot.model.id,
      prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
      outputs,
      error: generation.error?.message ?? '生成失败',
    };
  }

  function toSendable(asset: ImageAsset): SendableOutput {
    return { asset_id: asset.id, file_name: asset.name, mime: asset.mime };
  }

  /**
   * Deliverable outputs of one generation, authorized only when the generation
   * belongs to the asking conversation. `undefined` = not found or foreign;
   * an empty array means it settled without outputs (failed/interrupted).
   */
  function sendableOutputs(generationId: string, conversationId: bigint): readonly SendableOutput[] | undefined {
    // The authorization rule is explicit: a generation belongs to the
    // conversation whose agent actor submitted it. Privileged actors would
    // bypass scope checks inside get(), so the binding is checked here first.
    const row = core.generations.getRow(generationId);
    if (row === null || row.actorId !== `agent:${conversationId.toString()}`) {
      return undefined;
    }
    return core.generations.get(generationId, agentActor(conversationId)).outputs.map(toSendable);
  }

  /** Missing output files must fail delivery, not silently shrink the picture set. */
  function assetContent(assetId: string): { readonly bytes: Buffer; readonly mime: string } {
    const { asset, bytes } = core.images.readContent(assetId);
    return { bytes, mime: asset.mime };
  }

  /** Reconciles every waiting image task after a restart. */
  function reconcile(): void {
    const rows = store.orm
      .select({ id: longTasks.id, conversationId: longTasks.conversationId, payloadJson: longTasks.payloadJson })
      .from(longTasks)
      .where(and(eq(longTasks.pluginId, 'image'), eq(longTasks.state, 'waiting')))
      .all();
    for (const row of rows) {
      const generationId = generationIdOfPayload(row.payloadJson);
      if (generationId === undefined) {
        tasks
          .scoped('image', row.conversationId)
          .fail(row.id, { error: 'image task payload is unreadable' }, undefined, new Date());
        continue;
      }
      reconcileOne(generationId);
    }
  }

  return { reconcileOne, sendableOutputs, assetContent, reconcile };
}

/** The generation id a stored image-task payload names, when it is readable. */
function generationIdOfPayload(payloadJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || !('generation_id' in parsed)) {
    return undefined;
  }
  const value = parsed.generation_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
