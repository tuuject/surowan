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
  PlaygroundError,
  PlaygroundStore,
  type ReleaseResult,
  type RetryResult,
  type RoomState,
  type RoomStatus,
  type SubmitResult,
} from '../store/playground.ts';

export interface PlaygroundIngressOptions {
  /** Called after a release commit; the scheduler uses it to wake up. */
  readonly onQueued?: (chatId: bigint, invocationId: bigint) => void;
}

export class PlaygroundIngress {
  readonly #store: PlaygroundStore;
  readonly #options: PlaygroundIngressOptions;

  constructor(orm: Orm, options: PlaygroundIngressOptions = {}) {
    this.#store = new PlaygroundStore(orm);
    this.#options = options;
  }

  submit(
    chatId: bigint,
    body: {
      readonly requestKey?: unknown;
      readonly senderId?: unknown;
      readonly text?: unknown;
      readonly replyToSeq?: unknown;
    },
  ): SubmitResult {
    const requestKey = requireKey(body.requestKey, 'requestKey');
    const text = body.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new PlaygroundError('input_conflict', 'text must be a non-empty string');
    }
    if (text.length > 16_384) {
      throw new PlaygroundError('input_conflict', 'text is too long');
    }
    const senderId = requireDecimal(body.senderId, 'senderId');
    const replyToSeq =
      body.replyToSeq === null || body.replyToSeq === undefined
        ? null
        : requireDecimal(body.replyToSeq, 'replyToSeq');
    return this.#store.submit(chatId, { requestKey, senderId, text, replyToSeq });
  }

  release(
    chatId: bigint,
    body: { readonly releaseKey?: unknown; readonly revision?: unknown },
  ): ReleaseResult {
    const releaseKey = requireKey(body.releaseKey, 'releaseKey');
    const revision = requireDecimal(body.revision, 'revision');
    const result = this.#store.release(chatId, { releaseKey, revision });
    if (!result.replayed && result.invocationId !== null) {
      this.#options.onQueued?.(chatId, result.invocationId);
    }
    return result;
  }

  retry(
    chatId: bigint,
    body: { readonly releaseId?: unknown; readonly attemptKey?: unknown },
  ): RetryResult {
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