/**
 * The one Telegram connection a serve process holds, from first `getMe` to the
 * last offset confirmation.
 *
 * A Bot Token is hot configuration: the process outlives every grammY instance,
 * so this manager owns the entire lifecycle and the composition root only ever
 * calls `start`, `applyToken` and `shutdown`. A connection that cannot reach
 * Telegram does not stop the process either; it reports a `network_error` and
 * retries with an exponential backoff capped at one minute.
 *
 * The manager is also the only place that knows a Telegram instance stopped:
 * the stop pass invalidates everything already accepted for Telegram
 * conversations (see `telegram-connection-stop.ts`), so a revoked token or a
 * replacement token cannot leave a queued reply from the old bot behind.
 */

import { type Api, Bot } from 'grammy';
import type { StickerService } from '../../capabilities/stickers.ts';
import type { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import type { ImConnectionRegistry, ImConnectionState } from '../../platform/im-connection.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { BusinessStore } from '../../store/store.ts';
import { logEvent } from './runtime-host-support.ts';
import { TelegramConnector } from './telegram-connection-connect.ts';
import {
  abandonTelegramWork,
  restoreAbandonedReceipts,
  TELEGRAM_STOPPED_REASON,
  waitForTelegramInvocations,
} from './telegram-connection-stop.ts';
import { resolveTelegramTokenSource, type TelegramTokenSource } from './telegram-connection-token.ts';
import {
  messageOf,
  type RunningTelegram,
  sameState,
  stateOfSource,
  type TelegramConnectionHooks,
  type TelegramReadiness,
  waitFor,
} from './telegram-connection-support.ts';
import type { TelegramIdentity } from './telegram-instance.ts';
import type { TelegramInstanceHolder } from './telegram-instance.ts';

export type { TelegramConnectionHooks } from './telegram-connection-support.ts';
export { TelegramReadiness } from './telegram-connection-support.ts';

const DEFAULT_INITIAL_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_ABORT_GRACE_MS = 10_000;

export interface TelegramConnectionManagerOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly connections: ImConnectionRegistry;
  readonly readiness: TelegramReadiness;
  readonly holder: TelegramInstanceHolder;
  readonly createIngestion: (me: TelegramIdentity) => TelegramIngestion;
  /** Builds the sticker worker for a live API; absent when this process has none. */
  readonly createStickers?: (api: Api) => StickerService;
  /** Stops every chat action the Telegram host is showing. */
  readonly stopActivity: () => void;
  /** Interrupts the listed running invocations and returns how many were signalled. */
  readonly abortInvocations: (ids: readonly bigint[], reason: string) => number;
  /** grammY factory; tests substitute it so nothing reaches the network. */
  readonly createBot?: (token: string) => Bot;
  readonly now?: () => Date;
  readonly retry?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    /** Injectable wait so tests never spend real backoff. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  };
  /** How long `bot.stop()` may block on its offset confirmation. */
  readonly stopTimeoutMs?: number;
  /** How long an interrupted run may take to persist its terminal state. */
  readonly abortGraceMs?: number;
  /**
   * Called after a migration releases the readiness gate. Work committed during
   * the transition (a backlog pass) must not wait for the Scheduler's longest
   * poll interval.
   */
  readonly onSettled?: () => void;
}

type ConnectionRequest =
  | { readonly kind: 'activate'; readonly token: string; readonly coldStart: boolean }
  | { readonly kind: 'state'; readonly state: ImConnectionState };

/**
 * Owns the Telegram instance and every transition between "no connection" and
 * "polling for a bot". Only one request runs at a time; a newer token aborts
 * the retry or backlog drain the previous one is in.
 */
export class TelegramConnectionManager {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #connections: ImConnectionRegistry;
  readonly #readiness: TelegramReadiness;
  readonly #connector: TelegramConnector;
  readonly #stopActivity: () => void;
  readonly #abortInvocations: (ids: readonly bigint[], reason: string) => number;
  readonly #initialRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #stopTimeoutMs: number;
  readonly #abortGraceMs: number;
  readonly #onSettled: (() => void) | undefined;
  readonly #now: () => Date;

  #hooks: TelegramConnectionHooks | undefined;
  #instance: RunningTelegram | undefined;
  #tail: Promise<void> = Promise.resolve();
  /** Network retries run beside the tail so a newer request never waits for them. */
  readonly #retries = new Set<Promise<void>>();
  #controller: AbortController | undefined;
  #pending: ConnectionRequest | undefined;
  #shuttingDown = false;

