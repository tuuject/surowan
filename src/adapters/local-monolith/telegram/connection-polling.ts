/**
 * Long polling for one live Telegram instance.
 *
 * grammY owns the polling loop; this object only observes what it does. A
 * network failure is swallowed and retried by grammY itself, so the stream is
 * watched at the one place every `getUpdates` passes through; an authentication
 * answer (401/409) is the loop rejecting, which is what ends the instance.
 * Nothing here exits the process or touches stored work.
 */

import type { Api, Bot, Context } from 'grammy';
import { ALLOWED_UPDATES } from '../runtime/support.ts';
import { waitFor } from './connection-support.ts';
import { type TelegramConfigFailure, telegramConfigFailure } from './host-failures.ts';

export interface TelegramPollerOptions {
  readonly bot: Bot;
  /** Whether this instance is still the manager's current one. */
  readonly isCurrent: () => boolean;
  /** One successful `getUpdates`: the stream is usable again. */
  readonly onStreamAlive: () => void;
  /** A failed `getUpdates` that is not an authentication answer. */
  readonly onNetworkError: (error: unknown) => void;
  /** Polling was rejected with 401/409; the manager decides what happens next. */
  readonly onRejected: (reason: TelegramConfigFailure) => void;
  /** Polling ended without an authentication answer. */
  readonly onExited: (error: unknown) => void;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export class TelegramPoller {
  readonly #options: TelegramPollerOptions;
  #polling: Promise<void> | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #restarts = 0;
  #running = false;

  constructor(options: TelegramPollerOptions) {
    this.#options = options;
  }

  /** Watches `getUpdates`; install before `start`. */
  observe(api: Api): void {
    api.config.use((prev, method, payload, signal) => {
      if (method !== 'getUpdates') {
        return prev(method, payload, signal);
      }
      return prev(method, payload, signal).then(
        (updates) => {
          if (this.#running && this.#options.isCurrent()) {
            this.#restarts = 0;
            this.#options.onStreamAlive();
          }
          return updates;
        },
        (error: unknown) => {
          if (this.#running && this.#options.isCurrent()) {
            this.#options.onNetworkError(error);
          }
          throw error;
        },
      );
    });
  }

  /** Installs the middleware stack; grammY refuses new middleware once started. */
  handle(handler: (context: Context) => Promise<void>): void {
    this.#options.bot.use(handler);
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#spawn();
  }

  async stop(timeoutMs: number): Promise<void> {
    this.#running = false;
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const polling = this.#polling;
    this.#polling = undefined;
    // grammY's stop also confirms the offset with one last getUpdates, whose
    // rejection is expected when the network is gone; cap it so a dead network
    // cannot hold a token replacement hostage.
    await Promise.race([this.#options.bot.stop().catch(() => undefined), waitFor(timeoutMs)]);
    if (polling !== undefined) {
      await Promise.race([polling.catch(() => undefined), waitFor(timeoutMs)]);
    }
  }

  #spawn(): void {
    const polling = this.#options.bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
    this.#polling = polling;
    void polling.then(
      () => this.#ended(undefined),
      (error: unknown) => this.#ended(error),
    );
  }

  #ended(error: unknown): void {
    if (!this.#running) {
      return;
    }
    const reason = error === undefined ? undefined : telegramConfigFailure(error);
    if (reason !== undefined) {
      this.#running = false;
      this.#options.onRejected(reason);
      return;
    }
    this.#options.onExited(error);
    this.#restarts += 1;
    const delay = Math.min(this.#options.initialDelayMs * 2 ** (this.#restarts - 1), this.#options.maxDelayMs);
    const timer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#running) {
        this.#spawn();
      }
    }, delay);
    timer.unref?.();
    this.#restartTimer = timer;
  }
}
