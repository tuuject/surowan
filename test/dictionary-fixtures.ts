/**
 * Shared store/server fixtures for the dictionary suites.
 *
 * `fixture()` builds a real store with one ingested Telegram message and its
 * due invocation; `adminFixture()` drives the real `AdminServer` router with a
 * completed auth setup. Both register their temp directories for `afterAll`
 * cleanup here, so the importing test files never repeat the teardown.
 *
 * This is not a test file: it is imported by `dictionary*.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll } from 'vitest';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

export const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export interface Fixture {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly invocationId: bigint;
}

export async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-dictionary-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: '今天碗怎么不说话了？',
      },
    } satisfies Update,
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  return { store, loaded, configStore, invocationId };
}

export async function adminFixture(): Promise<{
  readonly server: AdminServer;
  readonly store: SqliteStore;
  readonly cookie: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-dictionary-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(staticDir, { recursive: true });
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
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const secrets = new SecretStore(keyJarPath(configPath));
  const switcher = new AgentModelSwitcher(configStore);
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const store = await SqliteStore.open(loaded.config);
  const server = new AdminServer({
    store,
    configStore,
    modelSwitcher: switcher,
    configReloader: reloader,
    secrets,
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
    }),
  );
  return { server, store, cookie: sessionCookie(setup) };
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export async function readJson(response: Response): Promise<any> {
  return await response.json();
}

export function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

export function draftBody(term: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    term,
    definition: `Definition for ${term}`,
    aliases: [],
    scope: 'global',
    chat_id: null,
    enabled: true,
    ...overrides,
  };
}
