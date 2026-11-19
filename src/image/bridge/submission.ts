import { type GenerationActor, generationCreateSchema, scanReferences } from '@surowan/image-service';
import { and, eq, sql } from 'drizzle-orm';
import type { BusinessStore } from '../../store/store.ts';
import { type LongTaskService, TaskQuotaError } from '../../store/long-tasks/index.ts';
import { longTasks } from '../../store/schema/index.ts';
import type { ImageCoreHandle } from './index.ts';
import { MAX_PER_INVOCATION, RECEIPT_PROMPT_PREVIEW_LENGTH } from './shared.ts';

/**
 * The submission half of the image bridge: media-to-asset input translation,
 * the per-invocation quota, and the idempotent submit that creates the
 * generation row and its long task. Everything that would spend money is
 * refused before anything is created — including a second promotion check
 * taken after the input conversion awaits, immediately before the synchronous
 * create that owns the paid call.
 */

/** Hard cap on generation input images accepted from one tool call. */
const MAX_INPUT_REFS = 16;

export interface SubmitParams {
  readonly conversationId: bigint;
  /** Null outside a live invocation (tests, reconciliation): quota is skipped. */
  readonly invocationId: bigint | null;
  readonly toolCallId: string;
  readonly authoredPrompt: string;
  readonly modelId: string | undefined;
  readonly aspectRatio: string | undefined;
  readonly resolution: string | undefined;
  readonly outputCount: number | undefined;
  /** Conversation-authorized media references (img_…), resolved by the caller. */
  readonly inputMediaIds: readonly bigint[];
  /**
   * Library asset ids (`search_image_assets` results) used as reference images.
   * The assets are global, so promotion is re-checked here on every use: an id
   * that is not agent-visible or was archived since the search is refused
   * before anything is created or billed.
   */
  readonly libraryAssetIds: readonly string[];
  readonly extendedData: Record<string, unknown> | undefined;
}

export interface SubmitResult {
  readonly generationId: string;
  readonly replayed: boolean;
  readonly modelId: string;
  readonly outputCount: number;
}

/** Actor identity for agent-submitted generations; binds results to one conversation. */
export function agentActor(conversationId: bigint): GenerationActor {
  return {
    id: `agent:${conversationId.toString()}`,
    name: 'agent',
    source: 'agent',
    scopes: [],
    privileged: true,
  };
}

/**
 * A library asset the agent reached (explicit list or inline `{{image:…}}`) is
 * not usable: unknown, not promoted, or archived since the search. The tool
 * audits the rejection; the submit path throws this before creating anything.
 */
export class AgentAssetUnavailableError extends Error {
  readonly code = 'image_asset_unauthorized';

  constructor(id: string) {
    super(`library image asset ${id} is not available to the agent`);
    this.name = 'AgentAssetUnavailableError';
  }
}

/**
 * Every library asset the agent reaches through one submit: the explicit ids
 * plus the inline `{{image:…}}` references of the prompt. Malformed reference
 * syntax is not diagnosed here — the submission resolve reports it with its
 * own error code — this only yields the ids that must pass the promotion check.
 */
function agentReachedAssetIds(authoredPrompt: string, libraryAssetIds: readonly string[]): string[] {
  let inline: string[] = [];
  try {
    inline = scanReferences(authoredPrompt)
      .filter((reference) => reference.kind === 'image')
      .map((reference) => reference.id);
  } catch {
    inline = [];
  }
  return [...new Set([...libraryAssetIds, ...inline])];
}

export interface SubmissionDeps {
  readonly core: ImageCoreHandle;
  readonly store: BusinessStore;
  readonly tasks: LongTaskService;
  /** Whether the conversation may submit new generations (host opt-in included). */
  readonly enabledFor: (conversationId: bigint) => boolean;
  /** Prepares a stored media row (conversation media) as generation input. */
  readonly prepareInputImage: (
    mediaId: bigint,
    signal: AbortSignal,
  ) => Promise<{ readonly base64: string; readonly mime: string }>;
}

