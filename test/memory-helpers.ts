import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

export async function cleanupDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export interface Fixture {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly conversationId: bigint;
  readonly invocationId: bigint;
}

export async function fixture(): Promise<Fixture> {
  const directory = await tempDirectory('plasticwan-memory-');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const conversation = store.db
    .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
    .get(invocationId);
  if (conversation === undefined) {
    throw new Error('Expected the invocation conversation');
  }
  return { store, loaded, configStore, conversationId: conversation.conversation_id, invocationId };
}

export function secondConversation(store: SqliteStore, conversationId: bigint): bigint {
  const chat = store.db
    .prepare<[bigint], { chat_id: bigint }>('SELECT chat_id FROM conversations WHERE id = ?')
    .get(conversationId);
  if (chat === undefined) {
    throw new Error('Expected the conversation chat');
  }
  const timestamp = new Date().toISOString();
  const created = store.db
    .prepare('INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 1, ?, ?)')
    .run(chat.chat_id, timestamp, timestamp);
  return BigInt(created.lastInsertRowid);
}

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

// Admin payloads are asserted structurally, so a loose type keeps assertions readable.
export async function readJson(response: Response): Promise<any> {
  return await response.json();
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
