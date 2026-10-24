/**
 * Bringing one Telegram instance up, and taking one down.
 *
 * This is the half of the connection that knows Telegram's wire: `getMe`,
 * command registration, webhook removal, ingestion identity, backlog drain and
 * the long-polling stream. The manager above owns *when* an instance exists;
 * this module owns what exists while it does, and never decides a connection
 * state on its own — it reports every outcome through `publish`.
 */

import { eq } from 'drizzle-orm';
import type { Api, Bot } from 'grammy';
import type { StickerService } from '../../capabilities/stickers.ts';
import type { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import { BOT_COMMANDS, registerBotCommands } from '../../orchestration/bot-commands.ts';
import type { ImConnectionState } from '../../platform/im-connection.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { appState } from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';
import { logEvent } from './runtime-host-support.ts';
import { TelegramPoller } from './telegram-connection-polling.ts';
import {
  identityOf,
  messageOf,
  type RunningTelegram,
  type TelegramConnectionHooks,
} from './telegram-connection-support.ts';
import type { TelegramIdentity, TelegramInstanceHolder } from './telegram-instance.ts';
import { telegramConfigFailure, telegramRetryDelayMs } from './telegram-host-failures.ts';

/** grammY still types its abort signal as the older abort-controller shim. */
type GrammySignal = Parameters<Api['getMe']>[0];
const grammySignal = (signal: AbortSignal): GrammySignal => signal as unknown as GrammySignal;

export type ConnectOutcome =
  | { readonly kind: 'connected' }
  /** Telegram said this token cannot run here; the state is already published. */
  | { readonly kind: 'config' }
  /** A newer request, a shutdown or an abandoned drain cancelled the attempt. */
  | { readonly kind: 'aborted' }
  /** The attempt could not reach Telegram; the caller retries with a backoff. */
  | { readonly kind: 'network'; readonly retryAfterMs?: number };

export interface TelegramConnectorOptions {
  readonly store: BusinessStore;
  readonly secrets: SecretStore;
  readonly holder: TelegramInstanceHolder;
  /** Builds ingestion for a fresh identity. */
  readonly createIngestion: (me: TelegramIdentity) => TelegramIngestion;
  /** Builds the sticker worker for a live API; absent when this process has none. */
  readonly createStickers?: (api: Api) => StickerService;
  /** grammY factory; tests substitute it so nothing reaches the network. */
  readonly createBot: (token: string) => Bot;
  readonly now: () => Date;
  readonly initialRetryMs: number;
  readonly maxRetryMs: number;
  readonly stopTimeoutMs: number;
  readonly hooks: () => TelegramConnectionHooks | undefined;
  /** Publishes a registry state; the manager deduplicates unchanged ones. */
  readonly publish: (state: ImConnectionState) => void;
  /**
   * Telegram answered 401/409 on the stream. The manager must run the stop
   * pass, not just record the state; the connector still owns the instance.
   */
  readonly onPollingRejected: (reason: 'unauthorized' | 'conflict') => void;
  /** Reports the instance that is now (or no longer) the live one. */
  readonly adopt: (instance: RunningTelegram | undefined) => void;
  /** Whether this instance is still the manager's current one. */
  readonly isCurrent: (instance: RunningTelegram) => boolean;
}

export class TelegramConnector {
  readonly #options: TelegramConnectorOptions;
  #instance: RunningTelegram | undefined;
  #stickers: StickerService | undefined;

  constructor(options: TelegramConnectorOptions) {
    this.#options = options;
  }

  /** The sticker worker of the live instance, if there is one. */
  get stickers(): StickerService | undefined {
    return this.#stickers;
  }

  /** One full connect attempt, including the cold-start backlog pass. */
  async connect(token: string, coldStart: boolean, signal: AbortSignal): Promise<ConnectOutcome> {
    const bot = this.#options.createBot(token);
    let me: Awaited<ReturnType<Api['getMe']>>;
    try {
      me = await bot.api.getMe(grammySignal(signal));
    } catch (error) {
      if (signal.aborted) {
        return { kind: 'aborted' };
      }
      return this.#failedAttempt('getMe', error);
    }
    if (signal.aborted) {
      return { kind: 'aborted' };
    }
    // grammY would call getMe again (with its own long retry) inside `start`;
    // this process already has the identity and this answer is authoritative.
    bot.botInfo = me;
    await this.#registerCommands(bot, signal);
    if (signal.aborted) {
      return { kind: 'aborted' };
    }
    const initialized = this.#initialized();
    const dropPending = coldStart && !initialized;
    try {
      await bot.api.deleteWebhook({ ...(dropPending ? { drop_pending_updates: true } : {}) }, grammySignal(signal));
    } catch (error) {
      if (signal.aborted) {
        return { kind: 'aborted' };
      }
      return this.#failedAttempt('deleteWebhook', error);
    }
    if (!initialized) {
      // The marker means "this deployment has connected at least once", so a
      // deferred first connection does not drop the next boot's backlog either.
      this.#markInitialized();
    }
    if (signal.aborted) {
      return { kind: 'aborted' };
    }
    const poller = this.#createPoller(bot);
    const instance: RunningTelegram = {
      api: bot.api,
      bot,
      token,
      me,
      ingestion: this.#options.createIngestion(me),
      poller,
      stopped: false,
      networkError: false,
    };
    this.#adopt(instance);
    this.#options.holder.set({ api: bot.api, bot, token, me });
    poller.observe(bot.api);
    await this.#startStickers(bot.api);
    if (signal.aborted) {
      await this.abandon(instance);
      return { kind: 'aborted' };
    }
    if (!(await this.#runCatchUp(instance, coldStart, signal))) {
      await this.abandon(instance);
      return { kind: 'aborted' };
    }
    this.#options.publish({ status: 'connected', bot: identityOf(me), since: this.#options.now().toISOString() });
    this.#installHandler(instance);
    logEvent('telegram_connected', { bot_id: String(me.id), cold_start: coldStart });
    poller.start();
    return { kind: 'connected' };
  }

  /** Stops polling, the sticker worker and the identity a caller can resolve. */
  async stop(instance: RunningTelegram): Promise<void> {
    if (this.#instance === instance) {
      this.#adopt(undefined);
    }
    await instance.poller.stop(this.#options.stopTimeoutMs);
    await this.#stopStickers();
    this.#options.holder.set(undefined);
  }

  /** Cleans a half-built instance that was never announced as connected. */
  async abandon(instance: RunningTelegram): Promise<void> {
    instance.stopped = true;
    await this.stop(instance);
  }

  /** Stops whatever instance is live without invalidating stored work. */
  async shutdown(): Promise<void> {
    const instance = this.#instance;
    this.#instance = undefined;
    if (instance !== undefined) {
      instance.stopped = true;
      await instance.poller.stop(this.#options.stopTimeoutMs);
    }
    await this.#stopStickers();
    this.#options.holder.set(undefined);
  }

  #adopt(instance: RunningTelegram | undefined): void {
    this.#instance = instance;
    this.#options.adopt(instance);
  }

  #createPoller(bot: Bot): TelegramPoller {
    return new TelegramPoller({
      bot,
      initialDelayMs: this.#options.initialRetryMs,
      maxDelayMs: this.#options.maxRetryMs,
      isCurrent: () => {
        const current = this.#instance;
        return current !== undefined && current.bot === bot && !current.stopped;
      },
      onStreamAlive: () => this.#onStreamAlive(),
      onNetworkError: (error) => this.#onNetworkError(error),
      onRejected: (reason) => {
        logEvent('telegram_polling_rejected', { reason });
        this.#options.onPollingRejected(reason);
      },
      onExited: (error) => {
        const current = this.#instance;
        this.#options.publish({
          status: 'network_error',
          ...(current !== undefined && current.bot === bot ? { bot: identityOf(current.me) } : {}),
          since: this.#options.now().toISOString(),
        });
        if (error !== undefined) {
          this.#log('telegram_polling_failed', error);
        }
      },
    });
  }

  #onStreamAlive(): void {
    const instance = this.#instance;
    if (instance === undefined || !instance.networkError) {
      return;
    }
    instance.networkError = false;
    this.#options.publish({
      status: 'connected',
      bot: identityOf(instance.me),
      since: this.#options.now().toISOString(),
    });
    logEvent('telegram_reconnected', { bot_id: String(instance.me.id) });
  }

  #onNetworkError(error: unknown): void {
    const instance = this.#instance;
    if (instance === undefined || instance.networkError) {
      return;
    }
    // 401/409 are the polling loop's own signal: it rejects and the stop path
    // takes over there, so recording the state twice would race it.
    if (telegramConfigFailure(error) !== undefined) {
      return;
    }
    instance.networkError = true;
    this.#options.publish({
      status: 'network_error',
      bot: identityOf(instance.me),
      since: this.#options.now().toISOString(),
    });
    this.#log('telegram_network_error', error);
  }

  #failedAttempt(method: string, error: unknown): ConnectOutcome {
    const reason = telegramConfigFailure(error);
    if (reason !== undefined) {
      this.#options.publish({ status: 'config_error', reason, since: this.#options.now().toISOString() });
      logEvent('telegram_config_error', { reason });
      return { kind: 'config' };
    }
    this.#options.publish({ status: 'network_error', since: this.#options.now().toISOString() });
    logEvent('telegram_connection_failed', { method, error: this.#options.secrets.redact(messageOf(error)) });
    const retryAfterMs = telegramRetryDelayMs(error);
    return { kind: 'network', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }

  async #registerCommands(bot: Bot, signal: AbortSignal): Promise<void> {
    try {
      await registerBotCommands(bot.api);
      logEvent('commands_registered', { commands: BOT_COMMANDS.map((entry) => entry.command).join(',') });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      // Registration is convenience only: command parsing works without the
      // Telegram menu, so a failed setMyCommands must not block the connection.
      this.#log('command_registration_failed', error);
    }
  }

  #initialized(): boolean {
    return (
      this.#options.store.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, 'telegram_initialized'))
        .get() !== undefined
    );
  }

  #markInitialized(): void {
    this.#options.store.orm
      .insert(appState)
      .values({ key: 'telegram_initialized', value: '1', updatedAt: this.#options.now().toISOString() })
      .run();
  }

  async #startStickers(api: Api): Promise<void> {
    if (this.#options.createStickers === undefined) {
      return;
    }
    const service = this.#options.createStickers(api);
    try {
      await service.sync();
      service.start();
      this.#stickers = service;
    } catch (error) {
      this.#log('telegram_stickers_failed', error);
    }
  }

  async #stopStickers(): Promise<void> {
    const service = this.#stickers;
    this.#stickers = undefined;
    if (service === undefined) {
      return;
    }
    try {
      await service.stop();
    } catch (error) {
      this.#log('telegram_stickers_stop_failed', error);
    }
  }

  /** Drains the cold backlog before polling; a runtime pass is bounded by chat. */
  async #runCatchUp(instance: RunningTelegram, coldStart: boolean, signal: AbortSignal): Promise<boolean> {
    const hook = coldStart ? this.#options.hooks()?.coldCatchUp : this.#options.hooks()?.runtimeCatchUp;
    if (hook === undefined) {
      return true;
    }
    try {
      await hook(instance.api, instance.ingestion, signal, instance.me);
      return true;
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      // Context is a best-effort enrichment: a failed drain must not cost the
      // connection, and the live stream picks up from here.
      this.#log('telegram_catch_up_failed', error);
      return true;
    }
  }

  #installHandler(instance: RunningTelegram): void {
    instance.poller.handle(async (context) => {
      if (!this.#options.isCurrent(instance) || instance.stopped) {
        return;
      }
      try {
        await this.#options.hooks()?.onUpdate(context, instance.ingestion);
      } catch (error) {
        // A middleware error would otherwise make grammY tear down the polling
        // loop; one failed update is not a reason to drop the connection.
        this.#log('telegram_update_failed', error);
      }
    });
  }

  #log(event: string, error: unknown): void {
    logEvent(event, { error: this.#options.secrets.redact(messageOf(error)) });
  }
}
