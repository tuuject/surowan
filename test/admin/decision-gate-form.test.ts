import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { DECISION_GATE_DEFAULT_INSTRUCTIONS } from '../../src/platform/decision-gate.ts';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { fixture, GROUP } from './decision-gate-fixtures.ts';

/**
 * `GET`/`PUT /decision-gate`: the global section's read view and its patch
 * write. The file and the running configuration are both asserted, because a
 * settings endpoint that answers 200 without applying is not a save.
 */

const DEFAULTS = {
  enabled: false,
  mode: 'shadow',
  threshold: 0.57,
  history_messages: 10,
  pending_messages: 10,
  instructions: DECISION_GATE_DEFAULT_INSTRUCTIONS,
  model: 'typesafe/jev-1.14',
  base_url: 'https://openrouter.ai/api/alpha',
  timeout_ms: 3_000,
};

test('an absent section reports the defaults the runtime uses, without a key', async () => {
  const f = await fixture();
  const view = await f.view();
  expect(view.saved).toEqual(DEFAULTS);
  expect(view.active).toEqual(DEFAULTS);
  expect(view.key_configured).toBe(false);
  // A panel session sees where the reference would come from — here, nowhere.
  expect(view).toHaveProperty('key_source', null);
  expect(view.revision).toMatch(/^[0-9a-f]{64}$/);
});

test('saved reports the file while active reports what the process runs', async () => {
  const f = await fixture();
  // A hand edit that nobody applied yet: the file asks for 0.9, the bot still
  // uses the default it started with.
  const file = JSON.parse(await f.raw()) as FileConfig;
  const telegram = file.telegram ?? { process_bot_messages: false, bucket_window_seconds: 15, chats: [] };
  telegram.decision_gate = { threshold: 0.9, history_messages: 4 };
  await writeFile(f.path, `${JSON.stringify({ ...file, telegram }, null, 2)}\n`);
  const view = await f.view();
  expect(view.saved).toMatchObject({ threshold: 0.9, history_messages: 4, pending_messages: 10 });
  expect(view.active).toEqual(DEFAULTS);
  expect(f.configStore.current().config.telegram.decision_gate).toBeUndefined();
});

test('a patch keeps omitted fields, writes the ones it changes and hot-applies', async () => {
  const f = await fixture({
    transform: (config) => {
      config.telegram.decision_gate = { enabled: true, mode: 'enforce', threshold: 0.4, api_key: { jar: 'agent' } };
    },
  });
  const before = await f.view();
  const saved = await f.write('/decision-gate', 'PUT', { history_messages: 5 }, before.revision);
  expect(saved.status).toBe(200);
  const body = (await saved.json()) as {
    saved: Record<string, unknown>;
    active: Record<string, unknown>;
    revision: string;
    apply: { applied: readonly string[]; restart_required: readonly string[] };
  };
  expect(body.apply.restart_required).toEqual([]);
  expect(body.apply.applied).toContain('telegram.decision_gate.history_messages');
  expect(body.saved).toMatchObject({ enabled: true, mode: 'enforce', threshold: 0.4, history_messages: 5 });
  expect(body.active).toEqual(body.saved);
  expect(f.configStore.current().config.telegram.decision_gate).toMatchObject({
    enabled: true,
    mode: 'enforce',
    threshold: 0.4,
    history_messages: 5,
  });
  // The file kept the fields the request never mentioned.
  const file = await f.file();
  expect(file.telegram?.decision_gate).toEqual({
    enabled: true,
    mode: 'enforce',
    threshold: 0.4,
    api_key: { jar: 'agent' },
    history_messages: 5,
  });

  // `null` removes a field instead of writing a null.
  const removed = await f.write('/decision-gate', 'PUT', { threshold: null }, body.revision);
  expect(removed.status).toBe(200);
  const after = await f.file();
  expect(Object.hasOwn(after.telegram?.decision_gate ?? {}, 'threshold')).toBe(false);
  expect((await f.view()).saved.threshold).toBe(DEFAULTS.threshold);
});

