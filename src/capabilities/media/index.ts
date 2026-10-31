import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import { AsyncSemaphore, type KeyedSemaphore } from '../../platform/concurrency.ts';
import { configuredToolSchemaKeywords } from '../../platform/config/index.ts';
import type { CapabilityRefResolver, DirectImage, InvocationContext } from '../../platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { MediaDownloader } from './download.ts';
import { loadDirectImages, prepareImageBytes } from './image-input.ts';
import { createReadImageTool, type ReadImageSchema } from './read-image.ts';
import { analyzeStickerForIndex } from './sticker-index.ts';
import type { MediaVisionDeps, StickerAnalysis, VisionRun } from './vision-analysis.ts';

export interface StickerIndexAnalysis {
  readonly analysisId: bigint;
  readonly description: string;
  readonly metadata: StickerAnalysis;
}

export interface LocalAssetResolver {
  /** Absolute path of a stored room asset; null when the id is unknown. */
  resolve(assetId: string): { readonly path: string } | null;
}

export interface MediaServiceOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly mediaClient: MediaDownloader;
  readonly modelGate: KeyedSemaphore;
  /** Local room assets; a Playground media row may only be read through this. */
  readonly localAssets?: LocalAssetResolver;
}

export class MediaService {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #mediaClient: MediaDownloader;
  readonly #modelGate: KeyedSemaphore;
  readonly #localAssets: LocalAssetResolver | undefined;
  readonly #visionSemaphore: AsyncSemaphore;
  /** Restart-only, like the rest of the vision concurrency and budget fields. */
  readonly #visionPromptVersion: number;
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(options: MediaServiceOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#configStore = options.configStore;
    this.#mediaClient = options.mediaClient;
    this.#modelGate = options.modelGate;
    this.#localAssets = options.localAssets;
    const vision = options.configStore.current().config.vision;
    this.#visionSemaphore = new AsyncSemaphore(vision.max_concurrency);
    this.#visionPromptVersion = vision.prompt_version;
  }

  /**
   * Pins the model, its registry and the cache identity for one analysis. A
   * vision model switched while the analysis runs never changes what that
   * analysis reports, and a cache row written under one model is never read
   * under another.
   */
  #visionRun(): VisionRun | undefined {
    const snapshot = this.#configStore.current();
    const model = snapshot.visionModel;
    if (model === undefined) {
      return undefined;
    }
    return {
      models: snapshot.models,
      model,
      analysisVersion: `${model.provider}/${model.id}/prompt-${this.#visionPromptVersion}`,
      maxOutputTokens: snapshot.config.vision.max_output_tokens,
      toolSchemaKeywords: configuredToolSchemaKeywords(snapshot.config, model.provider, model.id),
    };
  }

  /**
   * One dependency view of the live service for the extracted modules: every
   * field is the service's own object, so writes there are visible here, and
   * `visionRun` reads the configuration current when it is called, not when the
   * view is built.
   */
  #deps(): MediaVisionDeps {
    return {
      store: this.#store,
      configStore: this.#configStore,
      secrets: this.#secrets,
      mediaClient: this.#mediaClient,
      localAssets: this.#localAssets,
      modelGate: this.#modelGate,
      visionSemaphore: this.#visionSemaphore,
      visionPromptVersion: this.#visionPromptVersion,
      inflight: this.#inflight,
      visionRun: () => this.#visionRun(),
    };
  }

  /**
   * Whether the live configuration names a vision model. Without one,
   * `read_image` refuses every call and background sticker indexing waits; a
   * hot switch that adds a model resumes both without a restart.
   */
  visionAvailable(): boolean {
    return this.#configStore.current().visionModel !== undefined;
  }

  /**
   * Prepares one stored media row as generation input: downloads and normalizes
   * it like the direct-image path, but addressed by media id so a caller can
   * turn a conversation-authorized media reference into image bytes. Returns
   * base64 plus the normalized mime type; the temporary file is removed.
   * Stickers are rejected: generation input is a photo or image document only.
   */
  async prepareInputImage(
    mediaId: bigint,
    signal: AbortSignal,
  ): Promise<{ readonly base64: string; readonly mime: string }> {
    return await prepareImageBytes(this.#deps(), mediaId, signal, false);
  }

  /**
   * Prepares one stored media row as raw image input for a scene: the same
   * download/normalize/temporary-file path as `prepareInputImage`, but stickers
   * are allowed so an authorized scene reference reads as the picture the
   * conversation actually saw. Read-only: it selects the media row, downloads
   * and normalizes it, and writes no analysis, audit, usage or context rows; the
   * caller decides what the current multimodal agent receives.
   */
  async prepareSceneImage(
    mediaId: bigint,
    signal: AbortSignal,
  ): Promise<{ readonly base64: string; readonly mime: string }> {
    return await prepareImageBytes(this.#deps(), mediaId, signal, true);
  }

  async loadDirectImages(images: readonly DirectImage[], signal: AbortSignal): Promise<ImageContent[]> {
    return await loadDirectImages(this.#deps(), images, signal);
  }

  createReadImageTool(
    context: InvocationContext,
    capabilities: CapabilityRefResolver,
    invocationDeadline: number,
    memoBlobs?: Parameters<typeof createReadImageTool>[4],
  ): AgentTool<typeof ReadImageSchema, { cached: boolean }> {
    return createReadImageTool(this.#deps(), context, capabilities, invocationDeadline, memoBlobs);
  }

  async analyzeStickerForIndex(stickerId: bigint, signal: AbortSignal): Promise<StickerIndexAnalysis> {
    return await analyzeStickerForIndex(this.#deps(), stickerId, signal);
  }
}
