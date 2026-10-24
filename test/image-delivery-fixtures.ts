/** Shared store, ingestion, scheduler and fake Telegram transport for the `send kind:image` suites. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll } from 'vitest';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { CapabilityRefResolver } from '../src/platform/invocation-context.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  testSendToolEnv,
  type TestInvocationContext,
  writeTestConfig,
} from './helpers.ts';

export const CHAT_ID = 123456789;
export const OTHER_CHAT_ID = 987654321;
export const START = new Date('2026-08-15T00:00:00.000Z');
export const GENERATION_ID = '7b2f8f3a-9c4d-4e5f-8a6b-1c2d3e4f5a6b';
export const OTHER_GENERATION_ID = '11111111-2222-4333-8444-555555555555';
export const THIRD_GENERATION_ID = '99999999-8888-4777-8666-555555555555';
export const ALREADY_DELIVERED = /already[\s_-]*(been[\s_-]*)?delivered/i;

export interface Picture {
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mime: string;
}

export function picture(assetId: string, fileName: string): Picture {
  return { assetId, fileName, mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, assetId.length]) };
}

export const ASSET_A = picture('asset-a', 'a.png');
export const ASSET_B = picture('asset-b', 'b.png');

const directories: string[] = [];
export const openedStores: SqliteStore[] = [];

afterAll(async () => {
  // Windows keeps the SQLite files locked while a store is open; close every
  // store a failed test left behind before removing the temp directories.
  for (const store of openedStores) {
    if (store.db.open) {
      store.close();
    }
  }
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly build: (invocationId: bigint) => TestInvocationContext;
}

export async function setup(extraChatIds: readonly number[] = []): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-delivery-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      for (const id of extraChatIds) {
        config.telegram.chats.push({ id });
      }
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  openedStores.push(store);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (invocationId) =>
      renderInvocationContext(store, loaded.config, invocationId, { contextWindow: 200_000, maxOutputTokens: 32_768 }),
  };
}

export interface PhotoAttempt {
  readonly chatId: string;
  readonly fileNames: readonly string[];
  readonly caption: string | undefined;
}

export interface FakeTelegram extends TelegramTransport {
  readonly photoAttempts: PhotoAttempt[];
  readonly photoDeliveries: PhotoAttempt[];
  textSends: number;
  stickerSends: number;
}

export function photoResponse(messageId: number) {
  return {
    message_id: messageId,
    date: 1_700_000_100,
    chat: { id: CHAT_ID },
    photo: [{ file_id: `photo-${messageId}`, file_unique_id: `unique-${messageId}`, width: 512, height: 512 }],
  };
}

/** Fake Telegram API; `beforePhoto` runs before an attempt settles and may throw. */
export function fakeTelegram(beforePhoto?: (attempt: number) => void | Promise<void>): FakeTelegram {
  const api: FakeTelegram = {
    photoAttempts: [],
    photoDeliveries: [],
    textSends: 0,
    stickerSends: 0,
    sendMessage: async () => {
      api.textSends += 1;
      return { message_id: 900, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => {
      api.stickerSends += 1;
      return { message_id: 950, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendGeneratedPhoto: async (chatId, _bytes, fileName, options) => {
      const attempt = { chatId, fileNames: [fileName], caption: options.caption };
      api.photoAttempts.push(attempt);
      await beforePhoto?.(api.photoAttempts.length - 1);
      const messageId = 500 + api.photoDeliveries.length;
      api.photoDeliveries.push(attempt);
      return photoResponse(messageId);
    },
    sendGeneratedPhotoGroup: async (chatId, pictures, options) => {
      const attempt = { chatId, fileNames: pictures.map((entry) => entry.fileName), caption: options.caption };
      api.photoAttempts.push(attempt);
      await beforePhoto?.(api.photoAttempts.length - 1);
      const firstMessageId = 500 + api.photoDeliveries.length;
      api.photoDeliveries.push(attempt);
      return pictures.map((_entry, index) => photoResponse(firstMessageId + index));
    },
  };
  return api;
}

export interface ToolOptions {
  readonly api?: FakeTelegram;
  readonly pictures?: (generationId: string, conversationId: bigint) => readonly Picture[] | undefined;
  readonly context?: Partial<Pick<TestInvocationContext, 'completion' | 'callerUserId'>>;
  readonly sendRateLimit?: { readonly sendsPerWindow: number; readonly windowSeconds: number };
  readonly capabilities?: CapabilityRefResolver;
}

export function buildTool(
  fixture: Fixture,
  context: TestInvocationContext,
  options: ToolOptions = {},
): { readonly tool: ReturnType<typeof createSendTool>; readonly api: FakeTelegram } {
  const api = options.api ?? fakeTelegram();
  const resolvePictures = options.pictures ?? (() => [ASSET_A]);
  const toolContext = { ...context, ...(options.context ?? {}) };
  const tool = createSendTool({
    store: fixture.store,
    ...testSendToolEnv(api, toolContext),
    context: toolContext,
    capabilities: options.capabilities ?? invocationCapabilities(fixture.store, fixture.config, context.header),
    sendRateLimit: options.sendRateLimit ?? { sendsPerWindow: 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
    imageGeneration: {
      resolve: (generationId, conversationId) =>
        resolvePictures(generationId, conversationId)?.map(({ assetId, bytes, fileName, mime }) => ({
          assetId,
          bytes,
          fileName,
          mime,
        })),
    },
  });
  return { tool, api };
}

export function update(updateId: number, messageId: number, text: string, chatId = CHAT_ID): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

export function completeInvocation(store: SqliteStore, invocationId: bigint): void {
  store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
}

export function openConversation(
  fixture: Fixture,
  messageId: number,
  receivedAt: Date,
  chatId = CHAT_ID,
): TestInvocationContext {
  fixture.ingestion.ingest(update(messageId, messageId, `message-${messageId}`, chatId), receivedAt);
  return fixture.build(processOne(fixture.scheduler, new Date(receivedAt.getTime() + 15_000)));
}

export interface SendRow {
  readonly id: bigint;
  readonly state: string;
  readonly error_code: string | null;
  readonly telegram_message_id: bigint | null;
  readonly request_json: string;
  readonly conversation_id: bigint;
}

export function sendRows(store: SqliteStore): SendRow[] {
  return store.db
    .prepare<[], SendRow>(
      'SELECT id, state, error_code, telegram_message_id, request_json, conversation_id FROM host_sends ORDER BY id',
    )
    .all();
}

export function imageRequests(store: SqliteStore): Record<string, unknown>[] {
  return sendRows(store).map((row) => JSON.parse(row.request_json) as Record<string, unknown>);
}

export function toolCalls(store: SqliteStore) {
  return store.db
    .prepare<[], { tool_call_id: string; state: string; side_effect: bigint; error_code: string | null }>(
      'SELECT tool_call_id, state, side_effect, error_code FROM tool_calls ORDER BY id',
    )
    .all();
}

export function sendsUsed(store: SqliteStore): bigint[] {
  return store.db
    .prepare<[], { sends_used: bigint }>('SELECT sends_used FROM invocations ORDER BY id')
    .all()
    .map((row) => row.sends_used);
}

export function contentText(result: { readonly content: readonly { readonly type: string }[] }): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

export function resultText(store: SqliteStore, toolCallId: string): string {
  return (
    store.db
      .prepare<[string], { result_text: string | null }>('SELECT result_text FROM tool_calls WHERE tool_call_id = ?')
      .get(toolCallId)?.result_text ?? ''
  );
}
