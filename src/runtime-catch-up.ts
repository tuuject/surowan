/**
 * Bounded backlog drain for a Telegram instance that comes up while the process
 * is already serving: a replaced token, or a disabled/configuration-error
 * connection recovering.
 *
 * Telegram hands out one update stream per bot, so a per-chat limit cannot be
 * known until the stream ends: the pass pages through every pending update,
 * keeping only the newest messages of each chat as it goes, and then feeds
 * ingestion in the original update order. Paging confirms each previous page,
 * so whatever was retained is ingested even when a later page fails or the
 * pass is cancelled. The cold-start path is a different contract (unbounded,
 * only before the Scheduler starts) and lives in `startup-catch-up.ts`.
 */

import type { Message, Update } from 'grammy/types';
import type { TelegramIngestion } from './ingress/telegram-ingestion/index.ts';
import { type BotCommandService, commandSender, parseBotCommand } from './orchestration/bot-commands/index.ts';
import type { StartupCatchUpApi } from './startup-catch-up.ts';

/** How many messages of one chat a runtime pass keeps; older ones are dropped. */
export const RUNTIME_CATCH_UP_MESSAGES_PER_CHAT = 100;

export interface RuntimeCatchUpScheduler {
  /** Turns the messages this pass stored into catch-up buckets and queued runs. */
  finishRuntimeCatchUp(startedAt: Date, now?: Date): bigint[];
  /** The Scheduler may be asleep on a long deadline when the pass commits. */
  wake(): void;
}

export interface RuntimeCatchUpOptions {
  readonly api: StartupCatchUpApi;
  readonly ingestion: TelegramIngestion;
  readonly commands: BotCommandService;
  readonly scheduler: RuntimeCatchUpScheduler;
  readonly allowedUpdates: readonly Exclude<keyof Update, 'update_id'>[];
  /** Bot username for `@mention` command parsing; null when the bot has none. */
  readonly botUsername: string | null;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface RuntimeCatchUpResult {
  readonly updates: number;
  readonly retained: number;
  readonly dropped: number;
  readonly storedMessages: number;
  readonly invocationIds: readonly bigint[];
}

export async function runRuntimeCatchUp(options: RuntimeCatchUpOptions): Promise<RuntimeCatchUpResult> {
  const currentTime = options.now ?? (() => new Date());
  const startedAt = currentTime();
  const retention = new RetentionBuffer(options.botUsername);
  let firstRequest = true;
  let offset: number | undefined;
  let drainError: unknown;
  let drained = false;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const request = {
        limit: 100,
        timeout: 0,
        ...(offset === undefined ? {} : { offset }),
        ...(firstRequest ? { allowed_updates: options.allowedUpdates } : {}),
      };
      const updates = await options.api.getUpdates(request);
      if (updates.length === 0) {
        break;
      }
      for (const update of updates) {
        retention.add(update);
      }
      const lastUpdate = updates.at(-1);
      if (lastUpdate !== undefined) {
        offset = lastUpdate.update_id + 1;
      }
      firstRequest = false;
    }
    drained = true;
  } catch (error) {
    drainError = error;
  }

  // Every request after the first carried an `offset`, which told Telegram to
  // forget the page before it: what the buffer holds now is stored here or
  // never. So neither an abort nor a failed page skips this step — they only
  // decide whether the pass also becomes catch-up work.
  const plan = retention.plan();
  let storedMessages = 0;
  for (const update of plan.updates) {
    const receivedAt = currentTime();
    const result = options.ingestion.ingestCatchUp(update, receivedAt);
    if (result.messageId !== undefined && update.message !== undefined) {
      storedMessages += 1;
    }
    const command = result.command;
    const message = update.message;
    if (command !== undefined && message !== undefined) {
      // In update order, so a later /resume or /pause wins exactly as it
      // would have live; duplicates never get here (ingestion dedupes them).
      await options.commands.run(command, BigInt(message.chat.id), commandSender(message), receivedAt);
    }
  }
  const counts = {
    updates: plan.received,
    retained: plan.updates.length,
    dropped: plan.dropped,
    stored_messages: storedMessages,
  };
  if (options.signal?.aborted === true) {
    // A cancelled pass creates no catch-up work: the connection it belonged
    // to is gone. The messages it stored stay in history.
    logEvent('runtime_catch_up_aborted', counts);
    options.signal.throwIfAborted();
  }
  // A page that failed after earlier ones were confirmed still leaves a usable
  // window; the live stream picks up from the last confirmed offset.
  const invocationIds = options.scheduler.finishRuntimeCatchUp(startedAt, currentTime());
  options.scheduler.wake();
  logEvent(drained ? 'runtime_catch_up_completed' : 'runtime_catch_up_interrupted', {
    ...counts,
    invocations: invocationIds.length,
  });
  if (!drained) {
    throw drainError;
  }
  return {
    updates: plan.received,
    retained: plan.updates.length,
    dropped: plan.dropped,
    storedMessages,
    invocationIds,
  };
}

