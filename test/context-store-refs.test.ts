import { afterAll, describe, expect, test } from 'vitest';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { cleanupContextStoreDirectories, conversationId, fixture, mediaId } from './context-store-fixtures.ts';

afterAll(cleanupContextStoreDirectories);

describe('capability references', () => {
  test('reuses one media ref inside the context and refuses a cross-context lookup', async () => {
    const { store, loaded } = await fixture();
    store.db
      .prepare(
        "INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES ((SELECT id FROM chats LIMIT 1), 99, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
      )
      .run();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: () => loaded.config.agent!.context!.ref_ttl_hours });
    const conversations = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations ORDER BY id').all();
    const first = contexts.open(conversations[0]?.id ?? 0n, 'hash-a');
    const second = contexts.open(conversations[1]?.id ?? 0n, 'hash-a');

    const ref = refs.mediaRef(first.header, mediaId(store, 0), 1n);
    // The same media inside the same context keeps its token, which is what
    // keeps retained history stable across requests.
    expect(refs.mediaRef(first.header, mediaId(store, 0), 1n)).toBe(ref);
    expect(refs.resolve(first.header, ref, 'media')?.mediaId).toBe(mediaId(store, 0));
    // Another conversation must never resolve it.
    expect(refs.resolve(second.header, ref, 'media')).toBeUndefined();

    // Expiry is enforced at resolve time, not only by cleanup.
    const expired = refs.mediaRef(first.header, mediaId(store, 1), 1n, new Date(Date.now() - 100 * 3_600_000));
    expect(refs.resolve(first.header, expired, 'media')).toBeUndefined();
    store.close();
  });

  test('derives reply refs from the Telegram message id and honours the TTL', async () => {
    const { store, loaded } = await fixture();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: () => loaded.config.agent!.context!.ref_ttl_hours });
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    const ref = refs.replyRef(header, '555', { conversationId: conversation, threadId: 7n }, 1n);
    expect(ref).toBe('reply:555');
    expect(refs.resolve(header, ref, 'reply')?.targetThreadId).toBe(7n);
    expect(refs.resolve(header, 'reply:556', 'reply')).toBeUndefined();
    store.close();
  });
});
