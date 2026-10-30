import { inArray, or } from 'drizzle-orm';
import { chatMigrations } from './schema/index.ts';
import type { BusinessStore } from './store.ts';

/** All predecessors and successors of a Telegram migration, including the supplied IDs. */
export function telegramChatIdentity(store: BusinessStore, telegramChatIds: readonly bigint[]): bigint[] {
  const ids = new Set(telegramChatIds);
  let frontier = [...ids];
  while (frontier.length > 0) {
    const migrations = store.orm
      .select({ oldChatId: chatMigrations.oldChatId, newChatId: chatMigrations.newChatId })
      .from(chatMigrations)
      .where(or(inArray(chatMigrations.oldChatId, frontier), inArray(chatMigrations.newChatId, frontier)))
      .all();
    frontier = [];
    for (const migration of migrations) {
      for (const id of [migration.oldChatId, migration.newChatId]) {
        if (!ids.has(id)) {
          ids.add(id);
          frontier.push(id);
        }
      }
    }
  }
  return [...ids];
}
