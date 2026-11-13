import { sql } from 'drizzle-orm';
import type { RawConfig } from '../../../platform/config/index.ts';
import { deliveryBlockReason } from '../../../store/delivery-target.ts';
import { type Orm, resolveChatConfig } from '../../../store/store.ts';

/**
 * One Conversation a recurring alarm may target. `conversation_id` is null for
 * an allowlisted Topic nobody has written in yet; creating an alarm there
 * creates the Conversation row.
 */
export interface RecurringTargetOption {
  readonly chat_id: string;
  readonly message_thread_id: string;
  readonly conversation_id: string | null;
  readonly host_kind: string;
  readonly telegram_chat_id: string | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  /** False while the target cannot receive messages; `reason` says why. */
  readonly available: boolean;
  readonly reason: string | null;
}

interface ChatRow {
  readonly id: bigint;
  readonly host_kind: string;
  readonly telegram_chat_id: bigint | null;
  readonly type: string;
  readonly title: string | null;
}

/**
 * Every target the panel offers: the Conversations of configured Telegram
 * Chats the bot has seen (for a Chat with a Topic allowlist, exactly the
 * allowlisted Topics) and every Playground room.
 */
export function listRecurringTargets(orm: Orm, config: RawConfig): RecurringTargetOption[] {
  const chats = orm.all<ChatRow>(
    sql`SELECT id, host_kind, telegram_chat_id, type, title FROM chats
        WHERE (host_kind = 'telegram' AND telegram_chat_id IS NOT NULL)
           OR (host_kind = 'playground' AND id IN (SELECT chat_id FROM rooms))
        ORDER BY host_kind DESC, id`,
  );
  const conversations = orm.all<{ id: bigint; chat_id: bigint; message_thread_id: bigint }>(
    sql`SELECT id, chat_id, message_thread_id FROM conversations ORDER BY chat_id, message_thread_id`,
  );
  const options: RecurringTargetOption[] = [];
  for (const chat of chats) {
    let threads: bigint[];
    if (chat.host_kind === 'telegram') {
      const chatConfig =
        chat.telegram_chat_id === null ? undefined : resolveChatConfig(config, orm, chat.telegram_chat_id);
      if (chatConfig === undefined) {
        continue;
      }
      threads =
        chatConfig.topic_ids === undefined
          ? conversations.filter((row) => row.chat_id === chat.id).map((row) => row.message_thread_id)
          : chatConfig.topic_ids.map((topic) => BigInt(topic));
      if (threads.length === 0) {
        threads = [0n];
      }
    } else {
      threads = [0n];
    }
    for (const thread of threads) {
      const conversation = conversations.find((row) => row.chat_id === chat.id && row.message_thread_id === thread);
      const reason =
        deliveryBlockReason(orm, config, {
          conversationId: conversation?.id ?? 0n,
          chatId: chat.id,
          hostKind: chat.host_kind,
          telegramChatId: chat.telegram_chat_id,
          messageThreadId: thread,
        }) ?? null;
      options.push({
        chat_id: chat.id.toString(),
        message_thread_id: thread.toString(),
        conversation_id: conversation?.id.toString() ?? null,
        host_kind: chat.host_kind,
        telegram_chat_id: chat.telegram_chat_id?.toString() ?? null,
        chat_type: chat.type,
        chat_title: chat.title,
        available: reason === null,
        reason,
      });
    }
  }
  return options;
}
