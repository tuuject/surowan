/**
 * Failure classification for the Telegram transport.
 *
 * The host below catches whatever the client threw and asks this module what it
 * means in the IM contract's vocabulary. Keeping the HTTP/grammY knowledge here
 * is what lets `telegram-host.ts` stay about delivery shape and activity.
 */

import { GrammyError, HttpError } from 'grammy';
import type { ImDeliveryFailure } from '../../platform/im-host.ts';

/**
 * Raised when a transport adapter has no live instance to forward to. It is a
 * configuration/connection state, not a network failure: the caller must know
 * nothing was published, so the delivery is a known permanent refusal.
 */
export class TelegramUnavailableError extends Error {
  constructor() {
    super('this process has no Telegram transport');
    this.name = 'TelegramUnavailableError';
  }
}

/**
 * Turns whatever a Telegram client threw into the contract's vocabulary. A
 * caller branches on `reason`; only this function knows about HTTP status codes
 * and grammY error classes.
 */
export function classifyTelegramDeliveryError(error: unknown): ImDeliveryFailure {
  if (error instanceof TelegramUnavailableError) {
    return {
      reason: 'permanent',
      code: 'telegram_unavailable',
      outcomeUnknown: false,
      description: error.message,
    };
  }
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      return {
        reason: 'rate_limited',
        code: 'telegram_429',
        outcomeUnknown: false,
        // Without a delay from Telegram the caller stops instead of guessing one.
        ...(error.parameters.retry_after === undefined ? {} : { retryAfterSeconds: error.parameters.retry_after }),
        description: error.description,
      };
    }
    if (error.error_code >= 500) {
      return {
        reason: 'transient',
        code: `telegram_${error.error_code}`,
        outcomeUnknown: true,
        description: error.description,
      };
    }
    return {
      reason: 'permanent',
      code: `telegram_${error.error_code}`,
      outcomeUnknown: false,
      description: error.description,
    };
  }
  if (error instanceof HttpError) {
    return {
      reason: 'network',
      code: 'telegram_network',
      outcomeUnknown: true,
      description: error.message,
    };
  }
  return {
    reason: 'network',
    code: 'telegram_network',
    outcomeUnknown: true,
    description: error instanceof Error ? error.message : String(error),
  };
}

/** An abort is not a transport failure, but callers still branch on a failure. */
export function abortedTelegramDelivery(): ImDeliveryFailure {
  return {
    reason: 'aborted',
    code: 'aborted',
    outcomeUnknown: true,
    description: 'the send was aborted',
  };
}
