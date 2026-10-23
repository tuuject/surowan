/**
 * Admin context API: conversation contexts stay readable and read-only.
 */
import { expect, test } from 'vitest';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie, textUpdate } from './admin-fixtures.ts';

test('context API exposes conversation contexts read-only', async () => {
  const { store, server, configStore } = await fixture();
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-03-02T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'context audit'), received);

    const conversation = store.db
      .prepare<[], { id: bigint; chat_id: bigint }>('SELECT id, chat_id FROM conversations')
      .get();
    if (conversation === undefined) {
      throw new Error('Expected the conversation row');
    }
    const iso = received.toISOString();
    const olderIso = new Date(received.getTime() - 60_000).toISOString();
    const expiresIso = new Date(received.getTime() + 3_600_000).toISOString();
    store.db
      .prepare('INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 7, ?, ?)')
      .run(conversation.chat_id, iso, iso);
    const second = store.db
      .prepare<[], { id: bigint }>('SELECT id FROM conversations WHERE message_thread_id = 7')
      .get();
    if (second === undefined) {
      throw new Error('Expected the second conversation row');
    }
    store.db
      .prepare(
        "INSERT INTO conversation_contexts(conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, last_gc_at, created_at, updated_at) VALUES (?, 2, 4, 1, 'prompt-hash', ?, NULL, ?, ?)",
      )
      .run(conversation.id, iso, iso, iso);
    store.db
      .prepare(
        "INSERT INTO conversation_contexts(conversation_id, head_seq, next_seq, send_count_total, system_prompt_hash, last_active_at, created_at, updated_at) VALUES (?, 1, 1, 0, 'other-hash', ?, ?, ?)",
      )
      .run(second.id, olderIso, olderIso, olderIso);
    const context = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversation_contexts ORDER BY id').get();
    if (context === undefined) {
      throw new Error('Expected the context row');
    }
    // seq 1 sits below head_seq: it is soft-evicted and must stay out of the detail payload.
    store.db
      .prepare(
        'INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 1, \'user\', \'{"role":"user","text":"evicted"}\', NULL, 1, NULL, 3, ?, ?)',
      )
      .run(context.id, iso, iso);
    const longPayload = `{"role":"user","text":"${'x'.repeat(2_500)}"}`;
    store.db
      .prepare(
        "INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 2, 'user', ?, NULL, 1, NULL, 12, NULL, ?)",
      )
      .run(context.id, longPayload, iso);
    store.db
      .prepare(
        "INSERT INTO context_messages(context_id, seq, role, payload_json, invocation_id, is_checkpoint, send_seq, est_tokens, evicted_at, created_at) VALUES (?, 3, 'assistant', ?, NULL, 0, 1, 4, NULL, ?)",
      )
      .run(context.id, JSON.stringify({ role: 'assistant', text: 'ok' }), iso);
    store.db
      .prepare(
        "INSERT INTO context_refs(context_id, ref, kind, source_seq, media_id, sticker_file_id, target_conversation_id, target_thread_id, expires_at, created_at) VALUES (?, 'cap-1', 'media', 2, NULL, NULL, NULL, NULL, ?, ?)",
      )
      .run(context.id, expiresIso, iso);

    const unauthenticated = await server.handle(request('/api/contexts'));
    expect(unauthenticated.status).toBe(401);

    const cookie = sessionCookie(
      await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD })),
    );
    const headers = { cookie };

    const list = await readJson(await server.handle(request('/api/contexts', { headers })));
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({
      conversation_id: conversation.id.toString(),
      telegram_chat_id: '123456789',
      chat_type: 'private',
      chat_title: null,
      message_thread_id: 0,
      head_seq: 2,
      next_seq: 4,
      send_count_total: 1,
      message_count: 2,
      last_active_at: iso,
      last_gc_at: null,
      active_invocation_id: null,
    });
    expect(list.items[1]).toMatchObject({
      conversation_id: second.id.toString(),
      message_thread_id: 7,
      head_seq: 1,
      next_seq: 1,
      message_count: 0,
      last_active_at: olderIso,
    });

    const firstPage = await readJson(await server.handle(request('/api/contexts?limit=1', { headers })));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].conversation_id).toBe(conversation.id.toString());
    expect(typeof firstPage.next_cursor).toBe('string');
    const secondPage = await readJson(
      await server.handle(
        request(`/api/contexts?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`, { headers }),
      ),
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].conversation_id).toBe(second.id.toString());
    expect(secondPage.next_cursor).toBeNull();

    const byChat = await readJson(await server.handle(request('/api/contexts?chat=123456789', { headers })));
    expect(byChat.items).toHaveLength(2);
    expect((await readJson(await server.handle(request('/api/contexts?chat=999', { headers })))).items).toHaveLength(0);
    // `search` and `conversation` are not context filters; unknown parameters are ignored.
    const unfiltered = await readJson(
      await server.handle(request(`/api/contexts?search=absent-title&conversation=${second.id}`, { headers })),
    );
    expect(unfiltered.items).toHaveLength(2);
    const badChat = await server.handle(request('/api/contexts?chat=abc', { headers }));
    expect(badChat.status).toBe(400);
    expect(await readJson(badChat)).toMatchObject({ error: 'invalid_chat' });
    const badCursor = await server.handle(request('/api/contexts?cursor=bad', { headers }));
    expect(badCursor.status).toBe(400);
    expect(await readJson(badCursor)).toMatchObject({ error: 'invalid_cursor' });
    const badLimit = await server.handle(request('/api/contexts?limit=0', { headers }));
    expect(badLimit.status).toBe(400);
    expect(await readJson(badLimit)).toMatchObject({ error: 'invalid_limit' });

    const detail = await readJson(await server.handle(request(`/api/contexts/${conversation.id}`, { headers })));
    expect(detail).toMatchObject({
      conversation_id: conversation.id.toString(),
      system_prompt_hash: 'prompt-hash',
      head_seq: 2,
      message_count: 2,
    });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]).toMatchObject({
      seq: 2,
      role: 'user',
      is_checkpoint: true,
      send_seq: null,
      est_tokens: 12,
      invocation_id: null,
      evicted_at: null,
    });
    expect(detail.messages[0].payload_preview).toHaveLength(2_000);
    expect(detail.messages[0].payload_truncated).toBe(true);
    expect(detail.messages[1]).toMatchObject({
      seq: 3,
      role: 'assistant',
      is_checkpoint: false,
      send_seq: 1,
      payload_truncated: false,
    });
    expect(detail.refs).toEqual([{ ref: 'cap-1', kind: 'media', source_seq: 2, expires_at: expiresIso }]);

    const missing = await server.handle(request('/api/contexts/999999', { headers }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
    const badId = await server.handle(request('/api/contexts/not-a-number', { headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });
    const writeAttempt = await server.handle(post('/api/contexts', {}, cookie));
    expect(writeAttempt.status).toBe(405);
  } finally {
    store.close();
  }
});
