/**
 * The room write path.
 *
 * Nothing here starts a run directly: a submission is admitted and held, and a
 * release seals held inputs into a queued bucket and invocation. The scheduler
 * launches that invocation like any other queued one, under the room's
 * per-chat single-consumer rule.
 *
 * Validation is deliberately small and strict. Callers speak in decimal ids
 * and request keys; a malformed value is refused before it reaches the store.
 */
import type { Orm } from '../store/store.ts';
import type { LocalAsset, LocalAssetInput, PlaygroundAssetStore } from '../capabilities/media/local-assets.ts';
import {
  PlaygroundStore,
  type ReleaseResult,
  type RetryResult,
  type RoomState,
  type RoomStatus,
  type SubmitMedia,
  type SubmitResult,
} from '../store/playground/index.ts';
import { PlaygroundError } from '../store/playground/shared.ts';

export interface PlaygroundIngressOptions {
  /** Called after a release commit; the scheduler uses it to wake up. */
  readonly onQueued?: (chatId: bigint, invocationId: bigint) => void;
  /** Local image assets of rooms; without it a room message cannot carry images. */
  readonly assets?: PlaygroundAssetStore;
}

export class PlaygroundIngress {
  readonly #store: PlaygroundStore;
  readonly #options: PlaygroundIngressOptions;
  #lastSweep = 0;

  constructor(orm: Orm, options: PlaygroundIngressOptions = {}) {
    this.#store = new PlaygroundStore(orm);
    this.#options = options;
  }

  async submit(
    chatId: bigint,
    body: {
      readonly requestKey?: unknown;
      readonly senderId?: unknown;
      readonly text?: unknown;
      readonly replyToSeq?: unknown;
      readonly assetIds?: unknown;
    },
  ): Promise<SubmitResult> {
    const requestKey = requireKey(body.requestKey, 'requestKey');
    const assetIds = requireAssetIds(body.assetIds);
    const text = body.text;
    if (typeof text !== 'string') {
      throw new PlaygroundError('input_conflict', 'text must be a string');
    }
    if (text.trim().length === 0 && assetIds.length === 0) {
      throw new PlaygroundError('input_conflict', 'text must be a non-empty string');
    }
    if (text.length > 16_384) {
      throw new PlaygroundError('input_conflict', 'text is too long');
    }
    const senderId = requireDecimal(body.senderId, 'senderId');
    const replyToSeq =
      body.replyToSeq === null || body.replyToSeq === undefined ? null : requireDecimal(body.replyToSeq, 'replyToSeq');
    // A known key is answered before its pictures are resolved: retention may
    // have removed the asset rows while the key's tombstone stays.
    const replayed = this.#store.replaySubmission(chatId, { requestKey, senderId, text, replyToSeq, assetIds });
    if (replayed !== undefined) {
      return replayed;
    }
    const media = this.#referenceAssets(chatId, assetIds);
    const result = this.#store.submit(chatId, { requestKey, senderId, text, replyToSeq, media });
    if (result.admitted) {
      this.#scheduleSweep();
    }
    return result;
  }

  release(
    chatId: bigint,
    body: { readonly releaseKey?: unknown; readonly revision?: unknown; readonly throughSeq?: unknown },
  ): ReleaseResult {
    const releaseKey = requireKey(body.releaseKey, 'releaseKey');
    const revision = requireDecimal(body.revision, 'revision');
    const throughSeq =
      body.throughSeq === null || body.throughSeq === undefined
        ? undefined
        : requireDecimal(body.throughSeq, 'throughSeq');
    const result = this.#store.release(chatId, {
      releaseKey,
      revision,
      ...(throughSeq === undefined ? {} : { throughSeq }),
    });
    if (!result.replayed && result.invocationId !== null) {
      this.#options.onQueued?.(chatId, result.invocationId);
    }
    return result;
  }

  /**
   * Stage one uploaded picture. An upload is room write traffic like a
   * submission, so it drives the sweep too: uploads that are never sent still
   * age out.
   */
  async upload(chatId: bigint, input: LocalAssetInput): Promise<LocalAsset> {
    const assets = this.#options.assets;
    if (assets === undefined) {
      throw new PlaygroundError('input_conflict', 'this room cannot accept images');
    }
    const asset = await assets.ingest(chatId, input);
    this.#scheduleSweep();
    return asset;
  }

  retry(chatId: bigint, body: { readonly releaseId?: unknown; readonly attemptKey?: unknown }): RetryResult {
    const releaseId = requireDecimal(body.releaseId, 'releaseId');
    const attemptKey = requireKey(body.attemptKey, 'attemptKey');
    const result = this.#store.retry(chatId, { releaseId, attemptKey });
    if (!result.replayed) {
      this.#options.onQueued?.(chatId, result.invocationId);
    }
    return result;
  }

  hold(chatId: bigint): RoomState {
    return this.#store.hold(chatId);
  }

  status(chatId: bigint): RoomStatus {
    return this.#store.status(chatId);
  }

  /**
   * Staged uploads that never became a message are disposable. Sweep on a slow
   * cadence from the write path so no extra timer is needed.
   */
  #scheduleSweep(): void {
    const assets = this.#options.assets;
    if (assets === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.#lastSweep < 60 * 60 * 1000) {
      return;
    }
    this.#lastSweep = now;
    void assets.sweep().catch(() => {});
  }

  /**
   * Turns previously uploaded asset ids into submission media. The room owns
   * the asset or the reference is refused: ids are never resolved across rooms,
   * and the values come from the stored row, not from the caller.
   */
  #referenceAssets(chatId: bigint, assetIds: readonly string[]): SubmitMedia[] {
    if (assetIds.length === 0) {
      return [];
    }
    const assets = this.#options.assets;
    if (assets === undefined) {
      throw new PlaygroundError('input_conflict', 'this room cannot accept images');
    }
    return assetIds.map((assetId) => {
      const asset = assets.assetFor(chatId, assetId);
      if (asset === null) {
        throw new PlaygroundError('unknown_asset', `asset ${assetId} does not belong to room ${chatId}`);
      }
      return {
        assetId: asset.id,
        sha256: asset.sha256,
        mime: asset.mime,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
      };
    });
  }
}

function requireAssetIds(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4 || value.some((item) => typeof item !== 'string')) {
    throw new PlaygroundError('input_conflict', 'assetIds must be at most four asset id strings');
  }
  return value as string[];
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new PlaygroundError('input_conflict', `${field} must be a non-empty key`);
  }
  return value;
}

/** SQLite INTEGER is a signed 64-bit value; a larger id cannot be bound. */
const MAX_ID = 9_223_372_036_854_775_807n;

function requireDecimal(value: unknown, field: string): bigint {
  // A number past 2^53 was already rounded before it got here, so it can no
  // longer name the id the caller meant.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new PlaygroundError('input_conflict', `${field} must be a decimal id`);
  }
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text) || text.length > 19 || BigInt(text) > MAX_ID) {
    throw new PlaygroundError('input_conflict', `${field} must be a decimal id`);
  }
  return BigInt(text);
}
