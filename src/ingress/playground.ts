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
import {
  LocalAssetRejected,
  type LocalAssetInput,
  type PlaygroundAssetStore,
} from '../capabilities/media/local-assets.ts';
import {
  PlaygroundError,
  PlaygroundStore,
  type ReleaseResult,
  type RetryResult,
  type RoomState,
  type RoomStatus,
  type SubmitMedia,
  type SubmitResult,
} from '../store/playground.ts';

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
      readonly attachments?: unknown;
    },
  ): Promise<SubmitResult> {
    const requestKey = requireKey(body.requestKey, 'requestKey');
    const attachments = requireAttachments(body.attachments);
    const text = body.text;
    if (typeof text !== 'string') {
      throw new PlaygroundError('input_conflict', 'text must be a string');
    }
    if (text.trim().length === 0 && attachments.length === 0) {
      throw new PlaygroundError('input_conflict', 'text must be a non-empty string');
    }
    if (text.length > 16_384) {
      throw new PlaygroundError('input_conflict', 'text is too long');
    }
    const senderId = requireDecimal(body.senderId, 'senderId');
    const replyToSeq =
      body.replyToSeq === null || body.replyToSeq === undefined ? null : requireDecimal(body.replyToSeq, 'replyToSeq');
    const media = await this.#ingest(chatId, attachments);
    const result = this.#store.submit(chatId, { requestKey, senderId, text, replyToSeq, media });
    if (result.admitted) {
      this.#scheduleSweep();
    }
    return result;
  }

  release(chatId: bigint, body: { readonly releaseKey?: unknown; readonly revision?: unknown }): ReleaseResult {
    const releaseKey = requireKey(body.releaseKey, 'releaseKey');
    const revision = requireDecimal(body.revision, 'revision');
    const result = this.#store.release(chatId, { releaseKey, revision });
    if (!result.replayed && result.invocationId !== null) {
      this.#options.onQueued?.(chatId, result.invocationId);
    }
    return result;
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

  async #ingest(chatId: bigint, attachments: readonly LocalAssetInput[]): Promise<SubmitMedia[]> {
    if (attachments.length === 0) {
      return [];
    }
    const assets = this.#options.assets;
    if (assets === undefined) {
      throw new PlaygroundError('input_conflict', 'this room cannot accept images');
    }
    const media: SubmitMedia[] = [];
    for (const attachment of attachments) {
      try {
        const asset = await assets.ingest(chatId, attachment);
        media.push({
          assetId: asset.id,
          sha256: asset.sha256,
          mime: asset.mime,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
        });
      } catch (error) {
        if (error instanceof LocalAssetRejected) {
          throw new PlaygroundError('input_conflict', error.message);
        }
        throw error;
      }
    }
    return media;
  }
}

function requireAttachments(value: unknown): LocalAssetInput[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw new PlaygroundError('input_conflict', 'attachments must be at most four images');
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new PlaygroundError('input_conflict', `attachments[${index}] is not an image`);
    }
    const { bytes, mime, name } = item as { bytes?: unknown; mime?: unknown; name?: unknown };
    if (!(bytes instanceof Uint8Array) || typeof mime !== 'string') {
      throw new PlaygroundError('input_conflict', `attachments[${index}] needs image bytes and a MIME type`);
    }
    return { bytes, declaredMime: mime, ...(typeof name === 'string' ? { name } : {}) };
  });
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new PlaygroundError('input_conflict', `${field} must be a non-empty key`);
  }
  return value;
}

function requireDecimal(value: unknown, field: string): bigint {
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text) || text.length > 20) {
    throw new PlaygroundError('input_conflict', `${field} must be a decimal id`);
  }
  return BigInt(text);
}
