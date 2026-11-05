import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';

import { fixture } from './chats-fixtures.ts';

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
