import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';
import { AdminServer, type ReplayInvocationInput } from '../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

/** Registers the directory teardown every API-key file needs. */
export function installAdminApiKeyHooks(): void {
  afterAll(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
    );
  });
}

export interface ReplayCall {
  readonly id: bigint;
  readonly input: ReplayInvocationInput;
  readonly signal: AbortSignal;
}

export type ReplayFn = (id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>;

export interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly secrets: SecretStore;
  readonly calls: ReplayCall[];
}

export async function fixture(replay?: ReplayFn): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-api-keys-'));
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
    }),
  );
  const loaded: LoadedConfig = await loadConfig(configPath);
  const configStore: RuntimeConfigurationStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore();
  const server =
    replay === undefined
      ? new AdminServer({ store, configStore, secrets })
      : new AdminServer({ store, configStore, secrets, replayInvocation: replay });
  return { store, server, secrets, calls: [] };
}

export async function setupAdmin(server: AdminServer): Promise<string> {
  const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
  expect(created.status).toBe(200);
  return sessionCookie(created);
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

export async function readJson(response: Response): Promise<any> {
  return await response.json();
}

export async function createKey(server: AdminServer, cookie: string, name = 'eval-cli'): Promise<any> {
  const response = await server.handle(post('/api/api-keys', { name }, { cookie }));
  expect(response.status).toBe(200);
  return await readJson(response);
}
