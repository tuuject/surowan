import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, login, put, readJson, request } from './admin-fixtures.ts';

test('group prompt save edits the configured file, validates chat scope and rejects unknown chats', async () => {
  const { store, server, directory } = await fixture();
  try {
    const cookie = await login(server);

    const unconfigured = await server.handle(
      put('/api/prompts/group?chat=-100333', { prompt: 'nope' }, cookie, 'deadbeef'),
    );
    expect(unconfigured.status).toBe(404);
    expect(await readJson(unconfigured)).toMatchObject({ error: 'chat_unconfigured' });

    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('private');

    const saved = await readJson(
      await server.handle(
        put('/api/prompts/group?chat=123456789', { prompt: 'group v2', note: 'per group' }, cookie, view.content_hash),
      ),
    );
    expect(saved).toMatchObject({ status: 'saved', affected_running: 0 });
    expect(saved.version).toMatchObject({ chat_id: '123456789', seq: '2', source: 'panel' });
    expect(await readFile(join(directory, 'chat-instructions.md'), 'utf8')).toBe('group v2');
    const active = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('group v2');

    const versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    expect(versions.items.map((item: { seq: string }) => item.seq)).toEqual(['2', '1']);
    expect(versions.items[0]).toMatchObject({ chat_id: '123456789', note: 'per group' });
  } finally {
    store.close();
  }
});

test('group prompt creation writes a conventional file, references it and refuses clobbering', async () => {
  const { store, server, directory } = await fixture((config) => {
    const chat = config.telegram.chats[0];
    if (chat !== undefined) {
      delete chat.instructions_file;
    }
  });
  try {
    const cookie = await login(server);
    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    expect(view.prompt).toBe('');

    // An unreferenced file at the conventional path is never clobbered.
    const promptDir = join(directory, 'prompts');
    await mkdir(promptDir, { recursive: true });
    await writeFile(join(promptDir, 'chat-123456789.md'), 'operator file');
    const refused = await server.handle(
      put('/api/prompts/group?chat=123456789', { prompt: 'fresh' }, cookie, view.content_hash),
    );
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({ error: 'prompt_file_exists' });
    await unlink(join(promptDir, 'chat-123456789.md'));

    const saved = await readJson(
      await server.handle(put('/api/prompts/group?chat=123456789', { prompt: 'fresh' }, cookie, view.content_hash)),
    );
    expect(saved).toMatchObject({ status: 'saved' });
    expect(saved.applied).toContain('telegram.chats[123456789].instructions_file');
    expect(await readFile(join(promptDir, 'chat-123456789.md'), 'utf8')).toBe('fresh');
    expect(await readFile(`${directory}/config.jsonc`, 'utf8')).toContain('"prompts/chat-123456789.md"');
    const active = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=active', { headers: { cookie } })),
    );
    expect(active.prompt).toBe('fresh');
    const versions = await readJson(
      await server.handle(request('/api/prompts/versions?scope=group&chat=123456789', { headers: { cookie } })),
    );
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({ seq: '1', source: 'panel', chat_id: '123456789' });
  } finally {
    store.close();
  }
});

test('a group prompt keeps its configured file when no global prompt file is configured', async () => {
  const { store, server, directory } = await fixture((config) => {
    delete (config.agent as { system_prompt_file?: string }).system_prompt_file;
  });
  try {
    const cookie = await login(server);
    const view = await readJson(
      await server.handle(request('/api/prompts/group?chat=123456789&source=file', { headers: { cookie } })),
    );
    const saved = await readJson(
      await server.handle(put('/api/prompts/group?chat=123456789', { prompt: 'group v2' }, cookie, view.content_hash)),
    );
    expect(saved).toMatchObject({ status: 'saved' });
    expect(await readFile(join(directory, 'chat-instructions.md'), 'utf8')).toBe('group v2');
    expect(await readFile(join(directory, 'config.jsonc'), 'utf8')).not.toContain('prompts/agent.md');
  } finally {
    store.close();
  }
});
