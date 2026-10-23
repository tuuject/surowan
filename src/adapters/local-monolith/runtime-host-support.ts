/**
 * Pieces the composition root shares with its startup phases: the event log,
 * the constants every phase reports against, conversation lookup and the
 * command reply path.
 */
import { and, eq } from 'drizzle-orm';
import type { Bot, Context } from 'grammy';
import type { McpManager } from '../../capabilities/mcp.ts';
import type { ImageBridge } from '../../image/bridge.ts';
import type { ImageService } from '../../image/service.ts';
import type { AdminServer } from '../../ingress/admin/server.ts';
import { commandSender, type BotCommandService, type ParsedCommand } from '../../orchestration/bot-commands.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import {
  toChatId,
  toConversationId,
  type HostKind,
  type ImConversationRef,
  type ImHost,
} from '../../platform/im-host.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { chats, conversations } from '../../store/schema.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { LoadedConfig } from './config.ts';
import type { ServeLock, SqliteStore } from './database.ts';
import type { StickerService } from '../../capabilities/stickers.ts';
import type { TelegramHost } from './telegram-host.ts';

export const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'] as const;

/**
 * Exit code of a panel-requested restart. `EX_TEMPFAIL` marks an intentional
 * stop that a supervisor should bring back, and stays distinguishable from a
 * crash in logs and container restart policies.
 */
export const RESTART_EXIT_CODE = 75;

/** The synthetic bot identity a room shows when no Telegram bot exists. */
export const PLAYGROUND_BOT_DISPLAY_NAME = 'Playground Bot';

/**
 * Handles the startup phases publish for the shutdown path: every field is the
 * live object, written by the phase that built it and read by the cleanup.
 */
export interface ServeState {
  lock?: ServeLock | undefined;
  stopWatcher?: (() => void) | undefined;
  store?: SqliteStore | undefined;
  imageService?: ImageService | undefined;
  imageBridge?: ImageBridge | undefined;
  bot?: Bot | undefined;
  scheduler?: BucketScheduler | undefined;
  stickers?: StickerService | undefined;
  mcp?: McpManager | undefined;
  host?: TelegramHost | undefined;
  roomHost?: ImHost | undefined;
  admin?: AdminServer | undefined;
  startupCatchUpController?: AbortController | undefined;
}

/** What `serve` itself owns and every phase reads: config, secrets and the stop path. */
export interface ServeContext {
  readonly loaded: LoadedConfig;
  readonly secrets: SecretStore;
  readonly takeover: boolean;
  readonly playgroundOnly: boolean;
  readonly replayShutdown: AbortController;
  readonly idle: Promise<void>;
  readonly state: ServeState;
  readonly shutdown: () => void;
  readonly requestRestart: () => void;
}

export function logEvent(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

/**
 * Resolves the conversation a delivery or activity call targets.
 *
 * The runtime never invents a chat route: the chat kind that decides the
 * conversation policy and the conversation row itself both come from storage,
 * so a group and a private chat with the same id cannot be confused, and a
 * delivery always lands on a conversation the server already knows about.
 */
export function resolveConversation(
  store: BusinessStore,
  target: { readonly chatId: bigint; readonly threadId: bigint; readonly conversationId?: bigint },
): ImConversationRef {
  const orm = store.orm;
  // The conversation row decides the host when the caller has one: the same
  // numeric value can be a Telegram chat id and a room's internal chat id, and
  // only the row knows which. Ingestion's mention target carries no
  // conversation id, so that path resolves a Telegram chat by its wire id.
  if (target.conversationId !== undefined && target.conversationId !== 0n) {
    const row = orm
      .select({
        id: conversations.id,
        chatId: conversations.chatId,
        threadId: conversations.messageThreadId,
        hostKind: chats.hostKind,
        type: chats.type,
        telegramChatId: chats.telegramChatId,
      })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(eq(conversations.id, target.conversationId))
      .get();
    if (row !== undefined) {
      const hostKind: HostKind = row.hostKind === 'playground' ? 'playground' : 'telegram';
      return {
        host: hostKind,
        id: toConversationId(row.id),
        chatId: toChatId((hostKind === 'telegram' ? row.telegramChatId : row.chatId)?.toString() ?? '0'),
        topicId: row.threadId === 0n ? null : Number(row.threadId),
        scope: row.type === 'private' ? 'private' : 'group',
      };
    }
  }
  const chat = orm
    .select({ id: chats.id, type: chats.type })
    .from(chats)
    .where(and(eq(chats.hostKind, 'telegram'), eq(chats.telegramChatId, target.chatId)))
    .get();
  const conversation =
    chat === undefined
      ? undefined
      : orm
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.chatId, chat.id), eq(conversations.messageThreadId, target.threadId)))
          .get();
  return {
    host: 'telegram',
    id: toConversationId(conversation?.id ?? 0n),
    chatId: toChatId(target.chatId.toString()),
    topicId: target.threadId === 0n ? null : Number(target.threadId),
    scope: chat?.type === 'private' ? 'private' : 'group',
  };
}

export async function replyToCommand(
  context: Context,
  commands: BotCommandService,
  command: ParsedCommand,
): Promise<void> {
  const message = context.update.message;
  if (message === undefined) {
    return;
  }
  const chatId = message.chat.id;
  const sender = commandSender(message);
  let text: string;
  try {
    text = await commands.run(command, BigInt(chatId), sender);
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
