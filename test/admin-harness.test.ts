import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HarnessSettings } from '../apps/admin-next/src/lib/api.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-harness-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.agent!.send_max_text_length = 2000;
    }),
  );
  const loaded = await loadConfig(path);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keyJarPath(path));
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    secrets,
    validateAgentModel: vi.fn(),
    modelSwitcher: new AgentModelSwitcher(configStore),
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, secrets });
  cleanup.push(async () => {
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route: string, init: RequestInit = {}) =>
    server.handle(new Request(`http://127.0.0.1:8899/api${route}`, init));
  const setup = await request('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'test-correct-horse-battery' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const call = (route: string, init: RequestInit = {}) =>
    request(route, { ...init, headers: { cookie, origin: 'http://127.0.0.1:8899', ...init.headers } });
  const view = async (): Promise<HarnessSettings> => (await (await call('/harness')).json()) as HarnessSettings;
  const update = (values: Record<string, unknown>, revision: string) =>
    call('/harness', { method: 'PUT', headers: { 'if-match': revision }, body: JSON.stringify({ values }) });
  return { loaded, path, configStore, store, reloader, call, view, update };
}

test('reports file and running values with absent optional fields resolved', async () => {
  const f = await fixture();
  const view = await f.view();
  const agent = f.loaded.config.agent;
  expect(view.saved).toEqual(view.active);
  expect(view.saved).toMatchObject({
    'daily_budget.max_tokens': agent.daily_budget.max_tokens,
    'context.ref_ttl_hours': agent.context.ref_ttl_hours,
    'rate_limits.window_seconds': agent.rate_limits.window_seconds,
    send_max_text_length: 2000,
    memory_ttl_warning_days: 30,
    allow_reply_message_multiple_times: false,
    send_duplicate_guard_enabled: true,
  });
  // The model selection and the prompt have their own pages.
  expect(Object.keys(view.saved)).not.toContain('provider');
  expect(Object.keys(view.saved)).not.toContain('thinking_level');
  expect(Object.keys(view.saved)).not.toContain('system_prompt_file');
});

test('a write hot-applies every changed field, including the ones that used to need a restart', async () => {
  const f = await fixture();
  seedAdminFixture(f.store);
  const longTtl = async () =>
    ((await (await f.call('/memories?state=long_ttl')).json()) as { items: unknown[] }).items.length;
  expect(await longTtl()).toBe(0);
  const response = await f.update(
    {
      'context.ref_ttl_hours': 24,
      'context.agent_cache_size': 2,
      'context.retained_sends_target': 1,
      'context.hard_token_ratio': 0.5,
      memory_ttl_warning_days: 7,
      history_messages: 9,
      send_nudge_enabled: true,
      send_duplicate_guard_enabled: false,
      send_max_text_length: null,
    },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as HarnessSettings & { apply: { applied: string[]; restart_required: [] } };
  expect(body.apply.restart_required).toEqual([]);
  expect(body.apply.applied).toEqual(
    expect.arrayContaining([
      'agent.context.ref_ttl_hours',
      'agent.context.agent_cache_size',
      'agent.memory_ttl_warning_days',
      'agent.send_max_text_length',
      'agent.send_duplicate_guard_enabled',
    ]),
  );
  expect(body.active).toEqual(body.saved);
  expect(body.saved).toMatchObject({ 'context.ref_ttl_hours': 24, send_max_text_length: null });
  const active = f.configStore.current().config.agent;
  expect(active.context).toMatchObject({ ref_ttl_hours: 24, agent_cache_size: 2, retained_sends_target: 1 });
  expect(active.memory_ttl_warning_days).toBe(7);
  expect(active.send_duplicate_guard_enabled).toBe(false);
  expect(active.send_max_text_length).toBeUndefined();
  expect(f.reloader.status().restartRequired).toEqual([]);
  // The removed optional field is gone from the file, not written as null.
  const file = (await loadConfig(f.path)).fileConfig.agent;
  expect(Object.hasOwn(file ?? {}, 'send_max_text_length')).toBe(false);
  expect(file?.provider).toBe(f.loaded.fileConfig.agent!.provider);
  // The memory review window reads the applied value on the next request.
  expect(await longTtl()).toBe(1);
});

test('a value equal to the file, or to an absent default, writes nothing', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const { revision } = await f.view();
  const response = await f.update(
    {
      history_messages: f.loaded.config.agent!.history_messages,
      memory_ttl_warning_days: 30,
      send_duplicate_guard_enabled: true,
    },
    revision,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision, apply: { applied: [] } });
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

test.each([
  [{ provider: 'other' }, 'invalid_body'],
  [{ 'context.ref_ttl_hours': 0 }, 'invalid_harness_value'],
  [{ 'context.ref_ttl_hours': 1.5 }, 'invalid_harness_value'],
  [{ context_stop_ratio: 0.9 }, 'invalid_harness_value'],
  [{ send_nudge_enabled: 'yes' }, 'invalid_harness_value'],
  // Every field accepts null (remove → back to default); a wrong type is rejected.
  [{ history_messages: 'many' }, 'invalid_harness_value'],
  [{}, 'invalid_body'],
])('rejects %j before touching the file', async (values, error) => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const response = await f.update(values, (await f.view()).revision);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error });
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

test('cross-field rules are checked against the whole configuration', async () => {
  const f = await fixture();
  const before = await readFile(f.path, 'utf8');
  const response = await f.update(
    { 'context.retained_sends_target': f.loaded.config.agent!.context!.retained_sends_max },
    (await f.view()).revision,
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: 'config_invalid' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(f.configStore.current().config.agent).toEqual(f.loaded.config.agent);
});

test('a stale or missing revision is refused', async () => {
  const f = await fixture();
  expect((await f.update({ history_messages: 3 }, 'stale')).status).toBe(409);
  const missing = await f.call('/harness', {
    method: 'PUT',
    body: JSON.stringify({ values: { history_messages: 3 } }),
  });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'revision_required' });
  expect(f.configStore.current().config.agent!.history_messages).toBe(f.loaded.config.agent!.history_messages);
});
