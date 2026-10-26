import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import type { SearchConfigView } from '../../src/ingress/admin/search.ts';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from '../helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

const DEEPSEEK_MODEL = {
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
  reasoning: false,
  input: ['text' as const],
  context_window: 128_000,
  max_tokens: 8_192,
  cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
};

async function fixture(options: { readonly search?: FileConfig['web_search']; readonly deepseek?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-search-admin-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      if (options.search !== undefined) {
        config.web_search = options.search;
      }
      if (options.deepseek === true) {
        config.providers.deepseek = {
          kind: 'builtin',
          provider: 'deepseek',
          api_key: { jar: 'deepseek' },
          models: [DEEPSEEK_MODEL],
        };
      }
    }),
  );
  await writeTestKeyJar(directory, options.deepseek === true ? { deepseek: 'deepseek-key' } : {});
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
  const view = async (): Promise<SearchConfigView> => (await (await call('/search/config')).json()) as SearchConfigView;
  const save = (body: unknown, revision?: string) =>
    call('/search/config', {
      method: 'PUT',
      headers: { 'if-match': revision ?? '' },
      body: JSON.stringify(body),
    });
  const jar = async (): Promise<Record<string, string>> =>
    JSON.parse(await readFile(keyJarPath(path), 'utf8')) as Record<string, string>;
  return { directory, path, loaded, configStore, store, reloader, call, view, save, jar };
}

const TAVILY = {
  id: 'main',
  provider: 'tavily',
  endpoint: null,
  results: 3,
  timeout_seconds: 10,
  note: 'Chinese developer blogs',
  api_key: 'tvly-new',
  keep_api_key: false,
  key_source: null,
  enabled: true,
};

test('the view lists providers and never returns a configured key', async () => {
  const f = await fixture({
    search: { engines: [{ id: 'main', provider: 'tavily', api_key: { jar: 'search-key' } }] },
    deepseek: true,
  });
  await writeTestKeyJar(f.directory, { deepseek: 'deepseek-key', 'search-key': 'tvly-stored' });
  const view = await f.view();
  expect(view.engines).toEqual([expect.objectContaining({ id: 'main', provider: 'tavily', key_configured: true })]);
  expect(view.providers.map((provider) => provider.id)).toEqual([
    'tavily',
    'brave',
    'exa',
    'firecrawl',
    'deepseek',
    'searxng',
    'youcom',
  ]);
  expect(view.deepseek_keys).toEqual(['deepseek']);
  expect(JSON.stringify(view)).not.toContain('tvly-stored');
  expect(JSON.stringify(view)).not.toContain('deepseek-key');
});

test('saving an engine writes a key-jar entry and applies immediately', async () => {
  const f = await fixture();
  const before = await f.view();
  const response = await f.save({ enabled: true, url_filters: ['csdn'], engines: [TAVILY] }, before.revision);
  expect(response.status).toBe(200);
  const after = (await response.json()) as SearchConfigView;
  expect(after.engines[0]).toMatchObject({ id: 'main', results: 3, timeout_seconds: 10, key_configured: true });
  expect(after.url_filters).toEqual(['csdn']);
  expect(after.active).toBe(true);
  expect(f.configStore.current().config.web_search?.engines?.[0]?.provider).toBe('tavily');
  expect(f.reloader.status().restartRequired).toEqual([]);

  const file = await readFile(f.path, 'utf8');
  expect(file).not.toContain('tvly-new');
  const jar = await f.jar();
  expect(Object.values(jar)).toContain('tvly-new');
  const stored = after.engines[0];
  expect(JSON.stringify(after)).not.toContain('tvly-new');
  expect(stored?.key_configured).toBe(true);
});

test('keeping the key reuses the same reference and never duplicates the jar entry', async () => {
  const f = await fixture();
  const created = await f.save({ enabled: true, url_filters: [], engines: [TAVILY] }, (await f.view()).revision);
  expect(created.status).toBe(200);
  const jarAfterCreate = await f.jar();
  const reference = (await loadConfig(f.path)).fileConfig.web_search?.engines?.[0]?.api_key;
  const saved = await f.save(
    {
      enabled: true,
      url_filters: [],
      engines: [{ ...TAVILY, api_key: null, keep_api_key: true }],
    },
    (await f.view()).revision,
  );
  expect(saved.status).toBe(200);
  expect(await f.jar()).toEqual(jarAfterCreate);
  expect((await loadConfig(f.path)).fileConfig.web_search?.engines?.[0]?.api_key).toEqual(reference);
});