export function createSubmission(deps: SubmissionDeps) {
  const { core, store, tasks, enabledFor, prepareInputImage } = deps;
  // A media row re-used as input within this process resolves to the same
  // asset, so repeated generations do not copy the same source image again.
  const inputAssetCache = new Map<bigint, string>();

  /**
   * Whether the invocation that would own a new generation already reached its
   * per-invocation quota. The task create re-checks inside its transaction, but
   * this must be decided before the core creates (and enqueues) a generation:
   * an orphaned generation would start a paid call even though the tool call
   * was refused. Tools of one invocation run sequentially, so the count cannot
   * change between this check and the create it guards.
   */
  function thisInvocationAtQuota(invocationId: bigint): boolean {
    const used =
      store.orm
        .select({ count: sql<bigint>`count(*)` })
        .from(longTasks)
        .where(and(eq(longTasks.pluginId, 'image'), eq(longTasks.createdByInvocationId, invocationId)))
        .get()?.count ?? 0n;
    return used >= BigInt(MAX_PER_INVOCATION);
  }

  /** Resolves one media row to a core input asset, reusing prior conversions. */
  async function inputAssetId(mediaId: bigint, signal: AbortSignal): Promise<string> {
    const cached = inputAssetCache.get(mediaId);
    if (cached !== undefined) {
      const existing = core.images.get(cached);
      if (existing !== null && existing.deletedAt === null) {
        return cached;
      }
      inputAssetCache.delete(mediaId);
    }
    const { base64, mime } = await prepareInputImage(mediaId, signal);
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
      throw new Error(`Media type ${mime} is not supported as generation input`);
    }
    const asset = await core.images.create({
      name: `输入图 media-${mediaId.toString()}`,
      base64,
      mime,
      description: '',
      category: '',
      source: 'upload',
    });
    inputAssetCache.set(mediaId, asset.id);
    return asset.id;
  }

  async function submit(
    params: SubmitParams,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SubmitResult> {
    // Everything that would spend money is refused before anything is created:
    // no generation row, no long task, no converted input asset, no file.
    if (!enabledFor(params.conversationId)) {
      throw new Error('image generation is disabled');
    }
    if (params.inputMediaIds.length + params.libraryAssetIds.length > MAX_INPUT_REFS) {
      throw new Error(`at most ${MAX_INPUT_REFS} input images are accepted`);
    }
    // The tool pre-checks promotion, but the assets are global and an admin may
    // archive or demote one between the search and this submit, so every
    // reached id is re-checked here: the fast refusal before any await.
    for (const id of agentReachedAssetIds(params.authoredPrompt, params.libraryAssetIds)) {
      if (core.images.getAgentVisible(id) === null) {
        throw new AgentAssetUnavailableError(id);
      }
    }
    const actor = agentActor(params.conversationId);
    const idempotencyKey = `tool:${params.toolCallId}`;
    // A replay of an accepted call returns its generation without creating
    // anything, so only a new key is metered against the invocation's quota.
    if (
      params.invocationId !== null &&
      !core.generations.createKeyUsed(actor, idempotencyKey) &&
      thisInvocationAtQuota(params.invocationId)
    ) {
      throw new TaskQuotaError();
    }
    const inputAssetIds: string[] = [];
    for (const mediaId of params.inputMediaIds) {
      inputAssetIds.push(await inputAssetId(mediaId, signal));
    }
    // Preparing inputs awaits, and the switch may close meanwhile. Only a
    // generation created before it closed is accepted work; this one is not yet.
    if (inputAssetIds.length > 0 && !enabledFor(params.conversationId)) {
      throw new Error('image generation is disabled');
    }
    inputAssetIds.push(...params.libraryAssetIds);
    // The conversion awaits while an admin may demote or archive a promoted
    // asset; the early look above refuses fast, but this second look — taken
    // immediately before the synchronous create that owns the paid call — is
    // the gate that decides.
    for (const id of agentReachedAssetIds(params.authoredPrompt, params.libraryAssetIds)) {
      if (core.images.getAgentVisible(id) === null) {
        throw new AgentAssetUnavailableError(id);
      }
    }

    const parsed = generationCreateSchema.parse({
      authoredPrompt: params.authoredPrompt,
      modelId: params.modelId ?? singleModelId(),
      ...(params.aspectRatio === undefined ? {} : { aspectRatio: params.aspectRatio }),
      ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
      ...(params.outputCount === undefined ? {} : { outputCount: params.outputCount }),
      inputImages: inputAssetIds,
      ...(params.extendedData === undefined ? {} : { extendedData: params.extendedData }),
    });
    const { generation, replayed } = core.generations.create(parsed, actor, idempotencyKey);

    if (!replayed) {
      tasks.taskScope('image', params.conversationId, params.invocationId).create(
        {
          payload: {
            generation_id: generation.id,
            model_id: generation.snapshot.model.id,
            prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
            output_count: generation.snapshot.authored.outputCount,
          },
          ...(params.invocationId === null ? {} : { maxPerInvocation: MAX_PER_INVOCATION }),
        },
        new Date(),
      );
    }
    return {
      generationId: generation.id,
      replayed,
      modelId: generation.snapshot.model.id,
      outputCount: generation.snapshot.authored.outputCount,
    };
  }

  function singleModelId(): string {
    const snapshot = core.config.current();
    const models = snapshot.models;
    if (models.length !== 1) {
      throw new Error(
        models.length === 0
          ? 'no image models are configured'
          : `multiple image models are configured (${models.map((model) => model.id).join(', ')}); model_id is required`,
      );
    }
    return models[0]?.id ?? '';
  }

  return { submit };
}
