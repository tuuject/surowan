import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, expect } from 'vitest';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  testSendToolEnv,
  type TestContextOptions,
  type TestInvocationContext,
  writeTestConfig,
} from './helpers.ts';
import type { SendToolEnvironment } from '../src/capabilities/send-tool-support.ts';

/**
 * Shared fixtures, store helpers and the regression contract for the reply
 * deduplication suites.
 *
 * This is not a test file: it is imported by the `reply-dedup*.test.ts`
 * suites, and registers their shared temp-directory cleanup.
 *
 * Regression contract for default reply deduplication: one conversation may
 * `send` at most one reply to one Telegram message id unless explicitly allowed,
 * regardless of content changes or switching to a sticker or generated picture.
 *
 * The dedup key is the retained audit (host_sends.conversation_id +
 * request_json.reply_to_message_id), so it holds across invocations, freshly
 * built tools, rebuilt contexts and SQLite close/open. A prior `success`
 * rejects with `reply_already_sent`; a prior `pending` / `outcome_unknown`
 * rejects with `reply_delivery_unknown`; an explicit `error` still allows a
 * retry. A rejection must add no host_sends row, call no API, and consume
 * no sends_used / rate-limit budget / send barrier.
 */

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  build: (invocationId: bigint, options?: TestContextOptions) => TestInvocationContext;
  close: () => void;
}

export async function setup(
  chatIds: number[] = [123456789],
  allowReplyMessageMultipleTimes?: boolean,
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-reply-dedup-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = chatIds.map((id) => ({ id, instructions_file: 'chat-instructions.md' }));
      if (allowReplyMessageMultipleTimes !== undefined) {
        config.agent!.allow_reply_message_multiple_times = allowReplyMessageMultipleTimes;
      }
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
    build: (invocationId, options = {}) => renderInvocationContext(store, loaded.config, invocationId, options),
    close: () => store.close(),
  };
}

export function update(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
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

/** Ingests one message and returns the built context for its invocation. */
export async function conversationContext(
  fixture: Fixture,
  updateId: number,
  messageId: number,
  received: Date,
  text = 'hello',
  chatId = 123456789,
): Promise<TestInvocationContext> {
  fixture.ingestion.ingest(update(updateId, messageId, text, chatId), received);
  const invocationId = processOne(fixture.scheduler, new Date(received.getTime() + 15_000));
  // Close the round so the scheduler opens a fresh invocation for the next
  // message of the same chat, exactly as the runtime does after a run.
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  return fixture.build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
}

export type SendArgs = Parameters<ReturnType<typeof createSendTool>['execute']>[1];
type SendTool = ReturnType<typeof createSendTool>;

interface CountingApi extends TelegramTransport {
  readonly calls: number;
}

export function countingApi(gate?: Promise<void>): CountingApi {
  let calls = 0;
  const respond = async (
    base: number,
    photo = false,
  ): Promise<Awaited<ReturnType<TelegramTransport['sendMessage']>>> => {
    calls += 1;
    const sequence = calls;
    if (gate !== undefined) {
      await gate;
    }
    const response: Awaited<ReturnType<TelegramTransport['sendMessage']>> = {
      message_id: base + sequence,
      date: 1_700_000_100 + sequence,
      chat: { id: 123456789 },
    };
    return photo
      ? { ...response, photo: [{ file_id: 'f1', file_unique_id: 'fu1', width: 100, height: 100 }] }
      : response;
  };
  return {
    get calls() {
      return calls;
    },
    sendMessage: () => respond(500),
    sendSticker: () => respond(600),
    sendGeneratedPhoto: () => respond(700, true),
    sendGeneratedPhotoGroup: (_chatId, pictures) =>
      respond(700, true).then((response) =>
        pictures.map((_picture, index) => ({
          ...response,
          message_id: response.message_id + index,
        })),
      ),
  };
}

export function makeTool(
  store: SqliteStore,
  config: RawConfig,
  context: TestInvocationContext,
  options: {
    readonly api?: TelegramTransport;
    readonly sendsPerWindow?: number;
    readonly imageGeneration?: SendToolEnvironment['imageGeneration'];
    readonly holdForNewMessages?: () => boolean;
  } = {},
): { readonly tool: SendTool; readonly capabilities: ReturnType<typeof invocationCapabilities> } {
  const capabilities = invocationCapabilities(store, config, context.header);
  const tool = createSendTool({
    store,
    ...testSendToolEnv(options.api ?? countingApi(), context),
    context,
    capabilities,
    sendRateLimit: { sendsPerWindow: options.sendsPerWindow ?? 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    allowReplyMessageMultipleTimes: config.agent!.allow_reply_message_multiple_times === true,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    ...(options.imageGeneration === undefined ? {} : { imageGeneration: options.imageGeneration }),
    ...(options.holdForNewMessages === undefined ? {} : { holdForNewMessages: options.holdForNewMessages }),
  });
  return { tool, capabilities };
}

interface ToolCallRow {
  readonly tool_call_id: string;
  readonly state: string;
  readonly error_code: string | null;
}

interface SendRow {
  readonly state: string;
  readonly error_code: string | null;
  readonly request_json: string;
}

export function toolAudit(store: SqliteStore): ToolCallRow[] {
  return store.db.prepare<[], ToolCallRow>('SELECT tool_call_id, state, error_code FROM tool_calls ORDER BY id').all();
}

export function sendAudit(store: SqliteStore): SendRow[] {
  return store.db.prepare<[], SendRow>('SELECT state, error_code, request_json FROM host_sends ORDER BY id').all();
}

export function errorCodeOf(store: SqliteStore, callId: string): string | null {
  for (const row of toolAudit(store)) {
    if (row.tool_call_id === callId) {
      return row.error_code;
    }
  }
  return null;
}

export function sendsUsed(store: SqliteStore, invocationId: bigint): bigint {
  return (
    store.db
      .prepare<[bigint], { sends_used: bigint }>('SELECT sends_used FROM invocations WHERE id = ?')
      .get(invocationId)?.sends_used ?? 0n
  );
}

export async function expectRejected(tool: SendTool, callId: string, args: SendArgs): Promise<void> {
  await expect(tool.execute(callId, args)).rejects.toThrow();
}

export const imageGeneration: SendToolEnvironment['imageGeneration'] = {
  resolve: (generationId) =>
    generationId === 'gen-1' || generationId === 'gen-2'
      ? [{ assetId: `asset-${generationId}`, bytes: new Uint8Array([1, 2, 3]), fileName: 'pic.png', mime: 'image/png' }]
      : undefined,
};
