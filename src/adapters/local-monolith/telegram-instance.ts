/**
 * The live Telegram instance and the adapters that follow it.
 *
 * One process keeps one `TelegramHost`, one media downloader and one bot
 * identity holder for its whole lifetime; the connection manager swaps the
 * instance inside this holder when it starts or stops one. Every adapter
 * resolves the current instance at call time, so nothing else has to be
 * rebuilt and a process with no instance still answers deterministically.
 */

import type { Api, Bot } from 'grammy';
import { type MediaDownloader, TelegramMediaClient } from '../../capabilities/media/media-download.ts';
import { PLAYGROUND_BOT_DISPLAY_NAME } from './runtime-host-support.ts';
import {
  grammyTelegramTransport,
  type TelegramMediaOptions,
  type TelegramMessageOptions,
  type TelegramSendResponse,
  type TelegramTransport,
} from './telegram-host.ts';
import { TelegramUnavailableError } from './telegram-host-failures.ts';

/** What `getMe()` reports about the bot; the fields this process reads. */
export interface TelegramIdentity {
  readonly id: number;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string | null;
}

/** The objects one running Telegram connection owns. */
export interface TelegramInstance {
  readonly api: Api;
  readonly bot?: Bot;
  readonly token: string;
  readonly me: TelegramIdentity;
}

/**
 * The single slot every Telegram-facing adapter reads. Setting `undefined`
 * stops forwarding immediately; the host then refuses deliveries instead of
 * throwing an unclassified error.
 */
export class TelegramInstanceHolder {
  #instance: TelegramInstance | undefined;
  #transport: TelegramTransport | undefined;

  get current(): TelegramInstance | undefined {
    return this.#instance;
  }

  get identity(): TelegramIdentity | undefined {
    return this.#instance?.me;
  }

  set(instance: TelegramInstance | undefined): void {
    this.#instance = instance;
    // The transport keeps its own typing dedupe state, so it is created once
    // per instance rather than once per forwarded call.
    this.#transport = instance === undefined ? undefined : grammyTelegramTransport(instance.api);
  }

  /** The transport of the current instance, if one is running. */
  transport(): TelegramTransport | undefined {
    return this.#transport;
  }
}

const requireTransport = (holder: TelegramInstanceHolder): TelegramTransport => {
  const transport = holder.transport();
  if (transport === undefined) {
    throw new TelegramUnavailableError();
  }
  return transport;
};

/**
 * Forwards to the current instance. With no instance every send throws
 * `TelegramUnavailableError`, which the host classifies as a permanent
 * `telegram_unavailable` refusal.
 */
export function forwardingTelegramTransport(holder: TelegramInstanceHolder): TelegramTransport {
  return {
    sendTyping: (chatId: string, threadId: bigint, signal: AbortSignal): Promise<void> => {
      const transport = requireTransport(holder);
      return transport.sendTyping?.(chatId, threadId, signal) ?? Promise.resolve();
    },
    sendMessage: (chatId: string, text: string, options: TelegramMessageOptions): Promise<TelegramSendResponse> =>
      requireTransport(holder).sendMessage(chatId, text, options),
    sendSticker: (chatId: string, sticker: string, options: TelegramMessageOptions): Promise<TelegramSendResponse> =>
      requireTransport(holder).sendSticker(chatId, sticker, options),
    sendGeneratedPhoto: (
      chatId: string,
      bytes: Uint8Array,
      fileName: string,
      options: TelegramMediaOptions,
    ): Promise<TelegramSendResponse> => {
      const transport = requireTransport(holder);
      if (transport.sendGeneratedPhoto === undefined) {
        throw new TelegramUnavailableError();
      }
      return transport.sendGeneratedPhoto(chatId, bytes, fileName, options);
    },
    sendGeneratedPhotoGroup: (
      chatId: string,
      pictures: readonly { readonly bytes: Uint8Array; readonly fileName: string }[],
      options: TelegramMediaOptions,
    ): Promise<TelegramSendResponse[]> => {
      const transport = requireTransport(holder);
      if (transport.sendGeneratedPhotoGroup === undefined) {
        throw new TelegramUnavailableError();
      }
      return transport.sendGeneratedPhotoGroup(chatId, pictures, options);
    },
  };
}

/** Downloads through the current instance; without one (Telegram stopped), refuses. */
export class ForwardingTelegramMedia implements MediaDownloader {
  readonly #holder: TelegramInstanceHolder;

  constructor(holder: TelegramInstanceHolder) {
    this.#holder = holder;
  }

  download(fileId: string, destination: string, signal: AbortSignal): Promise<void> {
    const instance = this.#holder.current;
    if (instance === undefined) {
      return Promise.reject(new Error('this process has no Telegram media transport'));
    }
    return new TelegramMediaClient(instance.api, instance.token).download(fileId, destination, signal);
  }
}

/**
 * The bot identity the runtime records and compares against. Reading the
 * current instance on every access keeps sender rows and participation checks
 * in step with a replaced connection; a process without one presents the
 * Playground identity, exactly as a room-only process always did.
 */
export class TelegramConnectionIdentity {
  readonly #holder: TelegramInstanceHolder;

  constructor(holder: TelegramInstanceHolder) {
    this.#holder = holder;
  }

  get id(): bigint {
    const me = this.#holder.identity;
    return me === undefined ? 0n : BigInt(me.id);
  }

  get displayName(): string {
    const me = this.#holder.identity;
    return me === undefined
      ? PLAYGROUND_BOT_DISPLAY_NAME
      : [me.first_name, me.last_name].filter((part) => part !== undefined).join(' ');
  }

  get username(): string | null {
    return this.#holder.identity?.username ?? null;
  }
}
