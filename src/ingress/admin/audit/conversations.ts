import { and, desc, eq, gte, type SQL, sql } from 'drizzle-orm';
import { telegramHostScope, telegramIdentity } from '../../../store/host-scope.ts';
import {
  chats,
  contextMessages,
  contextRefs,
  conversationContexts,
  conversations,
} from '../../../store/schema/index.ts';
import type { Orm } from '../../../store/store.ts';
import { toolContentView } from '../tool-images.ts';
import {
  type ListQuery,
  MAX_PAYLOAD_PREVIEW_LENGTH,
  optionalFilter,
  type Page,
  parseId,
  parseWindow,
  snapshotCounts,
  snapshotPage,
  timeSnapshot,
} from './shared.ts';

interface ConversationContextRow {
  readonly id: bigint;
  readonly conversation_id: bigint;
  /** NULL on virtual rooms; listConversationContexts is scoped to telegram hosts. */
  readonly telegram_chat_id: bigint | null;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
  readonly head_seq: bigint;
  readonly next_seq: bigint;
  readonly send_count_total: bigint;
  readonly system_prompt_hash: string;
  readonly last_active_at: string;
  readonly last_gc_at: string | null;
  readonly active_invocation_id: bigint | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly message_count: bigint;
}

const CONTEXT_FIELDS = {
  id: conversationContexts.id,
  conversation_id: conversationContexts.conversationId,
  telegram_chat_id: chats.telegramChatId,
  chat_type: chats.type,
  chat_title: chats.title,
  message_thread_id: conversations.messageThreadId,
  head_seq: conversationContexts.headSeq,
  next_seq: conversationContexts.nextSeq,
  send_count_total: conversationContexts.sendCountTotal,
  system_prompt_hash: conversationContexts.systemPromptHash,
  last_active_at: conversationContexts.lastActiveAt,
  last_gc_at: conversationContexts.lastGcAt,
  active_invocation_id: conversationContexts.activeInvocationId,
  created_at: conversationContexts.createdAt,
  updated_at: conversationContexts.updatedAt,
  message_count: sql<bigint>`(SELECT COUNT(*) FROM context_messages cm WHERE cm.context_id = ${conversationContexts.id} AND cm.seq >= ${conversationContexts.headSeq})`,
};

/**
 * Recently active first. The snapshot is taken on `last_active_at`: a context
 * that becomes active after it leaves its old position and counts towards
 * `new_count`, so it reappears at the top once the client takes a new snapshot.
 */
export function listConversationContexts(orm: Orm, query: ListQuery): Page<Record<string, unknown>> {
  const window = parseWindow(query);
  const snapshot = timeSnapshot(orm, conversationContexts.lastActiveAt, conversationContexts.lastActiveAt, query.as_of);
  // Admin surfaces speak Telegram identity, so virtual rows are out of scope here.
  const conditions: SQL[] = [telegramHostScope()];
  const chatId = optionalFilter(query.chat);
  if (chatId !== undefined) {
    conditions.push(eq(chats.telegramChatId, parseId(chatId, 'chat')));
  }
  const count = orm
    .select(snapshotCounts(snapshot))
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(...conditions))
    .get();
  const rows = orm
    .select(CONTEXT_FIELDS)
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(...conditions, snapshot.within))
    .orderBy(desc(conversationContexts.lastActiveAt), desc(conversationContexts.id))
    .limit(window.limit)
    .offset(window.offset)
    .all();
  return snapshotPage(rows.map(contextListItem), count, window, snapshot);
}

export function getConversationContext(orm: Orm, conversationId: bigint): Record<string, unknown> | null {
  const context = orm
    .select(CONTEXT_FIELDS)
    .from(conversationContexts)
    .innerJoin(conversations, eq(conversations.id, conversationContexts.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(telegramHostScope(), eq(conversationContexts.conversationId, conversationId)))
    .get();
  if (context === undefined) {
    return null;
  }
  const messageRows = orm
    .select({
      seq: contextMessages.seq,
      role: contextMessages.role,
      payload_json: contextMessages.payloadJson,
      invocation_id: contextMessages.invocationId,
      is_checkpoint: contextMessages.isCheckpoint,
      send_seq: contextMessages.sendSeq,
      est_tokens: contextMessages.estTokens,
      evicted_at: contextMessages.evictedAt,
      created_at: contextMessages.createdAt,
    })
    .from(contextMessages)
    .where(and(eq(contextMessages.contextId, context.id), gte(contextMessages.seq, context.head_seq)))
    .orderBy(contextMessages.seq)
    .all();
  const refRows = orm
    .select({
      ref: contextRefs.ref,
      kind: contextRefs.kind,
      source_seq: contextRefs.sourceSeq,
      expires_at: contextRefs.expiresAt,
    })
    .from(contextRefs)
    .where(eq(contextRefs.contextId, context.id))
    .orderBy(contextRefs.sourceSeq, contextRefs.ref)
    .all();
  return {
    ...contextListItem(context),
    system_prompt_hash: context.system_prompt_hash,
    created_at: context.created_at,
    updated_at: context.updated_at,
    messages: messageRows.map((row) => ({
      seq: Number(row.seq),
      role: row.role,
      is_checkpoint: row.is_checkpoint,
      send_seq: row.send_seq === null ? null : Number(row.send_seq),
      est_tokens: Number(row.est_tokens),
      invocation_id: row.invocation_id === null ? null : row.invocation_id.toString(),
      evicted_at: row.evicted_at,
      created_at: row.created_at,
      result_content:
        row.role === 'toolResult'
          ? toolContentView(row.payload_json, `/api/contexts/${conversationId}/messages/${row.seq}/images`)
          : null,
      payload_preview: row.payload_json.slice(0, MAX_PAYLOAD_PREVIEW_LENGTH),
      payload_truncated: row.payload_json.length > MAX_PAYLOAD_PREVIEW_LENGTH,
    })),
    refs: refRows.map((row) => ({
      ref: row.ref,
      kind: row.kind,
      source_seq: Number(row.source_seq),
      expires_at: row.expires_at,
    })),
  };
}

function contextListItem(row: ConversationContextRow): Record<string, unknown> {
  return {
    id: row.id.toString(),
    conversation_id: row.conversation_id.toString(),
    telegram_chat_id: telegramIdentity(row.telegram_chat_id, 'chats.telegram_chat_id').toString(),
    chat_type: row.chat_type,
    chat_title: row.chat_title,
    message_thread_id: Number(row.message_thread_id),
    head_seq: Number(row.head_seq),
    next_seq: Number(row.next_seq),
    send_count_total: Number(row.send_count_total),
    message_count: Number(row.message_count),
    last_active_at: row.last_active_at,
    last_gc_at: row.last_gc_at,
    active_invocation_id: row.active_invocation_id === null ? null : row.active_invocation_id.toString(),
  };
}
