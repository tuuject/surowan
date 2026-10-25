import { and, eq, sql } from 'drizzle-orm';
import type { ConversationContextStore } from '../../context/store.ts';
import { chatPause, conversationContextCutoffs, conversations } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { ConversationRuntime } from '../conversation-runtime.ts';
import type { BucketScheduler } from '../scheduler/index.ts';

export interface BotCommandSessionDeps {
  readonly store: BusinessStore;
  readonly scheduler: BucketScheduler;
  readonly contexts: ConversationContextStore;
  readonly conversationRuntime: ConversationRuntime | undefined;
  internalChatId(telegramChatId: bigint): bigint | null;
}

export function pauseChat(deps: BotCommandSessionDeps, telegramChatId: bigint, now: Date): string {
  const chatId = deps.internalChatId(telegramChatId);
  if (chatId === null) {
    throw new Error(`Chat ${telegramChatId} has no stored row`);
  }
  const timestamp = now.toISOString();
  deps.store.transaction(() => {
    deps.store.orm
      .insert(chatPause)
      .values({ chatId, pausedAt: timestamp })
      .onConflictDoUpdate({ target: chatPause.chatId, set: { pausedAt: timestamp } })
      .run();
    deps.store.orm.run(
      sql`UPDATE buckets SET state = 'expired', error_code = 'chat_paused', finished_at = ${timestamp}, updated_at = ${timestamp}
           WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})
             AND (state IN ('collecting', 'queued') OR (state = 'running' AND id IN (
               SELECT ib.bucket_id FROM invocation_buckets ib JOIN invocations i ON i.id = ib.invocation_id
               WHERE i.state = 'running' AND ib.injected_at IS NULL AND ib.bucket_id <> i.bucket_id
             )))`,
    );
    // Suppress only queued deliveries. Running work settles normally after abort.
    deps.store.orm.run(
      sql`UPDATE task_receipts SET state = 'suppressed', cancelled_at = ${timestamp}, cancel_reason = 'chat_paused', admin_cancelled = 0, updated_at = ${timestamp}
           WHERE state = 'claimed' AND invocation_id IN (
             SELECT i.id FROM invocations i
             JOIN conversations v ON v.id = i.conversation_id
             WHERE i.state = 'queued' AND v.chat_id = ${chatId}
           )`,
    );
    deps.store.orm.run(
      sql`UPDATE invocations SET state = 'aborted', completion_reason = 'chat_paused', finished_at = ${timestamp}
           WHERE state = 'queued' AND conversation_id IN (SELECT id FROM conversations WHERE chat_id = ${chatId})`,
    );
  });
  deps.scheduler.pauseChat(chatId);
  return '已暂停本群互动，发送 /resume 可恢复。';
}

export function resumeChat(deps: BotCommandSessionDeps, telegramChatId: bigint): string {
  const chatId = deps.internalChatId(telegramChatId);
  if (chatId === null) {
    throw new Error(`Chat ${telegramChatId} has no stored row`);
  }
  deps.store.orm.delete(chatPause).where(eq(chatPause.chatId, chatId)).run();
  return '已恢复本群互动。';
}

// Cuts one Conversation's agent-session history at the command message itself:
// the cutoff row stores the command's Telegram message ID, so the command and
// everything before it in the same topic drop out of future invocations. Other
// topics of the chat keep their history, matching the Context clear below.
// Replying is safe even when this chat has never triggered the agent.
//
// The continuous Conversation Context is cleared in the same step. Without
// that, the command would only trim the rendered history while the model kept
// seeing everything through its retained transcript.
export function cutTopic(
  deps: BotCommandSessionDeps,
  telegramChatId: bigint,
  messageId: bigint | undefined,
  threadId: bigint | undefined,
  now: Date,
): string {
  if (messageId === undefined) {
    throw new Error(`cut_topic command is missing its Telegram message ID`);
  }
  const chatId = deps.internalChatId(telegramChatId);
  if (chatId === null) {
    throw new Error(`Chat ${telegramChatId} has no stored row`);
  }
  const timestamp = now.toISOString();
  const conversationId = deps.store.orm
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.chatId, chatId), eq(conversations.messageThreadId, threadId ?? 0n)))
    .get()?.id;
  // No Conversation row means this topic has stored nothing yet, so there is
  // no history to cut and no Context to clear.
  if (conversationId !== undefined) {
    // The cutoff only moves forward: a late or re-delivered older command must
    // not bring back history a newer cut already removed.
    deps.store.orm
      .insert(conversationContextCutoffs)
      .values({ conversationId, telegramMessageId: messageId, createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: conversationContextCutoffs.conversationId,
        set: {
          telegramMessageId: sql`MAX(${conversationContextCutoffs.telegramMessageId}, excluded.telegram_message_id)`,
          updatedAt: timestamp,
        },
      })
      .run();
    // Interrupt before clearing. A run in flight holds the pre-cut transcript and
    // a header snapshot taken at its start, so it would keep answering from the
    // history just cut and could write a lower `head_seq` back over the cut.
    deps.scheduler.abortConversation(conversationId);
    const header = deps.contexts.header(conversationId);
    if (header !== undefined) {
      deps.contexts.clear(header, now);
      console.log(
        JSON.stringify({
          event: 'context_cleared',
          conversation_id: conversationId.toString(),
          chat_id: telegramChatId.toString(),
          head_seq: header.headSeq.toString(),
          at: timestamp,
        }),
      );
    }
    // Drop the in-memory transcript too; the canonical history is the truth.
    deps.conversationRuntime?.forget(conversationId);
  }
  return '已切掉此消息及更早的历史，并清空该话题的连续 Context。';
}
