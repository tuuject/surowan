import { sql } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import { telegramChatIdentity } from '../../store/chat-identity.ts';
import type { BusinessStore } from '../../store/store.ts';

export interface GroupMemoryChatRow {
  readonly id: bigint;
  readonly telegram_chat_id: bigint;
}

/** Stored identities of the configured, group-memory-enabled Chats, each once. */
export function candidateChats(store: BusinessStore, config: RawConfig): GroupMemoryChatRow[] {
  const candidates: GroupMemoryChatRow[] = [];
  const seen = new Set<bigint>();
  for (const configured of config.telegram.chats) {
    if (configured.group_memory?.enabled !== true) {
      continue;
    }
    const identities = telegramChatIdentity(store, [BigInt(configured.id)]);
    const rows = store.orm.all<GroupMemoryChatRow>(
      sql`SELECT id, telegram_chat_id FROM chats
          WHERE host_kind = 'telegram' AND telegram_chat_id IN (${sql.join(
            identities.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        candidates.push(row);
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
