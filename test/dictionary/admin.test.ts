import { expect, test } from 'vitest';
import { adminFixture, draftBody, readJson, request } from './fixtures.ts';

test('admin dictionary CRUD is scope-aware, revision-checked and reports conflicts', async () => {
  const { server, store, cookie } = await adminFixture();
  const headers = { cookie };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  try {
    const first = await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('塑料碗', { aliases: ['碗'] })),
      }),
    );
    expect(first.status).toBe(200);
    const entry = await readJson(first);
    expect(entry.scope).toBe('global');
    expect(entry.chat_id).toBeNull();
    expect(entry.revision).toBe('1');

    await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('塑料碗', { aliases: ['碗'] })),
      }),
    );

    const listed = await readJson(await server.handle(request('/api/dictionary?scope=global', { headers })));
    expect(listed.items).toHaveLength(2);
    expect(listed.conflicts).toHaveLength(2);
    expect(listed.conflicts.every((conflict: { entry_ids: string[] }) => conflict.entry_ids.length === 2)).toBe(true);

    const searched = await readJson(
      await server.handle(request('/api/dictionary?scope=global&search=%E7%A2%97', { headers })),
    );
    expect(searched.items).toHaveLength(2);

    const noRevision = await server.handle(
      request(`/api/dictionary/${entry.id}`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('塑料碗', { aliases: ['碗'], definition: 'edited' })),
      }),
    );
    expect(noRevision.status).toBe(400);
    expect(await readJson(noRevision)).toMatchObject({ error: 'revision_required' });

    const updated = await server.handle(
      request(`/api/dictionary/${entry.id}`, {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': entry.revision },
        body: JSON.stringify(draftBody('塑料碗', { aliases: ['碗'], definition: 'edited' })),
      }),
    );
    expect(updated.status).toBe(200);
    const changed = await readJson(updated);
    expect(changed.revision).toBe('2');

    const stale = await server.handle(
      request(`/api/dictionary/${entry.id}`, {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': entry.revision },
        body: JSON.stringify(draftBody('塑料碗', { aliases: [], definition: 'stale' })),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'dictionary_conflict' });

    const group = await readJson(
      await server.handle(
        request('/api/dictionary', {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(draftBody('运维', { scope: 'group', chat_id: '123456789' })),
        }),
      ),
    );
    expect(group.scope).toBe('group');
    expect(group.chat_id).toBe('123456789');
    const globalView = await readJson(await server.handle(request('/api/dictionary?scope=global', { headers })));
    expect(globalView.items.some((item: { id: string }) => item.id === group.id)).toBe(false);
    const groupView = await readJson(
      await server.handle(request('/api/dictionary?scope=group&chat=123456789', { headers })),
    );
    expect(groupView.items).toHaveLength(1);
    expect(groupView.conflicts).toHaveLength(2);

    const missingChat = await server.handle(request('/api/dictionary?scope=group', { headers }));
    expect(missingChat.status).toBe(400);

    // A group draft without a chat and a global draft with one are fast-fail
    // 400s, not an uncaught `BigInt('')` 500 or a silently ignored chat.
    const groupNoChat = await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('缺少群', { scope: 'group', chat_id: null })),
      }),
    );
    expect(groupNoChat.status).toBe(400);
    expect(await readJson(groupNoChat)).toMatchObject({ error: 'invalid_body' });
    const globalWithChat = await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('全局带群', { scope: 'global', chat_id: '123456789' })),
      }),
    );
    expect(globalWithChat.status).toBe(400);
    expect(await readJson(globalWithChat)).toMatchObject({ error: 'invalid_body' });
    // A malformed chat ID is refused by the schema before it reaches `BigInt`.
    const badChat = await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(draftBody('坏群', { scope: 'group', chat_id: '' })),
      }),
    );
    expect(badChat.status).toBe(400);

    const removed = await server.handle(
      request(`/api/dictionary/${entry.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'if-match': changed.revision },
      }),
    );
    expect(removed.status).toBe(200);
    const remaining = await readJson(await server.handle(request('/api/dictionary?scope=global', { headers })));
    expect(remaining.items).toHaveLength(1);

    const unauth = await server.handle(request('/api/dictionary?scope=global'));
    expect(unauth.status).toBe(401);
    const crossOrigin = await server.handle(
      request('/api/dictionary', {
        method: 'POST',
        headers: { ...jsonHeaders, origin: 'http://evil.test' },
        body: JSON.stringify(draftBody('nope')),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  } finally {
    store.close();
  }
});

test('admin settings round-trip the global mode and a per-chat override', async () => {
  const { server, store, cookie } = await adminFixture();
  const headers = { cookie };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  try {
    const baseline = await readJson(await server.handle(request('/api/dictionary/settings', { headers })));
    expect(baseline.injection_mode).toBe('on_demand');
    expect(baseline.override_mode).toBeNull();
    expect(baseline.effective_mode).toBe('on_demand');

    const written = await server.handle(
      request('/api/dictionary/settings', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': baseline.revision },
        body: JSON.stringify({ injection_mode: 'aggressive' }),
      }),
    );
    expect(written.status).toBe(200);
    expect(await readJson(written)).toMatchObject({ injection_mode: 'aggressive', effective_mode: 'aggressive' });

    const group = await readJson(await server.handle(request('/api/dictionary/settings?chat=123456789', { headers })));
    expect(group.override_mode).toBeNull();
    expect(group.effective_mode).toBe('aggressive');

    const overridden = await server.handle(
      request('/api/dictionary/settings?chat=123456789', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': group.revision },
        body: JSON.stringify({ injection_mode: 'off' }),
      }),
    );
    expect(overridden.status).toBe(200);
    const overriddenBody = await readJson(overridden);
    expect(overriddenBody).toMatchObject({ override_mode: 'off', effective_mode: 'off' });

    const clearResult = await server.handle(
      request('/api/dictionary/settings?chat=123456789', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': overriddenBody.revision },
        body: JSON.stringify({ injection_mode: null }),
      }),
    );
    expect(clearResult.status).toBe(200);
    expect(await readJson(clearResult)).toMatchObject({ override_mode: null, effective_mode: 'aggressive' });

    const stale = await server.handle(
      request('/api/dictionary/settings', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': baseline.revision },
        body: JSON.stringify({ injection_mode: 'off' }),
      }),
    );
    expect(stale.status).toBe(409);

    const current = await readJson(await server.handle(request('/api/dictionary/settings', { headers })));
    const badMode = await server.handle(
      request('/api/dictionary/settings', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': current.revision },
        body: JSON.stringify({ injection_mode: 'bogus' }),
      }),
    );
    expect(badMode.status).toBe(400);

    const unknownChat = await server.handle(
      request('/api/dictionary/settings?chat=999', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': current.revision },
        body: JSON.stringify({ injection_mode: 'off' }),
      }),
    );
    expect(unknownChat.status).toBe(404);
  } finally {
    store.close();
  }
});
