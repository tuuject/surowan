/**
 * Shared server/config fixtures for the Admin prompt-editing suites.
 *
 * Driven through the real `AdminServer` router over a real store, the real
 * config reloader and real prompt files on disk: the contract under test is
 * that a panel save rewrites the configured file, records a prompt version and
 * publishes a new config hash, while external edits only become versions on the
 * next apply.
 *
 * This is not a test file: it is imported by the `prompts-admin*.test.ts`
 * suites, and registers their shared temp-directory cleanup.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { FileConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { recordPromptVersionsFromConfig } from '../src/store/prompt-versions.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly reloader: ConfigReloader;
  readonly configStore: RuntimeConfigurationStore;
  readonly directory: string;
  readonly configPath: string;
}

export async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-prompts-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      transform?.(config);
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  // The composition root records the starting versions after the store opens;
  // mirror that so every test sees the startup recording behavior.
  recordPromptVersionsFromConfig(store.orm, loaded.config);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => recordPromptVersionsFromConfig(store.orm, configStore.current().config),
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader });
  return { store, server, reloader, configStore, directory, configPath };
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export function post(path: string, body: unknown, cookie?: string, ifMatch?: string): Request {
  return request(path, {
    method: 'POST',
    headers: promptHeaders(cookie, ifMatch),
    body: JSON.stringify(body),
  });
}

export function put(path: string, body: unknown, cookie: string, ifMatch?: string): Request {
  return request(path, { method: 'PUT', headers: promptHeaders(cookie, ifMatch), body: JSON.stringify(body) });
}

function promptHeaders(cookie: string | undefined, ifMatch: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers['if-match'] = ifMatch;
  }
  return headers;
}

export async function login(server: AdminServer): Promise<string> {
  const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
  const cookie = created.headers.get('set-cookie');
  if (cookie === null) {
    throw new Error('Expected a session cookie');
  }
  return cookie.slice(0, cookie.indexOf(';'));
}

// Audit payloads are asserted structurally, so a loose type keeps assertions readable.
export async function readJson(response: Response): Promise<any> {
  return await response.json();
}