interface RetentionPlan {
  readonly updates: readonly Update[];
  readonly received: number;
  readonly dropped: number;
}

/**
 * Keeps the newest {@link RUNTIME_CATCH_UP_MESSAGES_PER_CHAT} stored messages of
 * every chat while the stream is paged, plus every recognition of a bot
 * command: a control command is a state change, not context, so a busy chat
 * must not push `/pause` out of the window. An edit is kept only while its
 * original message is kept, because a revision of a discarded message would
 * create a message that never existed in the retained window.
 *
 * Eviction happens as pages arrive, so memory is bounded by the window per
 * chat instead of by the size of the backlog.
 */
class RetentionBuffer {
  readonly #botUsername: string | null;
  /** Retained updates by `update_id`; insertion order is Telegram's update order. */
  readonly #updates = new Map<number, Update>();
  /** Per chat, the keys of retained ordinary messages, oldest first. */
  readonly #messagesByChat = new Map<string, string[]>();
  /** The update ids recorded for one retained message: itself and its edits. */
  readonly #updateIdsByMessage = new Map<string, number[]>();
  #received = 0;
  #dropped = 0;

  constructor(botUsername: string | null) {
    this.#botUsername = botUsername;
  }

  add(update: Update): void {
    this.#received += 1;
    const message = update.message;
    if (message !== undefined) {
      const key = messageKey(message);
      const known = this.#updateIdsByMessage.has(key);
      this.#keep(key, update);
      if (known || parseBotCommand(message, this.#botUsername) !== null) {
        return;
      }
      const chatKey = String(message.chat.id);
      const keys = this.#messagesByChat.get(chatKey) ?? [];
      keys.push(key);
      this.#messagesByChat.set(chatKey, keys);
      if (keys.length > RUNTIME_CATCH_UP_MESSAGES_PER_CHAT) {
        const oldest = keys.shift();
        if (oldest !== undefined) {
          this.#evict(oldest);
        }
      }
      return;
    }
    const edited = update.edited_message;
    if (edited !== undefined) {
      const key = messageKey(edited);
      if (this.#updateIdsByMessage.has(key)) {
        this.#keep(key, update);
      } else {
        this.#dropped += 1;
      }
      return;
    }
    this.#updates.set(update.update_id, update);
  }

  plan(): RetentionPlan {
    return { updates: [...this.#updates.values()], received: this.#received, dropped: this.#dropped };
  }

  #keep(key: string, update: Update): void {
    this.#updates.set(update.update_id, update);
    const ids = this.#updateIdsByMessage.get(key);
    if (ids === undefined) {
      this.#updateIdsByMessage.set(key, [update.update_id]);
    } else {
      ids.push(update.update_id);
    }
  }

  #evict(key: string): void {
    for (const id of this.#updateIdsByMessage.get(key) ?? []) {
      if (this.#updates.delete(id)) {
        this.#dropped += 1;
      }
    }
    this.#updateIdsByMessage.delete(key);
  }
}

function messageKey(message: Message): string {
  return `${message.chat.id}:${message.message_id}`;
}

function logEvent(event: string, fields: Readonly<Record<string, number | string>>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
