import { sql } from 'drizzle-orm';
import { allConfiguredChats, storedChatsForConfig, type RawConfig } from '../../platform/config/index.ts';
import type { BusinessStore } from '../../store/store.ts';

export interface GroupMemoryChatRow {
  readonly id: bigint;
  readonly host_chat_id: bigint;
  readonly host_kind: string;
}

/** Stored identities of the configured, group-memory-enabled Chats, each once. */
export function candidateChats(store: BusinessStore, config: RawConfig): GroupMemoryChatRow[] {
  const candidates: GroupMemoryChatRow[] = [];
  const seen = new Set<bigint>();
  for (const { host, chat: configured } of allConfiguredChats(config)) {
    if (configured.group_memory?.enabled !== true) {
      continue;
    }
    for (const stored of storedChatsForConfig(store, host, BigInt(configured.id))) {
      if (!seen.has(stored.id)) {
        seen.add(stored.id);
        candidates.push({ id: stored.id, host_chat_id: stored.hostChatId, host_kind: host });
      }
    }
  }
  return candidates;
}

/** Foreground Telegram work that must finish before the live lane proceeds. */
export function isChatBusy(store: BusinessStore, chatId: bigint): boolean {
  return (
    store.orm
      .all<{ busy: bigint }>(
        sql`SELECT EXISTS (
            SELECT 1 FROM invocations i
            JOIN conversations v ON v.id = i.conversation_id
            WHERE v.chat_id = ${chatId} AND i.state IN ('queued', 'running')
          ) OR EXISTS (
            SELECT 1 FROM buckets b
            JOIN conversations v ON v.id = b.conversation_id
            WHERE v.chat_id = ${chatId} AND b.state = 'collecting'
          ) AS busy`,
      )
      .at(0)?.busy === 1n
  );
}
