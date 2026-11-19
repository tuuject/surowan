/**
 * `candidateChats` resolves each configured entry to its stored chat rows
 * under that entry's own host — including a Telegram supergroup that migrated
 * away from the id the configuration was authored against.
 */

import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';

import { candidateChats } from '../../src/context/group-memory/chats.ts';
import { groupMemoryFixture } from './fixtures.ts';

test('a configured entry reaches the stored row of its migrated successor chat', async () => {
  // The extra configured Chat (222222222) migrated to 333333333 and the pair
  // is recorded in chat_migrations: one identity, so both stored rows match.
  const f = await groupMemoryFixture({ extraChatIds: [222_222_222] });
  try {
    f.store.orm.run(
      sql`INSERT INTO chat_migrations(old_chat_id, new_chat_id, received_at)
          VALUES (222222222, 333333333, '2026-01-01T00:00:00.000Z')`,
    );
    f.store.orm.run(
      sql`INSERT INTO chats(id, host_kind, host_chat_id, canonical_chat_id, type, title, updated_at)
          VALUES (9, 'telegram', 333333333, 333333333, 'supergroup', 'Migrated group', '2026-01-01T00:00:00.000Z')`,
    );
    const rows = candidateChats(f.store, f.loaded.config);
    expect(
      rows
        .map((row) => ({ id: row.id, host_chat_id: row.host_chat_id, host_kind: row.host_kind }))
        .sort((a, b) => Number(a.id - b.id)),
    ).toEqual([
      { id: 1n, host_chat_id: 123456789n, host_kind: 'telegram' },
      { id: 2n, host_chat_id: 222222222n, host_kind: 'telegram' },
      { id: 9n, host_chat_id: 333333333n, host_kind: 'telegram' },
    ]);
  } finally {
    await f.close();
  }
});

test('a disabled configured entry contributes no stored row', async () => {
  const f = await groupMemoryFixture({ enabled: false });
  try {
    expect(candidateChats(f.store, f.loaded.config)).toEqual([]);
  } finally {
    await f.close();
  }
});