test('a kept key never follows an engine to a different provider', async () => {
  const f = await fixture();
  await f.save({ enabled: true, url_filters: [], engines: [TAVILY] }, (await f.view()).revision);
  const before = await readFile(f.path, 'utf8');
  const jarBefore = await f.jar();
  const response = await f.save(
    {
      enabled: true,
      url_filters: [],
      engines: [{ ...TAVILY, provider: 'brave', api_key: null, keep_api_key: true }],
    },
    (await f.view()).revision,
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string; message: string };
  expect(body.error).toBe('search_invalid');
  expect(body.message).toContain('changed provider');
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(await f.jar()).toEqual(jarBefore);
  expect(f.configStore.current().config.web_search?.engines?.[0]?.provider).toBe('tavily');
});

test('removing an engine recycles the credential it referenced', async () => {
  const f = await fixture();
  await f.save({ enabled: true, url_filters: [], engines: [TAVILY] }, (await f.view()).revision);
  expect(Object.values(await f.jar())).toContain('tvly-new');
  const cleared = await f.save({ enabled: false, url_filters: [], engines: [] }, (await f.view()).revision);
  expect(cleared.status).toBe(200);
  const after = (await cleared.json()) as SearchConfigView;
  expect(after.engines).toEqual([]);
  expect(after.active).toBe(false);
  expect(Object.values(await f.jar())).not.toContain('tvly-new');
});

test('a stale revision is refused and leaves the file untouched', async () => {
  const f = await fixture();
  const first = await f.view();
  const before = await readFile(f.path, 'utf8');
  const stale = await f.save({ enabled: true, url_filters: [], engines: [TAVILY] }, `${first.revision}-stale`);
  expect(stale.status).toBe(409);
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

test('a write landing while the saved file is read back never pairs old engines with its revision', async () => {
  const f = await fixture();
  const first = await f.view();
  const readPersisted = f.reloader.readPersisted.bind(f.reloader);
  let calls = 0;
  vi.spyOn(f.reloader, 'readPersisted').mockImplementation(async (options) => {
    const persisted = await readPersisted(options);
    calls += 1;
    // The second read is the read-back after the save: another writer lands now.
    if (calls === 2) {
      await appendFile(f.path, '\n// external edit\n');
    }
    return persisted;
  });
  const response = await f.save({ enabled: true, url_filters: [], engines: [TAVILY] }, first.revision);
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toBe('config_conflict');
  // The save itself landed; a fresh read shows it under the current revision.
  vi.restoreAllMocks();
  const fresh = await f.view();
  expect(fresh.revision).toBe(await f.reloader.revision());
  expect(fresh.engines.map((engine) => engine.id)).toEqual(['main']);
});

test('a missing If-Match is refused before anything is written', async () => {
  const f = await fixture();
  const response = await f.call('/search/config', {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, url_filters: [], engines: [TAVILY] }),
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe('revision_required');
});

test('an unregistered provider is rejected with a panel error', async () => {
  const f = await fixture();
  const response = await f.save(
    { enabled: true, url_filters: [], engines: [{ ...TAVILY, provider: 'nope' }] },
    (await f.view()).revision,
  );
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe('search_invalid');
  expect((await loadConfig(f.path)).fileConfig.web_search).toBeUndefined();
});

test('a DeepSeek engine can reuse the model provider key', async () => {
  const f = await fixture({ deepseek: true });
  const jarBefore = await f.jar();
  const response = await f.save(
    {
      enabled: true,
      url_filters: [],
      engines: [
        {
          ...TAVILY,
          id: 'ds',
          provider: 'deepseek',
          api_key: null,
          key_source: 'deepseek',
        },
      ],
    },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  const section = (await loadConfig(f.path)).fileConfig.web_search;
  expect(section?.engines?.[0]?.api_key).toEqual({ jar: 'deepseek' });
  expect(await f.jar()).toEqual(jarBefore);
});

test('a keyless SearXNG engine saves with an address and no credential', async () => {
  const f = await fixture();
  const response = await f.save(
    {
      enabled: true,
      url_filters: [],
      engines: [
        {
          id: 'local',
          provider: 'searxng',
          endpoint: 'https://searx.example.com',
          results: null,
          timeout_seconds: null,
          note: null,
          api_key: null,
          keep_api_key: false,
          key_source: null,
          enabled: true,
        },
      ],
    },
    (await f.view()).revision,
  );
  expect(response.status).toBe(200);
  const section = (await loadConfig(f.path)).fileConfig.web_search;
  expect(section?.engines?.[0]).toMatchObject({ id: 'local', provider: 'searxng' });
  expect(section?.engines?.[0]?.api_key).toBeUndefined();
});
