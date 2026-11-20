import { expect, test, vi } from 'vitest';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { fixture } from './decision-gate-fixtures.ts';

/**
 * The gate's secret rules. Every case asserts the persisted `config.jsonc` and
 * the keychain through the keychain module, not only the response: a rejected
 * write must leave both untouched, and a rotation must not touch the file.
 */

const OLD_KEY = '{{SECRET_yx7bhddy}}';
const NEW_KEY = '{{SECRET_ia5bnbtv}}';
const FAILED_KEY = '{{SECRET_0z1y3wvr}}';

async function gateSection(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.file()).telegram?.decision_gate;
}

test('a new plaintext becomes a `decision-gate` keychain entry, never a file value', async () => {
  const f = await fixture();
  const response = await f.write(
    '/decision-gate',
    'PUT',
    { enabled: true, api_key: NEW_KEY },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(NEW_KEY);
  const body = JSON.parse(text) as { key_configured: boolean; saved: Record<string, unknown> };
  expect(body.key_configured).toBe(true);
  expect(body.saved).toMatchObject({ enabled: true });
  // The file names the entry; the keychain holds the value.
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'decision-gate' });
  expect(await f.raw()).not.toContain(NEW_KEY);
  expect((await f.jar())['decision-gate']).toBe(NEW_KEY);
  // The plaintext was registered, so anything echoed later is scrubbed.
  expect(f.secrets.redact(`bad key ${NEW_KEY} here`)).toBe('bad key [REDACTED] here');
});

test('the panel may choose the entry name', async () => {
  const f = await fixture();
  const response = await f.write(
    '/decision-gate',
    'PUT',
    { api_key: { value: NEW_KEY, name: 'entry-gate' } },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'entry-gate' });
  expect((await f.jar())['entry-gate']).toBe(NEW_KEY);
  // An explicitly chosen name that already exists is a conflict, not a rename.
  const conflict = await f.write(
    '/decision-gate',
    'PUT',
    { api_key: { value: OLD_KEY, name: 'entry-gate' } },
    (await f.view()).revision,
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: 'keychain_exists' });
  expect((await f.jar())['entry-gate']).toBe(NEW_KEY);
});

test('a name clash gets a suffix instead of overwriting the entry', async () => {
  const f = await fixture({ keychain: { 'decision-gate': OLD_KEY } });
  const response = await f.write('/decision-gate', 'PUT', { api_key: NEW_KEY }, (await f.view()).revision);
  expect(response.status).toBe(200);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'decision-gate-2' });
  const jar = await f.jar();
  expect(jar['decision-gate']).toBe(OLD_KEY);
  expect(jar['decision-gate-2']).toBe(NEW_KEY);
});

test('a panel session may reuse an existing entry, unchanged', async () => {
  const f = await fixture({ keychain: { openrouter: OLD_KEY } });
  const jarBefore = await f.jar();
  const response = await f.write(
    '/decision-gate',
    'PUT',
    { api_key: { entry: 'openrouter' } },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'openrouter' });
  // No value copied, no entry created, nothing rotated.
  expect(await f.jar()).toEqual(jarBefore);
  const sessionView = await f.view();
  expect(sessionView.key_source).toEqual({ kind: 'entry', name: 'openrouter' });
  // The value never travels back on either caller class.
  expect(JSON.stringify(sessionView)).not.toContain(OLD_KEY);
  const auth = await f.bearerKey('read');
  const programmatic = await (await f.bearerCall('/decision-gate', {}, auth)).text();
  expect(programmatic).not.toContain(OLD_KEY);
});

test('a programmatic credential may not reference an existing entry, and nothing changes', async () => {
  const f = await fixture({
    keychain: { openrouter: OLD_KEY },
    transform: (config) => {
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'agent' } };
    },
  });
  const auth = await f.bearerKey();
  const bytes = await f.raw();
  const jarBefore = await f.jar();
  const response = await f.bearerWrite(
    '/decision-gate',
    'PUT',
    { api_key: { entry: 'openrouter' } },
    (await f.view()).revision,
    auth,
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: 'entry_not_allowed' });
  expect(await f.raw()).toBe(bytes);
  expect(await f.jar()).toEqual(jarBefore);
  // The read view for a programmatic credential carries the boolean only.
  const programmatic = (await (await f.bearerCall('/decision-gate', {}, auth)).json()) as Record<string, unknown>;
  expect(programmatic.key_configured).toBe(true);
  expect(programmatic).not.toHaveProperty('key_source');
});

