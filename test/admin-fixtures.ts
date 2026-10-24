/**
 * Shared store/server fixtures for the Admin API suites.
 *
 * Each fixture boots a real `AdminServer` over a real SQLite store and a real
 * on-disk config, so session auth, body limits and static serving run for real
 * instead of being stubbed.
 *
 * This is not a test file: it is imported by the `admin*.test.ts` suites, and
 * registers their shared temp-directory cleanup.
 */
import { afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { ImConnectionRegistry } from '../src/platform/im-connection.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
export const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export interface Fixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly directory: string;
}

export async function fixture(options: { readonly connections?: ImConnectionRegistry } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeFile(join(staticDir, 'static', 'app.js'), "console.log('admin');");
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
      config.telegram.admins = [7, 42];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return {
    store,
    server: new AdminServer({
      store,
      configStore,
      ...(options.connections === undefined ? {} : { connections: options.connections }),
    }),
    loaded,
    configStore,
    directory,
  };
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export function post(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

export function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

// Audit payloads are asserted structurally, so a loose type keeps assertions readable.
export async function readJson(response: Response): Promise<any> {
  return await response.json();
}

export function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export { PASSWORD };
