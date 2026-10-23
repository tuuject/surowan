import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chatMigrations } from '../src/store/schema.ts';
import { auth, fixture, request } from './admin-inspection-fixtures.ts';

test('configuration and prompts are explicit read projections for both keys and sessions', async () => {
  const f = await fixture();
  const before = await readFile(f.configPath, 'utf8');
  for (const headers of [auth(f.key), { cookie: f.cookie }]) {
    const response = await f.server.handle(request('/api/config/view', { headers }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      source: 'active',
      generation: 1,
      active_hash: f.configStore.current().hash,
      config: {
        telegram: { chats: [{ id: '-100123456789', group_prompt_configured: true }] },
        providers: [
          { alias: 'agent', header_names: ['x-private'] },
          { alias: 'vision', header_names: [] },
        ],
        image: {
          models: [{ id: 'gpt-image-1', name: 'GPT Image 1', description: 'inspection-note' }],
        },
      },
    });
    const encoded = JSON.stringify(body);
    for (const forbidden of [
      f.secret,
      f.directory,
      'api_key',
      'system_prompt',
      'instructions_file',
      'fixed-command',
      'credentialRef',
      'token=',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    // The description is the only new field on the read projection: the
    // credentials map that binds it to a jar never crosses the inspection
    // surface alongside it.
    expect(encoded).not.toContain('"credentials"');
    const global = await f.server.handle(request('/api/prompts/global', { headers }));
    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject({
      scope: 'global',
      source: 'active',
      chat_id: null,
      prompt: 'You are a concise test agent.',
      core_read_only: true,
    });
    const group = await f.server.handle(request('/api/prompts/group?chat=-100123456789', { headers }));
    expect(group.status).toBe(200);
    expect(await group.json()).toMatchObject({
      scope: 'group',
      chat_id: '-100123456789',
      prompt: 'Be brief.',
      core_read_only: true,
    });
  }
  expect(await readFile(f.configPath, 'utf8')).toBe(before);
  expect(f.modelCalls()).toBe(0);
});

test.each([undefined, false, true])(
  'config projection preserves allow_reply_message_multiple_times=%s',
  async (value) => {
    const f = await fixture(value);
    for (const source of ['active', 'file']) {
      const response = await f.server.handle(request(`/api/config/view?source=${source}`, { headers: auth(f.key) }));
      expect(response.status).toBe(200);
      const body = await response.json();
      if (value === undefined) {
        expect(body).not.toHaveProperty('config.agent.allow_reply_message_multiple_times');
      } else {
        expect(body).toHaveProperty('config.agent.allow_reply_message_multiple_times', value);
      }
    }
  },
);

test('file and active prompt reads never silently substitute for each other', async () => {
  const f = await fixture();
  const initialHash = f.configStore.current().hash;
  await writeFile(join(f.directory, 'agent-system-prompt.md'), 'Changed file only.');
  const file = await f.server.handle(request('/api/prompts/global?source=file', { headers: auth(f.key) }));
  const data = await file.json();
  expect(data).toMatchObject({ source: 'file', prompt: 'Changed file only.', active_hash: initialHash });
  expect(data).not.toMatchObject({ file_hash: initialHash });
  const active = await f.server.handle(request('/api/prompts/global?source=active', { headers: auth(f.key) }));
  expect(await active.json()).toMatchObject({ prompt: 'You are a concise test agent.', active_hash: initialHash });
  f.store.orm
    .insert(chatMigrations)
    .values({ oldChatId: -100123456789n, newChatId: -100987654321n, receivedAt: new Date().toISOString() })
    .run();
  const migrated = await f.server.handle(request('/api/prompts/group?chat=-100987654321', { headers: auth(f.key) }));
  expect(await migrated.json()).toMatchObject({
    configured_chat_id: '-100123456789',
    chat_id: '-100987654321',
    prompt: 'Be brief.',
  });
  await writeFile(f.configPath, `invalid file quoting ${f.secret}`);
  const invalid = await f.server.handle(request('/api/config/view?source=file', { headers: auth(f.key) }));
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toEqual({
    error: 'config_invalid',
    message: 'The configuration file cannot be loaded safely',
  });
});

test('inspection rejects path inputs, repeated filters, unknown routes and every key write surface', async () => {
  const f = await fixture();
  for (const path of [
    '/api/config/view?source=other',
    '/api/config/view?source=active&source=file',
    '/api/prompts/global?path=secret',
    '/api/prompts/group',
    '/api/prompts/group?chat=9223372036854775808',
    '/api/prompts/group?chat=0&chat=1',
    '/api/invocations/9223372036854775808',
    '/api/invocations/-9223372036854775809',
    '/api/invocations/9223372036854775808/prompts',
    '/api/invocations/-9223372036854775809/replay-preflight',
    '/api/invocations/9223372036854775808/media',
    '/api/invocations/4001/media/-9223372036854775809/content',
  ]) {
    expect((await f.server.handle(request(path, { headers: auth(f.key) }))).status, path).toBe(400);
  }
  expect((await f.server.handle(request('/api/prompts/group?chat=999', { headers: auth(f.key) }))).status).toBe(404);
  expect((await f.server.handle(request('/api/prompts/global'))).status).toBe(401);
  expect(
    (
      await f.server.handle(
        request('/api/prompts/global', { headers: { cookie: f.cookie, authorization: 'Bearer invalid' } }),
      )
    ).status,
  ).toBe(401);
  for (const path of [
    '/api/prompts/system',
    '/api/config/unknown',
    '/api/providers',
    '/api/api-keys',
    '/api/unknown',
  ]) {
    expect((await f.server.handle(request(path, { headers: auth(f.key) }))).status, path).toBe(403);
  }
  for (const path of [
    '/api/config/view',
    '/api/prompts/global',
    '/api/prompts/group',
    `/api/invocations/${f.seeded.invocationA}/prompts`,
    `/api/invocations/${f.seeded.invocationA}/media`,
  ]) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(
        (await f.server.handle(request(path, { method, body: '{}', headers: auth(f.key) }))).status,
        `${method} ${path}`,
      ).toBe(403);
    }
  }
});

test('active prompt and preflight reads redact metadata without any model request', async () => {
  const f = await fixture();
  for (const headers of [auth(f.key), { cookie: f.cookie }]) {
    const preflight = await f.server.handle(
      request(`/api/invocations/${f.seeded.invocationA}/replay-preflight`, { headers }),
    );
    expect(await preflight.json()).toMatchObject({
      available: false,
      reason: 'replay_scene_unavailable',
      message: '[REDACTED]',
    });
    const prompts = await f.server.handle(request(`/api/invocations/${f.seeded.invocationA}/prompts`, { headers }));
    expect(await prompts.json()).toMatchObject({
      global_prompt: '[REDACTED]',
      source: 'active',
      group_prompt: 'active group',
      core_read_only: true,
    });
  }
  expect(f.modelCalls()).toBe(0);
});