  constructor(options: TelegramConnectionManagerOptions) {
    this.#store = options.store;
    this.#configStore = options.configStore;
    this.#secrets = options.secrets;
    this.#connections = options.connections;
    this.#readiness = options.readiness;
    this.#stopActivity = options.stopActivity;
    this.#abortInvocations = options.abortInvocations;
    this.#now = options.now ?? ((): Date => new Date());
    this.#initialRetryMs = options.retry?.initialMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.#maxRetryMs = options.retry?.maxMs ?? DEFAULT_MAX_RETRY_MS;
    this.#sleep = options.retry?.sleep ?? waitFor;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.#onSettled = options.onSettled;
    this.#connector = new TelegramConnector({
      store: options.store,
      secrets: options.secrets,
      holder: options.holder,
      createIngestion: options.createIngestion,
      ...(options.createStickers === undefined ? {} : { createStickers: options.createStickers }),
      createBot: options.createBot ?? ((token): Bot => new Bot(token)),
      now: this.#now,
      initialRetryMs: this.#initialRetryMs,
      maxRetryMs: this.#maxRetryMs,
      stopTimeoutMs: this.#stopTimeoutMs,
      hooks: () => this.#hooks,
      publish: (state) => this.#publish(state),
      onPollingRejected: (reason) => {
        this.#request({ kind: 'state', state: { status: 'config_error', reason, since: this.#now().toISOString() } });
      },
      adopt: (instance) => {
        this.#instance = instance;
      },
      isCurrent: (instance) => this.#instance === instance && !instance.stopped,
    });
  }

  /** The sticker worker of the live instance, if there is one. */
  get stickers(): StickerService | undefined {
    return this.#connector.stickers;
  }

  isReady(): boolean {
    return this.#readiness.isReady();
  }

  /**
   * Resolves the configured token and opens the first connection. It returns
   * after the first attempt settles — connected, misconfigured, or the first
   * network failure — so a slow Telegram never delays the rest of startup.
   */
  async start(hooks: TelegramConnectionHooks): Promise<void> {
    if (this.#hooks !== undefined) {
      throw new Error('Telegram connection manager is already started');
    }
    this.#hooks = hooks;
    const source = await resolveTelegramTokenSource(this.#configStore.current().config, this.#secrets);
    if (source.kind === 'unreadable') {
      logEvent('telegram_token_unreadable', { error: source.message });
    }
    if (source.kind !== 'token') {
      this.#publish(stateOfSource(source, this.#now()));
      return;
    }
    await this.#enqueue({ kind: 'activate', token: source.token, coldStart: true });
  }

  /**
   * Applies a published token. The caller (a configuration apply) never waits:
   * the HTTP response is long gone if `getMe` has to retry for a while.
   */
  applyToken(source: TelegramTokenSource): void {
    if (this.#hooks === undefined || this.#shuttingDown) {
      return;
    }
    if (source.kind === 'unreadable') {
      logEvent('telegram_token_unreadable', { error: source.message });
    }
    if (source.kind === 'token') {
      if (this.#instance !== undefined && this.#instance.token === source.token) {
        return;
      }
      this.#request({ kind: 'activate', token: source.token, coldStart: false });
      return;
    }
    this.#request({ kind: 'state', state: stateOfSource(source, this.#now()) });
  }

  /** Waits for the requests applied so far to finish their first pass. */
  whenIdle(): Promise<void> {
    return this.#tail;
  }

  /**
   * Stops long polling and every Telegram-owned resource without invalidating
   * stored work: a process restart recovers queued and running work by design.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#controller?.abort();
    await this.#tail.catch(() => undefined);
    // A retry (even a superseded one) may be storing a backlog it already
    // confirmed; the store must outlive that write.
    await Promise.all(this.#retries);
    this.#instance = undefined;
    await this.#connector.shutdown();
    this.#stopActivity();
  }

  #request(request: ConnectionRequest): void {
    if (this.#pending !== undefined && sameRequest(this.#pending, request)) {
      return;
    }
    if (
      request.kind === 'state' &&
      this.#pending === undefined &&
      this.#instance === undefined &&
      sameState(this.#connections.get('telegram'), request.state)
    ) {
      return;
    }
    void this.#enqueue(request);
  }

  #enqueue(request: ConnectionRequest): Promise<void> {
    // The newest configuration wins: whatever the previous request was waiting
    // for (getMe backoff, a backlog drain) is no longer what the user asked for.
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.#pending = request;
    const run = this.#tail.then(async () => {
      if (this.#shuttingDown || controller.signal.aborted) {
        this.#finish(request);
        return;
      }
      this.#readiness.beginTransition();
      try {
        if (request.kind === 'state') {
          await this.#applyState(request.state, controller.signal);
          this.#finish(request);
          return;
        }
        await this.#applyToken(request, controller);
      } catch (error) {
        logEvent('telegram_connection_failed', { error: this.#secrets.redact(messageOf(error)) });
        this.#finish(request);
      }
    });
    this.#tail = run;
    return run;
  }

  async #applyState(state: ImConnectionState, signal: AbortSignal): Promise<void> {
    this.#publish(state);
    if (this.#instance !== undefined) {
      await this.#stopInstance(signal);
    }
  }

  async #applyToken(
    request: Extract<ConnectionRequest, { kind: 'activate' }>,
    controller: AbortController,
  ): Promise<void> {
    const { token } = request;
    this.#secrets.remember(token);
    if (this.#instance !== undefined) {
      if (this.#instance.token === token) {
        this.#finish(request);
        return;
      }
      await this.#stopInstance(controller.signal);
      if (controller.signal.aborted) {
        this.#finish(request);
        return;
      }
    }
    const outcome = await this.#connector.connect(token, request.coldStart, controller.signal);
    if (outcome.kind === 'network' && !controller.signal.aborted && !this.#shuttingDown) {
      // Keep the transition (and the dedupe slot) until the retry settles: no
      // Telegram work may start into a connection that does not exist yet.
      const retry = this.#retryUntilConnected(token, controller, request, outcome.retryAfterMs);
      this.#retries.add(retry);
      void retry.finally(() => this.#retries.delete(retry));
      return;
    }
    this.#finish(request);
  }

  async #retryUntilConnected(
    token: string,
    controller: AbortController,
    request: ConnectionRequest,
    firstDelayMs: number | undefined,
  ): Promise<void> {
    try {
      let attempt = 0;
      let delayMs = firstDelayMs;
      while (!controller.signal.aborted && !this.#shuttingDown) {
        attempt += 1;
        const wait = Math.min(delayMs ?? this.#initialRetryMs * 2 ** (attempt - 1), this.#maxRetryMs);
        logEvent('telegram_connection_retry', { attempt, delay_ms: wait });
        await this.#sleep(wait, controller.signal);
        if (controller.signal.aborted || this.#shuttingDown) {
          break;
        }
        const outcome = await this.#connector.connect(token, false, controller.signal);
        if (outcome.kind !== 'network') {
          break;
        }
        delayMs = outcome.retryAfterMs;
      }
    } catch (error) {
      // Nothing awaits this loop but shutdown, so a throw would surface as an
      // unhandled rejection and end the process. Same as a first attempt that
      // throws: the failure is logged and the attempt ends.
      logEvent('telegram_connection_failed', { error: this.#secrets.redact(messageOf(error)) });
    } finally {
      this.#finish(request);
    }
  }

  #finish(request: ConnectionRequest): void {
    if (this.#pending !== request) {
      // A newer request owns the gate now; it will close it when it settles.
      return;
    }
    this.#pending = undefined;
    this.#readiness.endTransition();
    this.#onSettled?.();
  }

  /**
   * The fixed stop pass: no new run may start, polling and activity stop, every
   * queued Telegram batch and invocation is invalidated in one transaction,
   * running runs are interrupted and their receipts return to the queue.
   */
  async #stopInstance(signal: AbortSignal): Promise<void> {
    const instance = this.#instance;
    this.#instance = undefined;
    if (instance !== undefined) {
      instance.stopped = true;
      await this.#connector.stop(instance);
    }
    this.#stopActivity();
    const abandoned = abandonTelegramWork(this.#store, this.#now());
    let signalled = 0;
    if (abandoned.runningInvocationIds.length > 0) {
      signalled = this.#abortInvocations(abandoned.runningInvocationIds, TELEGRAM_STOPPED_REASON);
      const stillRunning = await waitForTelegramInvocations(
        this.#store,
        abandoned.runningInvocationIds,
        this.#abortGraceMs,
        signal,
      );
      if (stillRunning.length > 0) {
        logEvent('telegram_invocation_stop_timeout', {
          invocations: stillRunning.map((id) => id.toString()).join(','),
        });
      }
      restoreAbandonedReceipts(this.#store, abandoned.runningInvocationIds, this.#now());
    }
    logEvent('telegram_stopped', {
      reason: TELEGRAM_STOPPED_REASON,
      expired_buckets: abandoned.expiredBuckets,
      aborted_invocations: abandoned.abortedInvocations,
      interrupted_invocations: signalled,
    });
  }

  #publish(state: ImConnectionState): void {
    const current = this.#connections.get('telegram');
    // The last identity is useful to the panel in both non-running states, but
    // a live-identity network_error means "ready but flaky" and a startup one
    // must not: carrying a stale bot into it would let work start again.
    const inherited =
      state.bot === undefined && (state.status === 'disabled' || state.status === 'config_error')
        ? current.bot
        : undefined;
    const next: ImConnectionState = inherited === undefined ? state : { ...state, bot: inherited };
    if (sameState(current, next)) {
      return;
    }
    this.#connections.set('telegram', next);
  }
}

function sameRequest(left: ConnectionRequest, right: ConnectionRequest): boolean {
  if (left.kind === 'activate' && right.kind === 'activate') {
    return left.token === right.token;
  }
  if (left.kind === 'state' && right.kind === 'state') {
    return sameState(left.state, right.state);
  }
  return false;
}
