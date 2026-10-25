import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { createSendTools } from '../../src/capabilities/send/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  type TelegramTransport,
  type TestInvocationContext,
  testConfigJsonc,
  testConfigStore,
  testSendToolEnv,
  writeTestConfig,
} from '../helpers.ts';
import { duplicateSendGuard } from '../../src/capabilities/send/support.ts';
import type { SendToolEnvironment } from '../../src/capabilities/send/support.ts';

/**
 * Fixtures for the reply-policy content burn contract: once a send is
 * rejected as `reply_already_sent` or `reply_delivery_unknown`, that exact
 * text or sticker stays unsendable for the rest of the invocation — the
 * rejection message has always said "do not bypass by omitting or changing
 * reply_to_message_id", and `send_bypass` now enforces it. The burn is keyed
 * on content (kind + text / sticker_ref), never on the reply target, and it
 * expires with the invocation. Barrier and rate-limit rejections never burn,
 * since both explicitly allow a later retry; images stay exempt, like in the
 * duplicate send guard.
 */

const directories: string[] = [];

/** Registers the directory teardown every send-bypass file needs. */
export function installSendBypassGuardHooks(): void {
  afterAll(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
    );
  });
}

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  build: (invocationId: bigint) => TestInvocationContext;
  close: () => void;
}

export async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-send-bypass-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: 123456789, instructions_file: 'chat-instructions.md' }];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  return {
    store,
    config: loaded.config,
    configStore,
    ingestion,
    scheduler,
    build: (invocationId) =>
      renderInvocationContext(store, loaded.config, invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 }),
    close: () => store.close(),
  };
}

function update(updateId: number, messageId: number, text: string): Update {
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

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

/** Opens one invocation per message, closing each round like the runtime does. */
export function conversationContext(
  fixture: Fixture,
  updateId: number,
  messageId: number,
  received: Date,
  text = 'hello',
): TestInvocationContext {
  fixture.ingestion.ingest(update(updateId, messageId, text), received);
  const invocationId = processOne(fixture.scheduler, new Date(received.getTime() + 15_000));
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  return fixture.build(invocationId);
}

export interface RecordingApi extends TelegramTransport {
  readonly calls: string[];
}

export function recordingApi(gate?: Promise<void>): RecordingApi {
  const calls: string[] = [];
  const respond = async (content: string, base: number, photo = false) => {
    calls.push(content);
    if (gate !== undefined) {
      await gate;
    }
    const response = { message_id: base + calls.length, date: 1_700_000_100 + calls.length, chat: { id: 123456789 } };
    return photo
      ? { ...response, photo: [{ file_id: 'f1', file_unique_id: 'fu1', width: 100, height: 100 }] }
      : response;
  };
  return {
    calls,
    sendMessage: (_chatId, text) => respond(text, 500),
    sendSticker: (_chatId, sticker) => respond(sticker, 600),
    sendGeneratedPhoto: (_chatId, _bytes, fileName) => respond(fileName, 700, true),
    sendGeneratedPhotoGroup: (_chatId, pictures) =>
      respond(pictures[0]?.fileName ?? 'group', 700, true).then((response) =>
        pictures.map((_picture, index) => ({ ...response, message_id: response.message_id + index })),
      ),
  };
}

export const imageGeneration: SendToolEnvironment['imageGeneration'] = {
  resolve: (generationId) =>
    generationId === 'gen-1'
      ? [{ assetId: 'asset-gen-1', bytes: new Uint8Array([1, 2, 3]), fileName: 'pic.png', mime: 'image/png' }]
      : undefined,
};

export interface ToolOptions {
  readonly guard?: boolean;
  readonly onRejected?: () => void;
  readonly imageGeneration?: SendToolEnvironment['imageGeneration'];
  readonly holdForNewMessages?: () => boolean;
  readonly allowReplyMessageMultipleTimes?: boolean;
}

export function makeTools(
  fixture: Fixture,
  api: TelegramTransport,
  context: TestInvocationContext,
  options: ToolOptions = {},
) {
  const capabilities = invocationCapabilities(fixture.store, fixture.config, context.header);
  return {
    ...createSendTools({
      store: fixture.store,
      ...testSendToolEnv(api, context),
      context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 50, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      ...duplicateSendGuard(options.guard, options.onRejected ?? (() => {})),
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      ...(options.imageGeneration === undefined ? {} : { imageGeneration: options.imageGeneration }),
      ...(options.holdForNewMessages === undefined ? {} : { holdForNewMessages: options.holdForNewMessages }),
      ...(options.allowReplyMessageMultipleTimes === undefined
        ? {}
        : { allowReplyMessageMultipleTimes: options.allowReplyMessageMultipleTimes }),
    }),
    capabilities,
  };
}

export interface ToolCallRow {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly state: string;
  readonly error_code: string | null;
}

export function toolAudit(store: SqliteStore): ToolCallRow[] {
  return store.db
    .prepare<[], ToolCallRow>('SELECT tool_call_id, tool_name, state, error_code FROM tool_calls ORDER BY id')
    .all();
}

export function sendCounts(
  store: SqliteStore,
  invocationId: bigint,
): { readonly host_sends: bigint; readonly sends_used: bigint } {
  const row = store.db
    .prepare<[bigint], { host_sends: bigint; sends_used: bigint }>(
      'SELECT (SELECT COUNT(*) FROM host_sends) AS host_sends, sends_used FROM invocations WHERE id = ?',
    )
    .get(invocationId);
  if (row === undefined) {
    throw new Error('invocation row is missing');
  }
  return row;
}
