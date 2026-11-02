import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';

import { fixture } from './chats-fixtures.ts';
import type { ChatWriteResponse } from '../../apps/admin-next/src/lib/api/chats.ts';

test('pause policy opens /pause to members per Chat, applying hot', async () => {
  const f = await fixture();
  const view = await f.view();
  expect(view.items.find((chat) => chat.id === '-100100')?.saved?.pause_by_members).toBe(false);
  expect(view.items.find((chat) => chat.id === '123456789')?.saved?.pause_by_members).toBe(false);

  const open = await f.write('/chats/-100100/pause-policy', 'PUT', { pause_by_members: true }, view.revision);
  expect(open.status).toBe(200);
  const result = (await open.json()) as ChatWriteResponse;
  expect(result.apply.applied).toContain('telegram.chats[-100100].pause_by_members');
  expect(result.apply.restart_required).toEqual([]);
  expect(result.items.find((chat) => chat.id === '-100100')?.saved?.pause_by_members).toBe(true);
  expect(result.items.find((chat) => chat.id === '-100100')?.active?.pause_by_members).toBe(true);
  expect(f.configStore.current().config.telegram.chats[1]?.pause_by_members).toBe(true);
  expect((await loadConfig(f.path)).fileConfig.telegram?.chats[1]?.pause_by_members).toBe(true);

  const bytes = await readFile(f.path, 'utf8');
  const repeat = await f.write('/chats/-100100/pause-policy', 'PUT', { pause_by_members: true }, result.revision);
  expect(repeat.status).toBe(200);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);

  const close = await f.write('/chats/-100100/pause-policy', 'PUT', { pause_by_members: false }, result.revision);
  expect(close.status).toBe(200);
  const closed = (await close.json()) as ChatWriteResponse;
  expect(closed.items.find((chat) => chat.id === '-100100')?.saved?.pause_by_members).toBe(false);
  // Disabling deletes the key: absent already means admins-only.
  expect(await readFile(f.path, 'utf8')).not.toContain('pause_by_members');
});

test('pause policy edits reject private chats, invalid bodies, unknown chats and stale revisions', async () => {
  const f = await fixture();
  const { revision } = await f.view();
  const before = await readFile(f.path, 'utf8');
  const active = f.configStore.current();
  for (const body of [{}, { pause_by_members: 'yes' }, { pause_by_members: true, extra: 1 }]) {
    const response = await f.write('/chats/-100100/pause-policy', 'PUT', body, revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  }
  const privy = await f.write('/chats/123456789/pause-policy', 'PUT', { pause_by_members: true }, revision);
  expect(privy.status).toBe(400);
  expect(await privy.json()).toMatchObject({ error: 'invalid_body' });
  expect((await f.write('/chats/99/pause-policy', 'PUT', { pause_by_members: true }, revision)).status).toBe(404);
  expect((await f.write('/chats/-100100/pause-policy', 'POST', { pause_by_members: true }, revision)).status).toBe(405);
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(f.configStore.current()).toBe(active);

  const first = await f.write('/chats/-100100/pause-policy', 'PUT', { pause_by_members: true }, revision);
  expect(first.status).toBe(200);
  const stale = await f.write('/chats/-100100/pause-policy', 'PUT', { pause_by_members: false }, revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
});