test('a programmatic credential that keeps the key may not move the address', async () => {
  const f = await fixture({
    keychain: { shared: OLD_KEY },
    transform: (config) => {
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'shared' } };
    },
  });
  const auth = await f.bearerKey();
  const bytes = await f.raw();
  const moved = await f.bearerWrite(
    '/decision-gate',
    'PUT',
    { base_url: 'https://attacker.example.test/api' },
    (await f.view()).revision,
    auth,
  );
  expect(moved.status).toBe(400);
  expect(await moved.json()).toMatchObject({ error: 'decision_gate_invalid' });
  expect(await f.raw()).toBe(bytes);
  expect((await f.jar()).shared).toBe(OLD_KEY);

  // Submitting the key in the same request is the way through.
  const resubmitted = await f.bearerWrite(
    '/decision-gate',
    'PUT',
    { base_url: 'https://elsewhere.example.test/api', api_key: NEW_KEY },
    (await f.view()).revision,
    auth,
  );
  expect(resubmitted.status).toBe(200);
  expect((await gateSection(f))?.base_url).toBe('https://elsewhere.example.test/api');

  // A panel session is the admin: it keeps the key and moves the address.
  const session = await f.write(
    '/decision-gate',
    'PUT',
    { base_url: 'https://panel.example.test/api' },
    (await f.view()).revision,
  );
  expect(session.status).toBe(200);
  expect((await gateSection(f))?.base_url).toBe('https://panel.example.test/api');
});

test('the effective address decides, so writing the default explicitly is not a move', async () => {
  const f = await fixture({
    keychain: { shared: OLD_KEY },
    transform: (config) => {
      // No base_url: the default is what the running gate uses.
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'shared' } };
    },
  });
  const auth = await f.bearerKey();
  const same = await f.bearerWrite(
    '/decision-gate',
    'PUT',
    { base_url: 'https://openrouter.ai/api/alpha' },
    (await f.view()).revision,
    auth,
  );
  expect(same.status).toBe(200);
  expect((await gateSection(f))?.base_url).toBe('https://openrouter.ai/api/alpha');
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'shared' });

  // Dropping the override back to the default is likewise not a move.
  const dropped = await f.bearerWrite('/decision-gate', 'PUT', { base_url: null }, (await f.view()).revision, auth);
  expect(dropped.status).toBe(200);
  expect(Object.hasOwn((await gateSection(f)) ?? {}, 'base_url')).toBe(false);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'shared' });
});

test('a singly-used entry rotates in place without touching the config file', async () => {
  const f = await fixture({
    keychain: { 'decision-gate': OLD_KEY },
    transform: (config) => {
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'decision-gate' } };
    },
  });
  const bytes = await f.raw();
  const jarBefore = await f.jar();
  const response = await f.write('/decision-gate', 'PUT', { api_key: NEW_KEY }, (await f.view()).revision);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(NEW_KEY);
  // Same name, new value; the file did not move at all.
  expect(await f.raw()).toBe(bytes);
  const jar = await f.jar();
  expect(jar['decision-gate']).toBe(NEW_KEY);
  expect(jar['decision-gate-2']).toBeUndefined();
  expect(Object.keys(jar).sort()).toEqual(Object.keys(jarBefore).sort());
});

test('a dangling reference is repaired under the same name', async () => {
  const f = await fixture({
    transform: (config) => {
      // The file names an entry the keychain does not have; loading does not
      // resolve it, so the panel is the first writer that can repair it.
      config.telegram.decision_gate = { enabled: true, api_key: { jar: 'decision-gate' } };
    },
  });
  const bytes = await f.raw();
  const response = await f.write('/decision-gate', 'PUT', { api_key: NEW_KEY }, (await f.view()).revision);
  expect(response.status).toBe(200);
  // The reference stays where it was; only the missing value is filled in.
  expect(await f.raw()).toBe(bytes);
  expect((await f.jar())['decision-gate']).toBe(NEW_KEY);
});

