/**
 * Bounded backlog drain for a Telegram instance that comes up while the process
 * is already serving: a replaced token, or a disabled/configuration-error
 * connection recovering.
 *
 * Telegram hands out one update stream per bot, so a per-chat limit can only be
 * applied after the whole backlog is in memory: the pass pages through every
 * pending update first, keeps the newest messages of each chat, and only then
 * feeds ingestion in the original update order. The cold-start path is a
 * different contract (unbounded, only before the Scheduler starts) and lives in
 * `startup-catch-up.ts`.
 */

import type { Message, Update } from 'grammy/types';
import type { TelegramIngestion } from './ingress/telegram-ingestion.ts';
import { type BotCommandService, commandSender, parseBotCommand } from './orchestration/bot-commands.ts';
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
  const buffered: Update[] = [];
  let storedMessages = 0;
  let firstRequest = true;
  let offset: number | undefined;
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
      options.signal?.throwIfAborted();
      if (updates.length === 0) {
        break;
      }
      buffered.push(...updates);
      const lastUpdate = updates.at(-1);
      if (lastUpdate !== undefined) {
        offset = lastUpdate.update_id + 1;
      }
      firstRequest = false;
    }
    options.signal?.throwIfAborted();

    const retained = retainUpdates(buffered, options.botUsername);
    for (const update of retained.updates) {
      options.signal?.throwIfAborted();
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
    const invocationIds = options.scheduler.finishRuntimeCatchUp(startedAt, currentTime());
    options.scheduler.wake();
    logEvent('runtime_catch_up_completed', {
      updates: buffered.length,
      retained: retained.updates.length,
      dropped: retained.dropped,
      stored_messages: storedMessages,
      invocations: invocationIds.length,
    });
    return {
      updates: buffered.length,
      retained: retained.updates.length,
      dropped: retained.dropped,
      storedMessages,
      invocationIds,
    };
  } catch (error) {
    if (options.signal?.aborted === true) {
      // A cancelled pass creates no catch-up work: the token that replaced
      // this one drains the same stream again, while messages already ingested
      // stay in history.
      logEvent('runtime_catch_up_aborted', { updates: buffered.length, stored_messages: storedMessages });
    }
    throw error;
  }
}

interface RetentionPlan {
  readonly updates: readonly Update[];
  readonly dropped: number;
}

/**
 * Keeps the newest {@link RUNTIME_CATCH_UP_MESSAGES_PER_CHAT} stored messages of
 * every chat, plus every recognition of a bot command: a control command is a
 * state change, not context, so a busy chat must not push `/pause` out of the
 * window. An edit is kept only when its original message is kept, because a
 * revision of a discarded message would create a message that never existed in
 * the retained window.
 */
function retainUpdates(updates: readonly Update[], botUsername: string | null): RetentionPlan {
  const messageKeysByChat = new Map<string, string[]>();
  const commandKeys = new Set<string>();
  for (const update of updates) {
    const message = update.message;
    if (message === undefined) {
      continue;
    }
    const key = messageKey(message);
    if (parseBotCommand(message, botUsername) !== null) {
      commandKeys.add(key);
      continue;
    }
    const chatKey = String(message.chat.id);
    const keys = messageKeysByChat.get(chatKey);
    if (keys === undefined) {
      messageKeysByChat.set(chatKey, [key]);
    } else {
      keys.push(key);
    }
  }
  const retained = new Set(commandKeys);
  for (const keys of messageKeysByChat.values()) {
    for (const key of keys.slice(-RUNTIME_CATCH_UP_MESSAGES_PER_CHAT)) {
      retained.add(key);
    }
  }
  const kept: Update[] = [];
  let dropped = 0;
  for (const update of updates) {
    const message = update.message ?? update.edited_message;
    if (message === undefined || retained.has(messageKey(message))) {
      kept.push(update);
    } else {
      dropped += 1;
    }
  }
  return { updates: kept, dropped };
}

function messageKey(message: Message): string {
  return `${message.chat.id}:${message.message_id}`;
}

function logEvent(event: string, fields: Readonly<Record<string, number | string>>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
