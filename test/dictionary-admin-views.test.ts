import { expect, test } from 'vitest';
import { adminFixture, draftBody, readJson, request } from './dictionary-fixtures.ts';

test('admin import previews, then writes in one batch without overwriting by name', async () => {
  const { server, store, cookie } = await adminFixture();
  const headers = { cookie };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  try {
    await server.handle(
      request('/api/dictionary', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(draftBody('塑料碗')) }),
    );
    const csv = 'term,definition,aliases,enabled\n塑料碗,Imported,碗|塑料,true\n';
    const preview = await server.handle(
      request('/api/dictionary/import/preview', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ format: 'csv', content: csv, scope: 'global', chat_id: null }),
      }),
    );
    expect(preview.status).toBe(200);
    const previewBody = await readJson(preview);
    expect(previewBody.entries).toEqual([
      {
        term: '塑料碗',
        definition: 'Imported',
        aliases: ['碗', '塑料'],
        scope: 'global',
        chat_id: null,
        enabled: true,
      },
    ]);
    expect(previewBody.conflicts).toContainEqual({ value: '塑料碗', entry_ids: expect.any(Array) });
    const beforeImport = await readJson(await server.handle(request('/api/dictionary?scope=global', { headers })));
    expect(beforeImport.items).toHaveLength(1);

    const imported = await server.handle(
      request('/api/dictionary/import', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ entries: previewBody.entries }),
      }),
    );
    expect(imported.status).toBe(200);
    expect((await readJson(imported)).items).toHaveLength(1);
    const after = await readJson(await server.handle(request('/api/dictionary?scope=global', { headers })));
    expect(after.items).toHaveLength(2);

    const exportCsv = await server.handle(request('/api/dictionary/export?scope=global&format=csv', { headers }));
    expect(exportCsv.status).toBe(200);
    expect(exportCsv.headers.get('content-type')).toContain('text/csv');
    const csvText = await exportCsv.text();
    expect(csvText.startsWith('term,definition,aliases,enabled')).toBe(true);
    expect(csvText).toContain('塑料碗');

    const exportJsonl = await server.handle(request('/api/dictionary/export?scope=global&format=jsonl', { headers }));
    const jsonlText = await exportJsonl.text();
    expect(jsonlText.trim().split('\n')).toHaveLength(2);

    const badFormat = await server.handle(request('/api/dictionary/export?scope=global&format=xml', { headers }));
    expect(badFormat.status).toBe(400);
    const badContent = await server.handle(
      request('/api/dictionary/import/preview', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ format: 'jsonl', content: '{"term":"only"}', scope: 'global', chat_id: null }),
      }),
    );
    expect(badContent.status).toBe(400);
  } finally {
    store.close();
  }
});

test('the Models view reports the inherited tool model and the tool-model write round-trips', async () => {
  const { server, store, cookie } = await adminFixture();
  const headers = { cookie };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  try {
    const view = await readJson(await server.handle(request('/api/providers', { headers })));
    expect(view.tool_model).toEqual({
      provider: view.agent.provider,
      model: view.agent.model,
      thinking_level: view.agent.thinking_level,
      inherited: true,
    });

    const noRevision = await server.handle(
      request('/api/tool-model', {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ inherit: true }),
      }),
    );
    expect(noRevision.status).toBe(400);
    expect(await readJson(noRevision)).toMatchObject({ error: 'revision_required' });

    const selected = await server.handle(
      request('/api/tool-model', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': view.revision },
        body: JSON.stringify({ provider: 'vision', model: 'vision-model', thinking_level: 'off' }),
      }),
    );
    expect(selected.status).toBe(200);
    const selectedBody = await readJson(selected);
    expect(selectedBody).toMatchObject({ provider: 'vision', model: 'vision-model', inherited: false });

    // The file now carries the section, so the Models view reports it as configured.
    const after = await readJson(await server.handle(request('/api/providers', { headers })));
    expect(after.tool_model).toMatchObject({ provider: 'vision', model: 'vision-model', inherited: false });

    const inherited = await server.handle(
      request('/api/tool-model', {
        method: 'PUT',
        headers: { ...jsonHeaders, 'if-match': selectedBody.revision },
        body: JSON.stringify({ inherit: true }),
      }),
    );
    expect(inherited.status).toBe(200);
    expect(await readJson(inherited)).toMatchObject({ inherited: true });
    const cleared = await readJson(await server.handle(request('/api/providers', { headers })));
    expect(cleared.tool_model.inherited).toBe(true);
  } finally {
    store.close();
  }
});
