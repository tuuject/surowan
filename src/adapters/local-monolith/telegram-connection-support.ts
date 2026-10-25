/**
 * Vocabulary and small gates shared by the Telegram connection modules.
 *
 * Nothing here opens a connection: the readiness gate only says whether the
 * Scheduler may hand Telegram work to whatever instance currently exists.
 */

import type { Api, Bot, Context } from 'grammy';
import type { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import type { ImConnectionBot, ImConnectionRegistry, ImConnectionState } from '../../platform/im-connection.ts';
import type { TelegramIdentity } from './telegram-instance.ts';
import type { TelegramPoller } from './telegram-connection-polling.ts';
import type { TelegramTokenSource } from './telegram-connection-token.ts';

/**
 * Whether Telegram work may start right now.
 *
 * The registry answers for a live connection; this gate adds the window in
 * which a connection is being replaced. Between "stop the old instance" and
 * "the new one is ready" neither state is a usable one, and starting a run
 * then would hand it to an instance that is about to disappear.
 */
export class TelegramReadiness {
  readonly #connections: ImConnectionRegistry;
  #transitioning = false;

  constructor(connections: ImConnectionRegistry) {
    this.#connections = connections;
  }

  isReady(): boolean {
    return !this.#transitioning && this.#connections.isReady('telegram');
  }

  beginTransition(): void {
    this.#transitioning = true;
  }

  endTransition(): void {
    this.#transitioning = false;
  }
}

/** One backlog pass for a live instance; `me` is the identity that will poll. */
export type TelegramCatchUpHook = (
  api: Api,
  ingestion: TelegramIngestion,
  signal: AbortSignal,
  me: TelegramIdentity,
) => Promise<void>;

/** What the runtime provides once it exists; the manager needs all three. */
export interface TelegramConnectionHooks {
  /** Handles one live update for the ingestion built from the current identity. */
  readonly onUpdate: (context: Context, ingestion: TelegramIngestion) => Promise<void> | void;
  /** Cold start only: drains the whole backlog before long polling begins. */
  readonly coldCatchUp?: TelegramCatchUpHook;
  /** Runtime starts: the bounded backlog pass before long polling begins. */
  readonly runtimeCatchUp?: TelegramCatchUpHook;
}

/** One live Bot: everything a running connection owns. */
export interface RunningTelegram {
  readonly api: Api;
  readonly bot: Bot;
  readonly token: string;
  readonly me: TelegramIdentity;
  readonly ingestion: TelegramIngestion;
  readonly poller: TelegramPoller;
  stopped: boolean;
  networkError: boolean;
}

/** The identity shape the registry and the panel show. */
export const identityOf = (me: TelegramIdentity): ImConnectionBot => ({
  id: String(me.id),
  username: me.username ?? null,
});

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A wait that ends early on abort and never keeps the process alive on its own. */
export const waitFor = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });

/** The state a token source alone implies; a token means "try to connect". */
export const stateOfSource = (source: TelegramTokenSource, now: Date): ImConnectionState => {
  if (source.kind === 'unreadable') {
    return { status: 'config_error', reason: 'token_unreadable', since: now.toISOString() };
  }
  return { status: 'disabled', since: now.toISOString() };
};

export const sameState = (left: ImConnectionState, right: ImConnectionState): boolean =>
  left.status === right.status &&
  (left.status === 'config_error' ? right.status === 'config_error' && left.reason === right.reason : true) &&
  left.bot?.id === right.bot?.id &&
  left.bot?.username === right.bot?.username;
