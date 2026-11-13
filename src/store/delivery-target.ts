import { eq, sql } from 'drizzle-orm';
import type { RawConfig } from '../platform/config/index.ts';
import { completeAgentSettings, resolveAgentSettings } from '../platform/config/resolve.ts';
import { rooms } from './schema/index.ts';
import { isChatPaused, type Orm, resolveChatConfig } from './store.ts';

/** Where an injected task round would land: one Conversation and its Chat. */
export interface DeliveryTarget {
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly hostKind: string;
  /** Null for a Playground room, which has no Telegram identity. */
  readonly telegramChatId: bigint | null;
  readonly messageThreadId: bigint;
}

export type DeliveryBlockReason = 'chat_removed' | 'agent_unconfigured' | 'chat_paused' | 'topic_removed';

export function deliveryTarget(orm: Orm, conversationId: bigint): DeliveryTarget | undefined {
  const row = orm
    .all<{
      chat_id: bigint;
      host_kind: string;
      telegram_chat_id: bigint | null;
      message_thread_id: bigint;
    }>(
      sql`SELECT v.chat_id, c.host_kind, c.telegram_chat_id, v.message_thread_id
          FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ${conversationId}`,
    )
    .at(0);
  return row === undefined
    ? undefined
    : {
        conversationId,
        chatId: row.chat_id,
        hostKind: row.host_kind,
        telegramChatId: row.telegram_chat_id,
        messageThreadId: row.message_thread_id,
      };
}

/**
 * Why a Conversation cannot take a task round right now, or undefined when it
 * can. Task receipts and recurring alarms share this one rule: a removed or
 * paused Chat, a Topic outside the allowlist or an incomplete agent identity
 * stop delivery, while the work itself stays.
 */
export function deliveryBlockReason(
  orm: Orm,
  config: RawConfig,
  target: DeliveryTarget,
): DeliveryBlockReason | undefined {
  // A room has no Telegram chat entry, pause or topic list; it is a valid
  // destination for as long as the room itself exists.
  if (target.hostKind === 'playground') {
    const room = orm.select({ chatId: rooms.chatId }).from(rooms).where(eq(rooms.chatId, target.chatId)).get();
    return room === undefined ? 'chat_removed' : undefined;
  }
  if (target.telegramChatId === null) {
    return 'chat_removed';
  }
  const chatConfig = resolveChatConfig(config, orm, target.telegramChatId);
  if (chatConfig === undefined) {
    return 'chat_removed';
  }
  // A completion receipt is delivered by an invocation, so it waits for the
  // same complete identity triple as a message bucket.
  if (completeAgentSettings(resolveAgentSettings(config, chatConfig)) === undefined) {
    return 'agent_unconfigured';
  }
  if (isChatPaused(orm, target.chatId)) {
    return 'chat_paused';
  }
  if (
    chatConfig.topic_ids !== undefined &&
    !chatConfig.topic_ids.some((topicId) => BigInt(topicId) === target.messageThreadId)
  ) {
    return 'topic_removed';
  }
  return undefined;
}
