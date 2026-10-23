import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, login, post, put, readJson, request } from './prompts-admin-fixtures.ts';

test('prompt save applies the next invocation, records versions, diffs and restores', async () => {
  const { store, server, configStore, directory } = await fixture();
  try {
    const unauthenticated = await server.handle(request('/api/prompts/versions?scope=global'));
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(server);
    const startHash = configStore.current().hash;

    // API keys never reach the prompt surface.
    const key = await readJson(await server.handle(post('/api/api-keys', { name: 'probe' }, cookie)));
    const bearer = await server.handle(
      request('/api/prompts/versions?scope=global', { headers: { authorization: `Bearer ${key.key as string}` } }),
    );
    expect(bearer.status).toBe(403);

    const view = await readJson(
      await server.handle(request('/api/prompts/global?source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('Participate safely.');
    expect(view.content_hash).toHaveLength(64);

    const withoutMatch = await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie));
    expect(withoutMatch.status).toBe(400);
    expect(await readJson(withoutMatch)).toMatchObject({ error: 'revision_required' });

    const stale = await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie, 'deadbeef'));
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'prompt_conflict' });

    let versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.retained).toBe(100);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({ seq: '1', source: 'external', created_by: null });
    const v1 = versions.items[0].id;

    const saved = await readJson(
      await server.handle(
        put('/api/prompts/global', { prompt: 'New persona.', note: 'tighten tone' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({
      status: 'saved',
      affected_running: 0,
      context_rebuild: true,
      applied: ['agent.system_prompt_file'],
      restart_required: [],
    });
    expect(saved.version).toMatchObject({ seq: '2', source: 'panel', created_by: 'owner', note: 'tighten tone' });
    expect(await readFile(join(directory, 'agent-system-prompt.md'), 'utf8')).toBe('New persona.');
    expect(configStore.current().hash).not.toBe(startHash);
    const active = await readJson(
      await server.handle(request('/api/prompts/global?source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('New persona.');

    // Saving the file's current content back changes nothing.
    const savedView = await readJson(
      await server.handle(request('/api/prompts/global?source=file', { headers: { cookie } })),
    );
    const unchanged = await readJson(
      await server.handle(put('/api/prompts/global', { prompt: 'New persona.' }, cookie, savedView.content_hash)),
    );
    expect(unchanged).toMatchObject({ status: 'unchanged' });

    // Restoring version 1 appends a rollback version instead of deleting history.
    const restored = await readJson(
      await server.handle(post(`/api/prompts/versions/${v1}/restore`, {}, cookie, savedView.content_hash)),
    );
    expect(restored).toMatchObject({ status: 'saved' });
    expect(restored.version).toMatchObject({ seq: '3', source: 'rollback', note: 'Restored from version 1' });
    expect(await readFile(join(directory, 'agent-system-prompt.md'), 'utf8')).toBe('Participate safely.');

    versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items.map((item: { seq: string }) => item.seq)).toEqual(['3', '2', '1']);
    expect(versions.current).toMatchObject({ seq: '3', source: 'rollback' });

    const detail = await readJson(
      await server.handle(request(`/api/prompts/versions/${versions.items[1].id}`, { headers: { cookie } })),
    );
    expect(detail).toMatchObject({ seq: '2', content: 'New persona.' });

    const diff = await readJson(
      await server.handle(
        request(`/api/prompts/diff?from=${versions.items[1].id}&to=${versions.items[0].id}`, { headers: { cookie } }),
      ),
    );
    expect(diff.hunks).toEqual([
      {
        fromStart: 1,
        fromCount: 1,
        toStart: 1,
        toCount: 1,
        lines: [
          { type: 'removed', text: 'New persona.', fromLine: 1, toLine: null },
          { type: 'added', text: 'Participate safely.', fromLine: null, toLine: 1 },
        ],
      },
    ]);

    const groupVersions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    const mismatch = await server.handle(
      request(`/api/prompts/diff?from=${groupVersions.items[0].id}&to=${versions.items[0].id}`, {
        headers: { cookie },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await readJson(mismatch)).toMatchObject({ error: 'diff_scope_mismatch' });

    const missing = await server.handle(request('/api/prompts/diff?from=999&to=1', { headers: { cookie } }));
    expect(missing.status).toBe(404);
  } finally {
    store.close();
  }
});

test('prompt routes only answer under the prompts namespace', async () => {
  const { store, server, directory } = await fixture();
  try {
    const cookie = await login(server);
    const view = await readJson(
      await server.handle(request('/api/prompts/global?source=file', { headers: { cookie } })),
    );
    const save = await server.handle(put('/api/unknown/global', { prompt: 'Hijacked.' }, cookie, view.content_hash));
    expect(save.status).toBe(405);
    expect(await readFile(join(directory, 'agent-system-prompt.md'), 'utf8')).toBe('Participate safely.');
    const versions = await server.handle(request('/api/unknown/versions?scope=global', { headers: { cookie } }));
    expect(versions.status).toBe(404);
  } finally {
    store.close();
  }
});

test('a hand-edited prompt file becomes a version on the next apply, comment-only edits do not', async () => {
  const { store, server, directory } = await fixture();
  try {
    const cookie = await login(server);
    await writeFile(join(directory, 'agent-system-prompt.md'), 'Hand edited.');
    expect((await server.handle(post('/api/config/apply', {}, cookie))).status).toBe(200);
    let versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(2);
    expect(versions.items[0]).toMatchObject({ seq: '2', source: 'external', created_by: null });

    // A comment-only edit changes the file bytes but not the prompt text.
    await writeFile(join(directory, 'agent-system-prompt.md'), '<!-- note -->Hand edited.');
    expect((await server.handle(post('/api/config/apply', {}, cookie))).status).toBe(200);
    versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=global', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(2);
  } finally {
    store.close();
  }
});
