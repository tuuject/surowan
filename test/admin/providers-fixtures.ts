import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeAll } from 'vitest';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import type { FileConfig, ModelFileConfig } from '../../src/platform/config/index.ts';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { loadModelsDevCatalog, resetModelsDevCatalogCache } from '../../src/platform/models-dev.ts';
import { buildModelRegistry } from '../../src/platform/providers.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig, writeTestKeyJar } from '../helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

/**
 * The catalog is a whole-catalog download, so the tests seed the module cache
 * with a fixture instead of reaching models.dev. A test that needs the catalog
 * to fail resets the cache and stubs `fetch` for that URL only.
 */
export async function seedModelsDevCatalog(): Promise<void> {
  resetModelsDevCatalogCache();
  const fetchImpl = (async () =>
    Response.json({
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            reasoning: true,
            interleaved: { field: 'reasoning_content' },
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 1_048_576, output: 384_000 },
            cost: { input: 0.03612, output: 0.07224, cache_read: 0.007224 },
          },
        },
      },
    })) as unknown as typeof fetch;
  await loadModelsDevCatalog({ fetchImpl, ttlMs: 600_000 });
}

/** Registers the catalog seed and the per-test cleanup every provider file needs. */
export function installAdminProviderHooks(): void {
  beforeAll(async () => {
    await seedModelsDevCatalog();
  });

  afterEach(async () => {
    delete process.env.PLASTICWAN_SUPERVISED;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
}

export interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly configPath: string;
  readonly directory: string;
  readonly cookie: string;
  readonly restarts: () => number;
  read(): Promise<string>;
  file(): FileConfig;
  /** The plaintext `key.json` holds for a `{ jar }` SecretRef read from the file. */
  secret(reference: unknown): string | undefined;
  jarNames(): string[];
}

export interface FixtureOptions {
  readonly transform?: (config: FixtureConfig) => void;
  readonly onRestart?: () => void;
}

export async function adminFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-providers-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.headers = { 'x-route': { jar: 'header' } };
      }
      options.transform?.(config);
    }),
  );
  await writeTestKeyJar(directory, { header: 'header-secret-value', builtin: 'builtin-secret' });
  const loaded = await loadConfig(configPath);
  // Kept so the restart test can restore a loadable file after breaking it.
  await writeFile(join(directory, 'original.jsonc'), await readFile(configPath, 'utf8'));
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keyJarPath(configPath));
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  const configStore = await testConfigStore(loaded, registry);
  const switcher = new AgentModelSwitcher(configStore);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  let restarts = 0;
  const server = new AdminServer({
    store,
    configStore,
    modelSwitcher: switcher,
    configReloader: reloader,
    secrets,
    requestRestart: () => {
      restarts += 1;
      options.onRestart?.();
    },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    }),
  );
  const cookie = sessionCookie(setup);
  return {
    store,
    server,
    loaded,
    configStore,
    configPath,
    directory,
    cookie,
    restarts: () => restarts,
    read: () => readFile(configPath, 'utf8'),
    file: () => JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig,
    secret: (reference) => {
      const name = (reference as { jar?: unknown } | undefined)?.jar;
      return typeof name === 'string' ? readJar(directory)[name] : undefined;
    },
    jarNames: () => Object.keys(readJar(directory)).sort(),
  };
}

function readJar(directory: string): Record<string, string> {
  return JSON.parse(readFileSync(join(directory, 'key.json'), 'utf8')) as Record<string, string>;
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

// The provider payloads are asserted structurally, so a loose type keeps the
// assertions readable.
export async function readJson(response: Response): Promise<any> {
  return await response.json();
}

export function model(id: string, overrides: Partial<ModelFileConfig> = {}): ModelFileConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    ...overrides,
  };
}

export async function revisionOf(fixture: Fixture): Promise<string> {
  const view = await readJson(await call(fixture, '/api/providers'));
  return view.revision as string;
}

export function call(fixture: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fixture.server.handle(request(path, { ...init, headers: { ...init.headers, cookie: fixture.cookie } }));
}

export function write(
  fixture: Fixture,
  path: string,
  method: string,
  body: unknown,
  revision: string | null = null,
): Promise<Response> {
  return call(fixture, path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(revision === null ? {} : { 'if-match': revision }),
    },
    body: JSON.stringify(body),
  });
}

/** Edits the file behind the panel's back, as a hand edit would. */
export async function rewriteFile(fixture: Fixture, transform: (config: FixtureConfig) => void): Promise<void> {
  const config = JSON.parse(await fixture.read()) as FixtureConfig;
  transform(config);
  await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export const HEALTH_PATH = '/api/providers/health-check';
export const HEALTH_TARGET = { provider: 'agent', model: 'agent-model' };

export function healthMessage(text = 'ok', stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'agent',
    model: 'agent-model',
    content: [{ type: 'text', text }],
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 9,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