test('removing the last field removes the whole section', async () => {
  const f = await fixture({
    transform: (config) => {
      config.telegram.decision_gate = { threshold: 0.4 };
    },
  });
  const response = await f.write('/decision-gate', 'PUT', { threshold: null }, (await f.view()).revision);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { saved: { threshold: number }; active: { threshold: number } };
  expect(body.saved.threshold).toBe(DEFAULTS.threshold);
  const file = await f.file();
  expect(file.telegram === undefined ? 'missing' : Object.hasOwn(file.telegram, 'decision_gate')).toBe(false);
});

test('a write that changes nothing answers with an empty apply and keeps the bytes', async () => {
  const f = await fixture({
    transform: (config) => {
      config.telegram.decision_gate = { mode: 'shadow' };
    },
  });
  const bytes = await f.raw();
  const response = await f.write('/decision-gate', 'PUT', { mode: 'shadow' }, (await f.view()).revision);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { apply: { applied: readonly string[] } };
  expect(body.apply.applied).toEqual([]);
  expect(await f.raw()).toBe(bytes);
});

test('invalid values, unknown fields and empty bodies are refused before the file moves', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const active = f.configStore.current();
  const bodies: readonly Record<string, unknown>[] = [
    {},
    { threshold: 1.5 },
    { threshold: -0.1 },
    { threshold: '0.5' },
    { history_messages: -1 },
    { history_messages: 51 },
    { history_messages: 1.5 },
    { pending_messages: 0 },
    { timeout_ms: 499 },
    { timeout_ms: 10_001 },
    { mode: 'loud' },
    { enabled: 'yes' },
    { instructions: '' },
    { instructions: 12 },
    { model: '' },
    { base_url: 42 },
    { unknown_field: true },
  ];
  for (const body of bodies) {
    const response = await f.write('/decision-gate', 'PUT', body, (await f.view()).revision);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(await f.raw()).toBe(bytes);
    expect(f.configStore.current()).toBe(active);
  }
});

test('a missing or stale If-Match is refused and the file stays untouched', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const missing = await f.call('/decision-gate', { method: 'PUT', body: JSON.stringify({ threshold: 0.2 }) });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'revision_required' });
  const stale = await f.write('/decision-gate', 'PUT', { threshold: 0.2 }, `${(await f.view()).revision}-stale`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'config_conflict' });
  expect(await f.raw()).toBe(bytes);
  // Write endpoints reject a foreign Origin like every other panel write.
  const foreign = await f.call('/decision-gate', {
    method: 'PUT',
    headers: { 'if-match': (await f.view()).revision, 'content-type': 'application/json', origin: 'http://evil.test' },
    body: JSON.stringify({ threshold: 0.2 }),
  });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ error: 'bad_origin' });
  expect(await f.raw()).toBe(bytes);
  // And the endpoint is GET or PUT only.
  expect((await f.call('/decision-gate', { method: 'POST', body: '{}' })).status).toBe(405);
});

test('enabling the gate without a credential is refused, globally and from a Chat', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  const response = await f.write('/decision-gate', 'PUT', { enabled: true }, (await f.view()).revision);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'decision_gate_invalid' });
  expect(await f.raw()).toBe(bytes);

  // A group Chat turning the gate on needs the same global credential.
  const chatOverride = await f.write(
    `/chats/${GROUP}/decision-gate`,
    'PUT',
    { enabled: true },
    (await f.view()).revision,
  );
  expect(chatOverride.status).toBe(400);
  expect(await chatOverride.json()).toMatchObject({ error: 'decision_gate_invalid' });
  expect(await f.raw()).toBe(bytes);
});

test('a base_url that is not a plain HTTPS prefix is refused', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  for (const baseUrl of [
    'http://openrouter.ai/api/alpha',
    'https://user:pass@openrouter.ai/api/alpha',
    'https://openrouter.ai/api/alpha?key=1',
    'https://openrouter.ai/api/alpha#frag',
    'not a url',
    ' https://openrouter.ai/api/alpha',
  ]) {
    const response = await f.write('/decision-gate', 'PUT', { base_url: baseUrl }, (await f.view()).revision);
    expect(response.status, baseUrl).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'decision_gate_invalid' });
    expect(await f.raw()).toBe(bytes);
  }
});
