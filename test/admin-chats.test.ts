import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import type { FileConfig } from '../src/platform/config.ts';
import { fixture, inherited } from './admin-chats-fixtures.ts';

test('Chat views are authenticated, string-ID only and contain saved and active effective settings', async () => {
  const f = await fixture();
  expect((await f.request('/chats')).status).toBe(401);
  const view = await f.view();
  expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(view.defaults).toEqual({ provider: 'agent', model: 'agent-model', thinking_level: 'low' });
  expect(view.models).toContainEqual({
    provider: 'vision',
    model: 'vision-model',
    name: 'Vision Model',
    thinking_levels: ['off'],
  });
  const chat = view.items.find((item) => item.id === '-100100');
  expect(chat).toMatchObject({
    runtime_chat_id: '-100100',
    title: null,
    saved: { topic_ids: ['12'], provider: null, effective: view.defaults },
  });
  expect(chat?.active).toEqual(chat?.saved);
  const serialized = JSON.stringify(view);
  for (const secret of [
    'telegram-secret',
    'agent-secret',
    'vision-secret',
    'api_key',
    'instructions_file',
    'private',
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect((await f.call('/chats', { method: 'POST', headers: { origin: 'https://evil.test' } })).status).toBe(403);
  expect((await f.call('/chats/123', { method: 'POST' })).status).toBe(405);
  expect((await f.call('/chats/123')).status).toBe(405);
});

test('Chat edits require the original revision before parsing a body, reject stale array indices and serialize competing writes', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const missing = await f.call('/chats/-100100', { method: 'PUT', body: 'not JSON' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'revision_required' });
  const { revision } = await f.view();
  const file = JSON.parse(before) as FileConfig;
  file.telegram.chats.reverse();
  await writeFile(f.path, JSON.stringify(file));
  const stale = await f.write('/chats/-100100', 'PUT', inherited, revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
  expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify(file));
  const fresh = await f.view();
  const results = await Promise.all([
    f.write('/chats/-100100', 'PUT', { ...inherited, thinking_level: 'high' }, fresh.revision),
    f.write('/chats/-100100', 'PUT', { ...inherited, thinking_level: 'off' }, fresh.revision),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(
    f.configStore.current().config.telegram.chats.find((chat) => chat.id === 123456789)?.thinking_level,
  ).toBeUndefined();
});
