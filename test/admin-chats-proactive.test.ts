import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';

import { fixture } from './admin-chats-fixtures.ts';
import type { ChatWriteResponse } from '../apps/admin-next/src/lib/api/chats.ts';

test('proactive reply edits set, disable and inherit per Chat, applying hot', async () => {
  const f = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const view = await f.view();
  expect(view.global_proactive_reply).toBeNull();
  expect(view.effective_global_proactive_reply).toEqual({
    enabled: false,
    base_probability: 0.2,
    increment: 0.1,
    hard_pity: 8,
  });
  expect(view.items.find((chat) => chat.id === '-100100')?.saved?.proactive_reply).toBeNull();
  expect(view.items.find((chat) => chat.id === '-100100')?.saved?.effective_proactive_reply).toEqual(
    view.effective_global_proactive_reply,
  );

  const custom = { mode: 'custom', base_probability: 0.25, increment: 0.05, hard_pity: 4 } as const;
  const set = await f.write('/chats/-100100/proactive-reply', 'PUT', custom, view.revision);
  expect(set.status).toBe(200);
  const setResult = (await set.json()) as ChatWriteResponse;
  expect(setResult.apply.applied).toContain('telegram.chats[-100100].proactive_reply');
  expect(setResult.apply.restart_required).toEqual([]);
  expect(setResult.items.find((chat) => chat.id === '-100100')?.saved?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  expect(setResult.items.find((chat) => chat.id === '-100100')?.active?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  expect(f.configStore.current().config.telegram.chats[1]?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  expect((await loadConfig(f.path)).fileConfig.telegram.chats[1]?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  expect(
    log.mock.calls.some(
      ([line]) =>
        String(line).includes('config_reloaded') && String(line).includes('telegram.chats[-100100].proactive_reply'),
    ),
  ).toBe(true);

  const bytes = await readFile(f.path, 'utf8');
  const repeat = await f.write('/chats/-100100/proactive-reply', 'PUT', custom, setResult.revision);
  expect(repeat.status).toBe(200);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);

  const off = await f.write('/chats/-100100/proactive-reply', 'PUT', { mode: 'off' }, setResult.revision);
  expect(off.status).toBe(200);
  const offResult = (await off.json()) as ChatWriteResponse;
  expect(offResult.items.find((chat) => chat.id === '-100100')?.saved?.proactive_reply).toEqual({
    enabled: false,
  });
  expect((await loadConfig(f.path)).fileConfig.telegram.chats[1]?.proactive_reply).toEqual({ enabled: false });

  const inherit = await f.write('/chats/-100100/proactive-reply', 'PUT', { mode: 'inherit' }, offResult.revision);
  expect(inherit.status).toBe(200);
  expect(
    ((await inherit.json()) as ChatWriteResponse).items.find((chat) => chat.id === '-100100')?.saved?.proactive_reply,
  ).toBeNull();
  expect(await readFile(f.path, 'utf8')).not.toContain('proactive_reply');
});

test('proactive reply edits reject private chats, invalid values and stale revisions', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const active = f.configStore.current();
  const { revision } = await f.view();
  const badBodies = [
    {},
    { mode: 'on' },
    { mode: 'custom' },
    { mode: 'custom', base_probability: -0.1, increment: 0.1, hard_pity: 8 },
    { mode: 'custom', base_probability: 0.2, increment: 1.1, hard_pity: 8 },
    { mode: 'custom', base_probability: 0.2, increment: 0.1, hard_pity: 0 },
    { mode: 'custom', base_probability: 0.2, increment: 0.1, hard_pity: 1.5 },
    { mode: 'custom', base_probability: 0.2, increment: 0.1, hard_pity: 8, enabled: true },
    { mode: 'inherit', base_probability: 0.2 },
  ];
  for (const body of badBodies) {
    const response = await f.write('/chats/-100100/proactive-reply', 'PUT', body, revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  }
  const privy = await f.write(
    '/chats/123456789/proactive-reply',
    'PUT',
    { mode: 'custom', base_probability: 0.2, increment: 0.1, hard_pity: 8 },
    revision,
  );
  expect(privy.status).toBe(400);
  expect(await privy.json()).toMatchObject({ error: 'invalid_body' });
  expect((await f.write('/chats/99/proactive-reply', 'PUT', { mode: 'off' }, revision)).status).toBe(404);
  expect((await f.write('/chats/-100100/proactive-reply', 'POST', { mode: 'off' }, revision)).status).toBe(405);
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(f.configStore.current()).toBe(active);

  const first = await f.write('/chats/-100100/proactive-reply', 'PUT', { mode: 'off' }, revision);
  expect(first.status).toBe(200);
  const stale = await f.write('/chats/-100100/proactive-reply', 'PUT', { mode: 'inherit' }, revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
});

test('an unconfigured agent identity is reported as explicit nulls', async () => {
  const f = await fixture((config) => {
    (config as unknown as Record<string, unknown>).agent = {};
  });
  const view = await f.view();
  const unconfigured = { provider: null, model: null, thinking_level: null };
  expect(view.defaults).toEqual(unconfigured);
  const chat = view.items.find((item) => item.id === '-100100');
  expect(chat?.saved?.effective).toEqual(unconfigured);
  expect(chat?.active?.effective).toEqual(unconfigured);
});
