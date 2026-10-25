import { expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';

import { fixture } from './chats-fixtures.ts';
import type { ChatWriteResponse } from '../../apps/admin-next/src/lib/api/chats.ts';

test('active-hours edits set, empty and remove Chat participation windows, applying hot', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const windows = [
    { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    { start: '22:00', end: '02:00' },
  ];
  const set = await f.write(
    '/chats/-100100/participation',
    'PUT',
    { active_windows: windows },
    (await f.view()).revision,
  );
  expect(set.status).toBe(200);
  const setResult = (await set.json()) as ChatWriteResponse;
  expect(setResult.apply.applied).toContain('telegram.chats[-100100].participation');
  expect(setResult.apply.restart_required).toEqual([]);
  expect(setResult.timezone).toBe('UTC');
  expect(setResult.global_participation).toBeNull();
  expect(setResult.items.find((chat) => chat.id === '-100100')?.saved).toMatchObject({
    participation: { active_windows: windows },
    timezone: 'Asia/Shanghai',
  });
  expect(setResult.items.find((chat) => chat.id === '-100100')?.active?.participation).toEqual({
    active_windows: windows,
  });
  expect(f.configStore.current().config.telegram.chats[1]?.participation).toEqual({ active_windows: windows });
  const loaded = await loadConfig(f.path);
  expect(loaded.fileConfig.telegram?.chats[1]?.participation).toEqual({ active_windows: windows });
  expect(loaded.fileConfig.telegram?.chats[1]?.ignored_user_ids).toEqual([42]);
  expect(
    log.mock.calls.some(
      ([line]) =>
        String(line).includes('config_reloaded') && String(line).includes('telegram.chats[-100100].participation'),
    ),
  ).toBe(true);

  // Repeating the same windows changes nothing and keeps the file bytes.
  const bytes = await readFile(f.path, 'utf8');
  const repeat = await f.write('/chats/-100100/participation', 'PUT', { active_windows: windows }, setResult.revision);
  expect(repeat.status).toBe(200);
  const repeatResult = (await repeat.json()) as ChatWriteResponse;
  expect(await readFile(f.path, 'utf8')).toBe(bytes);

  // An explicit empty array keeps the participation gate without scheduled windows.
  const emptied = await f.write('/chats/-100100/participation', 'PUT', { active_windows: [] }, repeatResult.revision);
  expect(emptied.status).toBe(200);
  const emptiedResult = (await emptied.json()) as ChatWriteResponse;
  expect(emptiedResult.items.find((chat) => chat.id === '-100100')?.saved?.participation).toEqual({
    active_windows: [],
  });
  expect((await loadConfig(f.path)).fileConfig.telegram?.chats[1]?.participation).toEqual({ active_windows: [] });

  // Removing the windows drops the whole object when nothing else remains.
  const removed = await f.write(
    '/chats/-100100/participation',
    'PUT',
    { active_windows: null },
    emptiedResult.revision,
  );
  expect(removed.status).toBe(200);
  const removedResult = (await removed.json()) as ChatWriteResponse;
  expect(removedResult.items.find((chat) => chat.id === '-100100')?.saved?.participation).toBeNull();
  expect((await loadConfig(f.path)).fileConfig.telegram?.chats[1]?.participation).toBeUndefined();
  expect(await readFile(f.path, 'utf8')).not.toContain('participation');
});

test('removing active windows preserves other participation fields instead of faking an unrestricted chat', async () => {
  const f = await fixture();
  const file = JSON.parse(await readFile(f.path, 'utf8')) as FileConfig;
  const chat = file.telegram!.chats[1];
  if (chat === undefined || chat.id !== -100100) {
    throw new Error('Fixture chat missing');
  }
  chat.participation = { active_windows: [{ start: '09:00', end: '10:00' }], trigger_keywords: ['help'] };
  await writeFile(f.path, JSON.stringify(file));
  const { revision } = await f.view();
  const removed = await f.write('/chats/-100100/participation', 'PUT', { active_windows: null }, revision);
  expect(removed.status).toBe(200);
  const result = (await removed.json()) as ChatWriteResponse;
  expect(result.items.find((item) => item.id === '-100100')?.saved?.participation).toEqual({
    trigger_keywords: ['help'],
  });
  expect((await loadConfig(f.path)).fileConfig.telegram?.chats[1]?.participation).toEqual({
    trigger_keywords: ['help'],
  });
  // Removing again is a no-op that keeps the bytes.
  const bytes = await readFile(f.path, 'utf8');
  const repeat = await f.write('/chats/-100100/participation', 'PUT', { active_windows: null }, result.revision);
  expect(repeat.status).toBe(200);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
});

test('participation edits validate body, chat type and revision without touching file or active state', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const active = f.configStore.current();
  const { revision } = await f.view();
  const badBodies = [
    {},
    { active_windows: '09:00' },
    { active_windows: [{ start: '9:00', end: '10:00' }] },
    { active_windows: [{ start: '09:00', end: '24:60' }] },
    { active_windows: [{ start: '09:00', end: '09:00' }] },
    { active_windows: [{ start: '09:00', end: '10:00', days: [8] }] },
    { active_windows: [{ start: '09:00', end: '10:00', days: [] }] },
    { active_windows: [{ start: '09:00', end: '10:00' }], trigger_keywords: ['nope'] },
  ];
  for (const body of badBodies) {
    const response = await f.write('/chats/-100100/participation', 'PUT', body, revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(f.configStore.current()).toBe(active);
  }
  // Private chats never gate, so they cannot carry windows.
  const privy = await f.write('/chats/123456789/participation', 'PUT', { active_windows: [] }, revision);
  expect(privy.status).toBe(400);
  expect(await privy.json()).toMatchObject({ error: 'invalid_body' });
  expect((await f.write('/chats/99/participation', 'PUT', { active_windows: [] }, revision)).status).toBe(404);
  expect((await f.write('/chats/-100100/participation', 'POST', { active_windows: [] }, revision)).status).toBe(405);
  const unrevisioned = await f.call('/chats/-100100/participation', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active_windows: [] }),
  });
  expect(unrevisioned.status).toBe(400);
  expect(await unrevisioned.json()).toMatchObject({ error: 'revision_required' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(f.configStore.current()).toBe(active);
});
