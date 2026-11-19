/**
 * The grammY-side live update handler the connection manager installs: an
 * update is ingested, a mention starts typing activity, a control command
 * gets its reply, and the scheduler wakes. The composition root wires one
 * callback and never sees a grammY `Context`.
 */
import type { Context } from 'grammy';
import { commandSender } from '../../../ingress/telegram-ingestion/commands.ts';
import type { TelegramIngestion } from '../../../ingress/telegram-ingestion/index.ts';
import type { BotCommandService, ParsedCommand } from '../../../orchestration/bot-commands/index.ts';
import { activeSleepUntil } from '../../../store/sleep.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { logEvent, resolveConversation } from '../runtime/support.ts';
import type { TelegramHost } from './host.ts';

export interface TelegramUpdateHandlerDeps {
  readonly store: BusinessStore;
  /** The host whose typing activity a mention starts. */
  readonly host: TelegramHost;
  readonly commands: BotCommandService;
  /** Wakes the scheduler so stored work is picked up without waiting a tick. */
  readonly wake: () => void;
}

export function createTelegramUpdateHandler(
  deps: TelegramUpdateHandlerDeps,
): (context: Context, ingestion: TelegramIngestion) => Promise<void> {
  return async (context, ingestion) => {
    const result = ingestion.ingest(context.update);
    // A sleeping bot skips queued invocations, so a status would promise a
    // reply that never comes.
    if (result.mention !== undefined && activeSleepUntil(deps.store.orm) === null) {
      const target = resolveConversation(deps.store, result.mention);
      deps.host.activity.start({ conversation: target, policy: deps.host.policy(target) }, 'until_delivery');
    }
    if (result.command !== undefined) {
      await replyToCommand(context, deps.commands, result.command);
    }
    deps.wake();
  };
}

async function replyToCommand(context: Context, commands: BotCommandService, command: ParsedCommand): Promise<void> {
  const message = context.update.message;
  if (message === undefined) {
    return;
  }
  const chatId = message.chat.id;
  const sender = commandSender(message);
  let text: string;
  try {
    text = await commands.run(command, { hostKind: 'telegram', hostChatId: BigInt(chatId) }, sender);
  } catch (error) {
    logEvent('command_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await context.api.sendMessage(String(chatId), text, {
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      reply_parameters: { message_id: message.message_id },
    });
    logEvent('command_reply_sent', { command: command.name, chat_id: String(chatId) });
  } catch (error) {
    logEvent('command_reply_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
