import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { invocations } from '../../store/schema/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { ConversationContextSummary } from './types.ts';

interface ConversationContextSummaryRow {
  readonly conversation_id: bigint;
  readonly telegram_chat_id: bigint;
  readonly message_thread_id: bigint;
  readonly head_seq: bigint;
  readonly next_seq: bigint;
  readonly send_count_total: bigint;
  readonly message_count: bigint;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: bigint | null;
}

/** Read-only projection used by `/status` and the Admin Panel. */
export function listConversationContexts(
  store: BusinessStore,
  filter: { readonly conversationId?: bigint; readonly telegramChatId?: bigint; readonly limit?: number } = {},
): ConversationContextSummary[] {
  const conditions: SQL[] = [];
  if (filter.conversationId !== undefined) {
    conditions.push(sql`cc.conversation_id = ${filter.conversationId}`);
  }
  if (filter.telegramChatId !== undefined) {
    conditions.push(sql`c.telegram_chat_id = ${filter.telegramChatId}`);
  }
  const where = conditions.length === 0 ? sql`1 = 1` : sql.join(conditions, sql` AND `);
  return store.orm
    .all<ConversationContextSummaryRow>(
      sql`SELECT cc.conversation_id, c.telegram_chat_id, v.message_thread_id, cc.head_seq, cc.next_seq,
                 cc.send_count_total, cc.last_active_at, cc.last_gc_at, cc.active_invocation_id,
                 (SELECT COUNT(*) FROM context_messages cm
                   WHERE cm.context_id = cc.id AND cm.seq >= cc.head_seq) AS message_count
          FROM conversation_contexts cc
          JOIN conversations v ON v.id = cc.conversation_id
          JOIN chats c ON c.id = v.chat_id
          WHERE ${where}
          ORDER BY cc.last_active_at DESC, cc.id DESC
          LIMIT ${BigInt(filter.limit ?? 50)}`,
    )
    .map((row) => ({
      conversationId: row.conversation_id,
      telegramChatId: row.telegram_chat_id,
      messageThreadId: row.message_thread_id,
      headSeq: row.head_seq,
      nextSeq: row.next_seq,
      sendCountTotal: row.send_count_total,
      messageCount: row.message_count,
      lastActiveAt: row.last_active_at,
      lastGcAt: row.last_gc_at,
      activeInvocationId: row.active_invocation_id,
    }));
}

/**
 * The running invocation of a Conversation, if any. The attach path injects a
 * due bucket into it; at most one can exist (one_running_invocation_per_conversation).
 */
export function runningInvocationForConversation(store: BusinessStore, conversationId: bigint): bigint | undefined {
  const row = store.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(and(eq(invocations.conversationId, conversationId), eq(invocations.state, 'running')))
    .orderBy(desc(invocations.id))
    .limit(1)
    .get();
  return row?.id;
}
