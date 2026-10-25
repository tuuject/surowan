import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LoadedConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { InvocationHandler } from '../../src/orchestration/scheduler/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

export const stores: SqliteStore[] = [];
export const directories: string[] = [];

export interface SetupResult {
  readonly directory: string;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly store: SqliteStore;
  readonly scheduler: BucketScheduler;
  readonly tasks: LongTaskService;
  readonly conversationId: bigint;
}

export async function cleanupTaskRuntime(): Promise<void> {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function setup(
  transform?: (config: FixtureConfig) => void,
  handler: InvocationHandler = async () => ({ state: 'completed', reason: 'test' }),
): Promise<SetupResult> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-task-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  addConversation(store, 1n, 1n, 123456789n, 0n, 'private');
  const tasks = new LongTaskService(store.orm);
  return {
    directory,
    loaded,
    configStore,
    store,
    tasks,
    conversationId: 1n,
    scheduler: new BucketScheduler(store, configStore, handler, undefined, tasks),
  };
}

export function addConversation(
  store: SqliteStore,
  chatId: bigint,
  conversationId: bigint,
  telegramChatId: bigint,
  threadId: bigint,
  type = 'private',
): void {
  const at = '2026-01-01T00:00:00.000Z';
  store.db
    .prepare(
      'INSERT OR IGNORE INTO chats(id, telegram_chat_id, canonical_chat_id, type, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(chatId, telegramChatId, telegramChatId, type, at);
  store.db
    .prepare('INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, chatId, threadId, at, at);
}

export function insertInvocation(
  store: SqliteStore,
  id: bigint,
  conversationId: bigint,
  state: 'queued' | 'running' | 'completed',
  kind = 'realtime',
): bigint {
  const at = new Date(Date.now() - 1_000).toISOString();
  store.db
    .prepare(
      'INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, conversationId, state === 'completed' ? 'completed' : state, kind, at, at, at, at);
  store.db
    .prepare(
      "INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at, started_at) VALUES (?, ?, ?, ?, 'h', 1, ?, ?)",
    )
    .run(id, id, conversationId, state, at, state === 'running' ? at : null);
  store.db
    .prepare('INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at, injected_at) VALUES (?, ?, ?, ?)')
    .run(id, id, at, at);
  return id;
}

export function taskState(
  store: SqliteStore,
  taskId: bigint,
): { state: string; invocation_id: bigint | null } | undefined {
  return store.db
    .prepare<[bigint], { state: string; invocation_id: bigint | null }>(
      'SELECT state, invocation_id FROM task_receipts WHERE task_id = ?',
    )
    .get(taskId);
}

export async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
