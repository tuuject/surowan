import { afterAll, expect, test } from 'vitest';
import { purgeExpiredData } from '../src/store/store.ts';
import { chats, conversations, memories } from '../src/store/schema.ts';
import { deleteMemory, updateMemory } from '../src/ingress/admin/memory-admin.ts';
import { AdminQueryError } from '../src/ingress/admin/audit.ts';
import { eq } from 'drizzle-orm';
import { MemoryStore } from '../src/context/memory.ts';
import { cleanupDirectories, fixture } from './memory-helpers.ts';

afterAll(cleanupDirectories);

test('memories persist per conversation, expire by TTL, and purge expired rows', async () => {
  const { store, loaded, conversationId } = await fixture();
  try {
    const memory = new MemoryStore(store.orm);
    const now = new Date('2026-08-15T12:00:00.000Z');
    const first = memory.add(conversationId, 'remember one', 86_400, now);
    expect(first.id).toMatch(/^mem_[a-f0-9]{32}$/);
    expect(first.expiresAt).toBe('2026-08-16T12:00:00.000Z');

    const second = memory.add(conversationId, 'remember two', 3_600, new Date('2026-08-15T13:00:00.000Z'));
    expect(second.expiresAt).toBe('2026-08-15T14:00:00.000Z');
    const active = memory.listActive(conversationId, new Date('2026-08-15T13:30:00.000Z'));
    expect(active.map((entry) => entry.id)).toEqual([first.id, second.id]);

    // TTL expiry hides rows and opportunistic writes purge them.
    const later = new Date('2026-08-15T14:00:01.000Z');
    expect(memory.listActive(conversationId, later).map((entry) => entry.id)).toEqual([first.id]);
    memory.add(conversationId, 'third', 86_400, later);
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(2n);

    // Cross-conversation delete is a no-op and leaks nothing.
    const otherConversation = conversationId + 1n;
    expect(memory.remove(first.id, otherConversation, later)).toBe(false);
    expect(
      store.db.prepare<[string], { count: bigint }>('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(first.id)
        ?.count,
    ).toBe(1n);
    expect(memory.remove(first.id, conversationId, later)).toBe(true);
    expect(
      store.db.prepare<[string], { count: bigint }>('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(first.id)
        ?.count,
    ).toBe(0n);

    // purgeExpiredData also cleans expired rows during retention purging.
    memory.add(conversationId, 'ephemeral', 60, new Date('2026-08-15T15:00:00.000Z'));
    purgeExpiredData(store.orm, loaded.config, new Date('2026-08-15T15:00:30.000Z'));
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM memories WHERE content = 'ephemeral'")
        .get()?.count,
    ).toBe(1n);
    purgeExpiredData(store.orm, loaded.config, new Date('2026-08-15T15:01:01.000Z'));
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM memories WHERE content = 'ephemeral'")
        .get()?.count,
    ).toBe(0n);
  } finally {
    store.close();
  }
});

test('the Telegram memory admin cannot change or delete a virtual room memory', async () => {
  const { store, conversationId } = await fixture();
  try {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const memory = new MemoryStore(store.orm);
    store.orm
      .insert(chats)
      .values({ id: 900n, hostKind: 'playground', type: 'virtual', title: 'room', updatedAt: now.toISOString() })
      .run();
    const room = store.orm
      .insert(conversations)
      .values({ chatId: 900n, messageThreadId: 0n, createdAt: now.toISOString(), updatedAt: now.toISOString() })
      .returning({ id: conversations.id })
      .get()!;
    const virtual = memory.add(room.id, 'room only', 86_400, now);
    const telegram = memory.add(conversationId, 'telegram', 86_400, now);

    const notFound = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof AdminQueryError && error.status === 404;
      }
      return false;
    };
    expect(notFound(() => updateMemory(store.orm, virtual.id, { content: 'changed' }, 7, now))).toBe(true);
    expect(notFound(() => deleteMemory(store.orm, virtual.id))).toBe(true);
    const kept = store.orm.select().from(memories).where(eq(memories.id, virtual.id)).get();
    expect(kept?.content).toBe('room only');
    expect(kept?.updatedAt).toBe(now.toISOString());

    // Telegram memories are still managed as before.
    expect(updateMemory(store.orm, telegram.id, { content: 'edited' }, 7, now).content).toBe('edited');
    deleteMemory(store.orm, telegram.id);
    expect(store.orm.select().from(memories).where(eq(memories.id, telegram.id)).get()).toBeUndefined();
  } finally {
    store.close();
  }
});
