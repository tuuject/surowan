/**
 * The Telegram edge of inbound message flow. One Update is deduplicated
 * (`telegram_updates`), admitted (allowlist, topics, migrations), checked for
 * control commands and ignored senders, normalized into `InboundMessage`, and
 * handed to the host-neutral intake path — all inside one synchronous
 * transaction, exactly as the storage and bucket append always were.
 */
import type { Update } from 'grammy/types';
import type { ParsedCommand } from '../../orchestration/bot-commands/index.ts';
import { isAsk } from '../../platform/telegram-markdown/cues.ts';
import { conversationThreadId, parseBotCommand } from './commands.ts';
import { InboundIntake, type IntakeResult } from '../intake/index.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { resolveChatConfig } from '../../platform/config/index.ts';
import { telegramUpdates } from '../../store/schema/index.ts';
import { asRunResult, type BusinessStore } from '../../store/store.ts';
import {
  type AllowedChatsState,
  recordMigration,
  syncAllowedChats,
  type TelegramChatDeps,
  topicsFor,
  upsertChat,
} from './chats.ts';
import { isIgnoredUser, toInboundMessage } from './messages.ts';

export interface IngestResult extends IntakeResult {
  readonly command?: ParsedCommand;
}

export class TelegramIngestion {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #chats: AllowedChatsState = { allowedChats: new Map(), generation: 0 };
  readonly #chatDeps: TelegramChatDeps;
  readonly #intake: InboundIntake;
  readonly #botId: bigint;
  readonly #botUsername: string | null;

  constructor(
    store: BusinessStore,
    configStore: RuntimeConfigurationStore,
    bot: { readonly id: number; readonly username?: string | null },
  ) {
    this.#store = store;
    this.#configStore = configStore;
    this.#botId = BigInt(bot.id);
    this.#botUsername = bot.username ?? null;
    this.#chatDeps = { store, configStore, state: this.#chats };
    this.#intake = new InboundIntake(store, configStore, this.#botId);
    syncAllowedChats(this.#chatDeps);
  }

  ingest(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, true));
  }

  ingestCatchUp(update: Update, receivedAt = new Date()): IngestResult {
    return this.#store.transaction(() => this.#ingestTransaction(update, receivedAt, false));
  }

  #ingestTransaction(update: Update, receivedAt: Date, schedule: boolean): IngestResult {
    syncAllowedChats(this.#chatDeps);
    const message = update.edited_message ?? update.message;
    const membership = update.my_chat_member;
    const chat = message?.chat ?? membership?.chat;
    const chatId = chat === undefined ? undefined : BigInt(chat.id);
    // One rule, shared with `parseBotCommand`: the two must agree or a command
    // scoped to a Conversation cannot find the rows ingestion wrote.
    const threadId = conversationThreadId(message);
    // A migration notice is what authorizes the new supergroup ID, so it is
    // recorded before that ID is checked against the allowlist and topics. The
    // first notice the bot sees can be `migrate_from_chat_id` in the new chat.
    recordMigration(this.#chatDeps, message, receivedAt);
    const topics = chatId === undefined ? null : topicsFor(this.#chatDeps, chatId);
    const topicAllowed = topics !== null && (topics === undefined || topics.has(threadId));
    const edited = update.edited_message !== undefined;
    // Chat control commands are handled by the bot itself: they are audited
    // but never stored as messages, so they cannot trigger or taint buckets.
    // `command` is every recognized command; `handledCommand` is the subset the
    // caller may act on. Startup catch-up replays only /pause and /resume — the
    // two whose state must survive the downtime — while every other recognized
    // command is still intercepted below (never stored as a message) so a
    // stale update cannot replay administrative effects like /allowlist.
    const command = !edited && message !== undefined ? parseBotCommand(message, this.#botUsername) : null;
    const handledCommand = schedule || command?.name === 'pause' || command?.name === 'resume' ? command : null;
    // A chat the allowlist does not name still reaches the bot through exactly
    // one command: an admin allowlisting it. Every other command or message
    // from such a chat stays rejected, so the bot never talks where it is not
    // configured.
    const senderIsAdmin =
      message?.from !== undefined &&
      (this.#configStore.current().config.telegram.admins ?? []).includes(message.from.id);
    const adminCommand =
      topics === null && handledCommand !== null && handledCommand.name === 'allowlist' && senderIsAdmin
        ? handledCommand
        : null;
    const allowed = adminCommand !== null || (chat !== undefined && chat.type !== 'channel' && topicAllowed);
    const rejectionReason = allowed
      ? null
      : chat === undefined
        ? 'unsupported_update'
        : chat.type === 'channel'
          ? 'channel'
          : topics === null
            ? 'chat_not_allowed'
            : 'topic_not_allowed';
    const inserted = asRunResult(
      this.#store.orm
        .insert(telegramUpdates)
        .values({
          updateId: BigInt(update.update_id),
          chatId: chatId ?? null,
          chatType: chat?.type ?? null,
          receivedAt: receivedAt.toISOString(),
          allowed,
          rejectionReason,
          rawJson: allowed ? JSON.stringify(update) : null,
        })
        .onConflictDoNothing({ target: telegramUpdates.updateId })
        .run(),
    );
    if (inserted.changes === 0) {
      return {};
    }
    if (adminCommand !== null) {
      // adminCommand implies a message, so the chat is present; record the row
      // like the allowed command path does, so `/status` works before the
      // first stored message arrives.
      if (chat !== undefined && chatId !== undefined) {
        upsertChat(this.#chatDeps, chat, chatId, receivedAt);
      }
      return { command: adminCommand };
    }
    if (!allowed || chat === undefined || chatId === undefined || topics === null) {
      return {};
    }

    if (message === undefined) {
      upsertChat(this.#chatDeps, chat, chatId, receivedAt);
      return {};
    }
    const chatConfig = resolveChatConfig(this.#configStore.current().config, this.#store.orm, {
      hostKind: 'telegram',
      hostChatId: chatId,
    });
    const ignoredUserIds = chatConfig?.ignored_user_ids ?? [];
    const selfIgnoreCommand = handledCommand?.name === 'ignoreme' || handledCommand?.name === 'unignoreme';
    if (
      isIgnoredUser(message, ignoredUserIds) &&
      !selfIgnoreCommand &&
      (edited || !isAsk(message, this.#botUsername))
    ) {
      return {};
    }
    const internalChatId = upsertChat(this.#chatDeps, chat, chatId, receivedAt);
    // Self-ignore controls must remain reachable so an ignored member can opt back in.
    if (command !== null) {
      // A command that catch-up does not replay stops here: it was audited
      // above and must not fall through into the message stream. Live ingestion
      // and the replayable commands return the command for the bot to run.
      return handledCommand === null ? {} : { command: handledCommand };
    }
    const inbound = toInboundMessage(message, {
      bot: { id: this.#botId, username: this.#botUsername },
      internalChatId,
      hostChatId: chatId,
      chatType: chat.type,
      threadId,
      receivedAt,
      edited,
      ignoredUserIds,
    });
    return schedule ? this.#intake.ingest(inbound) : this.#intake.ingestCatchUp(inbound);
  }
}