test('an entry shared with another use gets a new entry instead of a rotation', async () => {
  const f = await fixture({
    keychain: { agent: OLD_KEY },
    transform: (config) => {
      config.telegram.decision_gate = { enabled: true, mode: 'enforce', api_key: { jar: 'agent' } };
    },
  });
  const response = await f.write(
    '/decision-gate',
    'PUT',
    { threshold: 0.3, api_key: NEW_KEY },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  const jar = await f.jar();
  // The provider keeps its key; the gate repointed to its own entry.
  expect(jar.agent).toBe(OLD_KEY);
  expect(jar['decision-gate']).toBe(NEW_KEY);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'decision-gate' });
  const file = (await f.file()) as FileConfig;
  expect(file.providers.agent?.api_key).toEqual({ jar: 'agent' });
});

test('removing the reference is refused while enabled and allowed once disabled', async () => {
  const f = await fixture({
    keychain: { 'decision-gate': OLD_KEY },
    transform: (config) => {
      config.telegram.decision_gate = { api_key: { jar: 'decision-gate' } };
    },
  });
  // Enabling keeps the existing reference; disabling then allows removing it.
  const enabled = await f.write('/decision-gate', 'PUT', { enabled: true }, (await f.view()).revision);
  expect(enabled.status).toBe(200);
  const bytes = await f.raw();
  const refused = await f.write('/decision-gate', 'PUT', { api_key: null }, (await f.view()).revision);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: 'decision_gate_invalid' });
  expect(await f.raw()).toBe(bytes);
  expect((await gateSection(f))?.api_key).toEqual({ jar: 'decision-gate' });

  const disabled = await f.write('/decision-gate', 'PUT', { enabled: false }, (await f.view()).revision);
  expect(disabled.status).toBe(200);
  const cleared = await f.write('/decision-gate', 'PUT', { api_key: null }, (await f.view()).revision);
  expect(cleared.status).toBe(200);
  expect(Object.hasOwn((await gateSection(f)) ?? {}, 'api_key')).toBe(false);
  // The entry is not reclaimed behind the admin's back.
  expect((await f.jar())['decision-gate']).toBe(OLD_KEY);
});

test('a body that fails validation never echoes the plaintext it carried', async () => {
  const f = await fixture();
  const bytes = await f.raw();
  // The validation error names the unknown field; the key is registered before
  // the body is validated, so even this shape cannot carry it back.
  for (const api_key of [FAILED_KEY, { value: FAILED_KEY }]) {
    const response = await f.write('/decision-gate', 'PUT', { api_key, [FAILED_KEY]: true }, (await f.view()).revision);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(FAILED_KEY);
  }
  expect(await f.raw()).toBe(bytes);
});

test('a rejected write never leaks the submitted plaintext into logs or responses', async () => {
  const f = await fixture();
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  try {
    const accepted = await f.write(
      '/decision-gate',
      'PUT',
      { enabled: true, api_key: NEW_KEY },
      (await f.view()).revision,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain(NEW_KEY);
    const rejected = await f.write(
      '/decision-gate',
      'PUT',
      { base_url: 'http://insecure.example.test', api_key: FAILED_KEY },
      (await f.view()).revision,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(FAILED_KEY);
    expect(logs.join('\n')).not.toContain(NEW_KEY);
    expect(logs.join('\n')).not.toContain(FAILED_KEY);
    // Both submitted values are registered, so a later echo is scrubbed too.
    expect(f.secrets.redact(`x ${NEW_KEY} y`)).not.toContain(NEW_KEY);
    expect(f.secrets.redact(`x ${FAILED_KEY} y`)).not.toContain(FAILED_KEY);
  } finally {
    spy.mockRestore();
  }
});
