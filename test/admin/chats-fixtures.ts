import { afterEach, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminServer } from '../../src/ingress/admin/index.ts';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { keyJarPath } from '../../src/platform/key-jar.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import type { ChatsView } from '../../apps/admin-next/src/lib/api/chats.ts';

const cleanup: Array<() => Promise<void>> = [];
export const inherited = { topic_ids: null, provider: null, model: null, thinking_level: null };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

export async function fixture(transform?: (config: FixtureConfig) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-chats-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.telegram.chats.push({
        id: -100100,
        topic_ids: [12],
        ignored_user_ids: [42],
        timezone: 'Asia/Shanghai',
        instructions_file: 'chat-instructions.md',
      });
      transform?.(config);
    }),
  );
  const loaded = await loadConfig(path);
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const configStore = await testConfigStore(loaded);
  const secrets = new SecretStore(keyJarPath(path));
  const switcher = new AgentModelSwitcher(configStore);
  const validate = vi.fn();
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets,
    validateAgentModel: validate,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, modelSwitcher: switcher, secrets });
  const request = (route: string, init: RequestInit = {}) =>
    server.handle(new Request(`http://127.0.0.1:8899/api${route}`, init));
  const setup = await request('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'test-correct-horse-battery' }),
  });
  const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  const call = (route: string, init: RequestInit = {}) =>
    request(route, { ...init, headers: { cookie, ...init.headers } });
  const view = async (): Promise<ChatsView> => (await (await call('/chats')).json()) as ChatsView;
  const write = (route: string, method: string, body: unknown, revision: string) =>
    call(route, {
      method,
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify(body),
    });
  return { path, store, configStore, reloader, validate, secrets, request, call, view, write };
}
