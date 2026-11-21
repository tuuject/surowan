import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import type { DecisionGateView } from '../../src/ingress/admin/decision-gate/index.ts';
import type { FileConfig } from '../../src/platform/config/index.ts';
import { keychainPath, readKeychain } from '../../src/platform/keychain.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { createAdminAccount } from '../fixtures/admin-account.ts';
import {
  type FixtureConfig,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  writeTestKeychain,
} from '../helpers.ts';

/**
 * Fixture for the Decisions entry gate's Admin API: a real `AdminServer`, a
 * real `config.jsonc`, a real keychain and a real `ConfigReloader`, so the
 * revision, the apply and the keychain write all run for real.
 */

const PASSWORD = 'decision-gate-panel-password';
const GROUP = -1_001_234_567_890;
const PRIVATE = 123_456_789;
const directories: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of directories.splice(0)) {
    await close();
  }
});

export interface FixtureOptions {
  readonly transform?: (config: FixtureConfig) => void;
  readonly keychain?: Readonly<Record<string, string>>;
}

export async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-decision-gate-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    path,
    testConfigJsonc(directory, (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
      config.telegram.chats.push({ id: GROUP, instructions_file: 'chat-instructions.md' });
      options.transform?.(config);
    }),
  );
  await writeTestKeychain(directory, options.keychain);
  const loaded = await loadConfig(path);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keychainPath(path));
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    secrets,
    validateAgentModel: () => undefined,
    modelSwitcher: new AgentModelSwitcher(configStore),
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader: reloader, secrets });
  directories.push(async () => {
    await server.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route: string, init: RequestInit = {}) =>
    server.handle(new Request(`http://127.0.0.1:8899/api${route}`, init));
  await createAdminAccount(store.orm, { username: 'owner', password: PASSWORD });
  const setup = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: PASSWORD }),
  });
  const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  const call = (route: string, init: RequestInit = {}) =>
    request(route, { ...init, headers: { cookie, origin: 'http://127.0.0.1:8899', ...init.headers } });
  const write = (
    route: string,
    method: string,
    body: unknown,
    revision: string,
    headers: Record<string, string> = {},
  ) =>
    call(route, {
      method,
      headers: { 'content-type': 'application/json', 'if-match': revision, ...headers },
      body: JSON.stringify(body),
    });
  const view = async (): Promise<DecisionGateView> => (await (await call('/decision-gate')).json()) as DecisionGateView;
  const raw = async (): Promise<string> => await readFile(path, 'utf8');
  const file = async (): Promise<FileConfig> => JSON.parse(await raw()) as FileConfig;
  /** Entry name → value, through the keychain module rather than the raw file. */
  const jar = async (): Promise<Record<string, string>> => {
    const entries = (await readKeychain(keychainPath(path))) ?? {};
    return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.value]));
  };
  /** A bearer key created by the panel session, with the given mode. */
  const bearerKey = async (mode = 'read_write'): Promise<Record<string, string>> => {
    const created = await call('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `key-${mode}`, mode }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { key: string };
    return { authorization: `Bearer ${body.key}` };
  };
  const bearerCall = (route: string, init: RequestInit = {}, auth: Record<string, string>) =>
    request(route, { ...init, headers: { ...auth, ...init.headers } });
  const bearerWrite = (
    route: string,
    method: string,
    body: unknown,
    revision: string,
    auth: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    bearerCall(
      route,
      {
        method,
        headers: { 'content-type': 'application/json', 'if-match': revision, ...headers },
        body: JSON.stringify(body),
      },
      auth,
    );
  return {
    directory,
    path,
    loaded,
    store,
    configStore,
    reloader,
    secrets,
    call,
    write,
    view,
    raw,
    file,
    jar,
    bearerKey,
    bearerCall,
    bearerWrite,
  };
}

export { GROUP, PRIVATE };

/** One conversation and bucket per seeded decision row, with the given verdict fields. */
export interface DecisionSeed {
  readonly telegramChatId: number;
  readonly conversationId: bigint;
  readonly mode?: 'shadow' | 'enforce';
  readonly state?: string;
  readonly outcome?: 'enter' | 'drop' | null;
  readonly applied?: boolean;
  readonly probability?: number | null;
  readonly createdAt?: string;
}

/**
 * Inserts a Telegram chat (once), its conversation, one bucket and one decision
 * row. Ids are assigned by SQLite so insertion order is the listing order.
 */
export function seedDecision(
  store: SqliteStore,
  seed: DecisionSeed,
  details: { readonly model?: string; readonly errorCode?: string; readonly errorDetail?: string } = {},
): bigint {
  const createdAt = seed.createdAt ?? new Date().toISOString();
  const existing = store.db
    .prepare<[string, bigint], { id: bigint }>('SELECT id FROM chats WHERE host_kind = ? AND host_chat_id = ?')
    .get('telegram', BigInt(seed.telegramChatId));
  const chatId =
    existing?.id ??
    (() => {
      const info = store.db
        .prepare(
          `INSERT INTO chats(host_kind, host_chat_id, canonical_chat_id, type, title, updated_at)
           VALUES ('telegram', ?, ?, 'supergroup', ?, ?)`,
        )
        .run(BigInt(seed.telegramChatId), BigInt(seed.telegramChatId), `chat ${seed.telegramChatId}`, createdAt);
      return BigInt(info.lastInsertRowid);
    })();
  // One Conversation per seeded row: (chat, thread) is unique, so the
  // Conversation id stands in for the thread id.
  store.db
    .prepare(
      `INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(seed.conversationId, chatId, seed.conversationId, createdAt, createdAt);
  const bucket = store.db
    .prepare(
      `INSERT INTO buckets(conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
       VALUES (?, 'completed', 'realtime', ?, ?, ?, ?)`,
    )
    .run(seed.conversationId, createdAt, createdAt, createdAt, createdAt);
  const bucketId = BigInt(bucket.lastInsertRowid);
  const decision = store.db
    .prepare(
      `INSERT INTO bucket_decisions
         (bucket_id, conversation_id, mode, model, state, outcome, applied, probability, threshold,
          history_count, pending_count, input_tokens, cost, duration_ms, error_code, error_detail,
          created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.57, 6, 3, 190, 0.0004, 730, ?, ?, ?, ?)`,
    )
    .run(
      bucketId,
      seed.conversationId,
      seed.mode ?? 'shadow',
      details.model ?? 'typesafe/jev-1.14',
      seed.state ?? 'success',
      seed.outcome === undefined ? 'enter' : seed.outcome,
      seed.applied === true ? 1 : 0,
      seed.probability === undefined ? 0.81 : seed.probability,
      details.errorCode ?? null,
      details.errorDetail ?? null,
      createdAt,
      createdAt,
    );
  return BigInt(decision.lastInsertRowid);
}
