import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createSendTools, duplicateSendGuard, type SendToolEnvironment } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { RawConfig } from '../src/platform/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  type TelegramTransport,
  type TestInvocationContext,
  testConfigJsonc,
  testConfigStore,
  testSendToolEnv,
  writeTestConfig,
} from './helpers.ts';

/**
 * Regression contract for the reply-policy content burn: once a send is
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
  build: (invocationId: bigint) => TestInvocationContext;
  close: () => void;
}

async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-send-bypass-'));
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
function conversationContext(
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

interface RecordingApi extends TelegramTransport {
  readonly calls: string[];
}

function recordingApi(gate?: Promise<void>): RecordingApi {
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

const imageGeneration: SendToolEnvironment['imageGeneration'] = {
  resolve: (generationId) =>
    generationId === 'gen-1'
      ? [{ assetId: 'asset-gen-1', bytes: new Uint8Array([1, 2, 3]), fileName: 'pic.png', mime: 'image/png' }]
      : undefined,
};

interface ToolOptions {
  readonly guard?: boolean;
  readonly onRejected?: () => void;
  readonly imageGeneration?: SendToolEnvironment['imageGeneration'];
  readonly holdForNewMessages?: () => boolean;
  readonly allowReplyMessageMultipleTimes?: boolean;
}

function makeTools(
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
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      ...(options.imageGeneration === undefined ? {} : { imageGeneration: options.imageGeneration }),
      ...(options.holdForNewMessages === undefined ? {} : { holdForNewMessages: options.holdForNewMessages }),
      ...(options.allowReplyMessageMultipleTimes === undefined
        ? {}
        : { allowReplyMessageMultipleTimes: options.allowReplyMessageMultipleTimes }),
    }),
    capabilities,
  };
}

interface ToolCallRow {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly state: string;
  readonly error_code: string | null;
}

function toolAudit(store: SqliteStore): ToolCallRow[] {
  return store.db
    .prepare<[], ToolCallRow>('SELECT tool_call_id, tool_name, state, error_code FROM tool_calls ORDER BY id')
    .all();
}

function sendCounts(
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

describe('reply-policy content burn', () => {
  test('rejected text stays unsendable under a changed, omitted or restyled reply target', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      // The rejected call carries the placeholder junk a degenerating model
      // fills every optional field with; narrowing keeps the key stable.
      await expect(
        send.execute('blocked', {
          kind: 'text',
          text: 'second take',
          reply_to_message_id: '11',
          sticker_ref: 'unused',
          image_generation_id: '00000000-0000-0000-0000-000000000000',
          resend: false,
        }),
      ).rejects.toThrow('reply_already_sent');
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'Not sent: send_bypass',
      );
      await expect(send.execute('omit-target', { text: 'second take' })).rejects.toThrow('send_bypass');
      await expect(
        send.execute('restyle', { text: 'second take', parse_mode: 'MarkdownV2', reply_to_message_id: '10' }),
      ).rejects.toThrow('send_bypass');
      // Fresh content on a fresh target is unaffected.
      await send.execute('fresh', { text: 'something else', reply_to_message_id: '10' });
      // reply_already_sent itself is not a guard rejection; the three bypasses are.
      expect(rejections).toBe(3);
      expect(api.calls).toEqual(['first answer', 'something else']);
      expect(toolAudit(fixture.store)).toEqual([
        { tool_call_id: 'answered', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'blocked', tool_name: 'send', state: 'error', error_code: 'reply_already_sent' },
        { tool_call_id: 'retarget', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'omit-target', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'restyle', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'fresh', tool_name: 'send', state: 'success', error_code: null },
      ]);
      // Burn rejections spend no send budget and write no host_sends row.
      expect(sendCounts(fixture.store, context.invocationId)).toEqual({ host_sends: 2n, sends_used: 2n });
    } finally {
      fixture.close();
    }
  });

  test('rejected sticker content burns the same way', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, capabilities } = makeTools(fixture, api, context, { guard: true });
      const first = capabilities.registerStickerRef('CAAD-first-sticker');
      const second = capabilities.registerStickerRef('CAAD-second-sticker');
      await send.execute('sticker', { kind: 'sticker', sticker_ref: first, reply_to_message_id: '11' });
      await expect(
        send.execute('blocked', { kind: 'sticker', sticker_ref: second, reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      await expect(
        send.execute('retarget', { kind: 'sticker', sticker_ref: second, reply_to_message_id: '10' }),
      ).rejects.toThrow('send_bypass');
      expect(api.calls).toEqual(['CAAD-first-sticker']);
    } finally {
      fixture.close();
    }
  });

  test('a fresh sticker ref for the same sticker stays burned', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, capabilities } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      const searched = capabilities.registerStickerRef('CAAD-same-sticker');
      await expect(
        send.execute('blocked', { kind: 'sticker', sticker_ref: searched, reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      // Searching again mints a new stk_ ref for the very same sticker file.
      const searchedAgain = capabilities.registerStickerRef('CAAD-same-sticker');
      expect(searchedAgain).not.toBe(searched);
      await expect(send.execute('re-searched', { kind: 'sticker', sticker_ref: searchedAgain })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'reply_already_sent',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });

  test('an exact repeat of a published reply burns its content', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('repeat', { text: 'first answer', reply_to_message_id: '11' })).rejects.toThrow(
        'send_duplicate',
      );
      await expect(send.execute('omit-target', { text: 'first answer' })).rejects.toThrow('send_bypass');
      await expect(send.execute('retarget', { text: 'first answer', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(rejections).toBe(3);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'send_duplicate',
        'send_bypass',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });

  test('a send_reply repeating a published reply in part 1 burns that part', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send, sendReply } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        sendReply.execute('bundle', { reply_to_message_id: '11', parts: [{ text: 'first answer' }, { text: 'coda' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed. Not sent: send_duplicate');
      await expect(send.execute('omit-target', { text: 'first answer' })).rejects.toThrow('send_bypass');
      expect(rejections).toBe(2);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['answered', null],
        ['bundle', 'send_duplicate'],
        ['bundle:1', 'send_duplicate'],
        ['omit-target', 'send_bypass'],
      ]);
    } finally {
      fixture.close();
    }
  });

  test('an exact repeat does not burn when replies may repeat', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true, allowReplyMessageMultipleTimes: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('repeat', { text: 'first answer', reply_to_message_id: '11' })).rejects.toThrow(
        'send_duplicate',
      );
      // Something else in between, so retargeting is no longer a repeat of the last message.
      await send.execute('interlude', { text: 'by the way' });
      await send.execute('retarget', { text: 'first answer', reply_to_message_id: '10' });
      expect(api.calls).toEqual(['first answer', 'by the way', 'first answer']);
    } finally {
      fixture.close();
    }
  });

  test('reply_delivery_unknown burns the content as well', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const gate = Promise.withResolvers<void>();
      const api = recordingApi(gate.promise);
      const { send } = makeTools(fixture, api, context, { guard: true });
      // execute() runs synchronously up to the gated API call, leaving a
      // committed pending row on reply target 11.
      const pending = send.execute('held', { text: 'held answer', reply_to_message_id: '11' });
      await expect(send.execute('unsure', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_delivery_unknown',
      );
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      gate.resolve();
      await pending;
      expect(api.calls).toEqual(['held answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'reply_delivery_unknown',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });

  test('the send barrier does not burn content', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let held = true;
      const { send } = makeTools(fixture, api, context, { guard: true, holdForNewMessages: () => held });
      await expect(send.execute('held-back', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'new messages arrived',
      );
      held = false;
      await send.execute('released', { text: 'second take', reply_to_message_id: '11' });
      expect(api.calls).toEqual(['second take']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual(['send_barrier', null]);
    } finally {
      fixture.close();
    }
  });

  test('send_reply pre-flight rejects a burned part before anything goes out', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send, sendReply } = makeTools(fixture, api, context, {
        guard: true,
        onRejected: () => (rejections += 1),
      });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      await expect(sendReply.execute('bundle', { parts: [{ text: 'second take' }, { text: 'coda' }] })).rejects.toThrow(
        'Nothing was sent: part 1 was already rejected by the reply policy',
      );
      expect(rejections).toBe(1);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).at(-1)).toEqual({
        tool_call_id: 'bundle',
        tool_name: 'send_reply',
        state: 'error',
        error_code: 'send_bypass',
      });
    } finally {
      fixture.close();
    }
  });

  test('a part rejected mid-delivery burns its content for the rest of the run', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        sendReply.execute('bundle', { reply_to_message_id: '11', parts: [{ text: 'part one' }, { text: 'coda' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed');
      await expect(send.execute('retarget', { text: 'part one', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['answered', null],
        ['bundle', 'reply_already_sent'],
        ['bundle:1', 'reply_already_sent'],
        ['retarget', 'send_bypass'],
      ]);
    } finally {
      fixture.close();
    }
  });

  test('image sends stay exempt from the burn', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true, imageGeneration });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        send.execute('blocked', { kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      // A generation was never delivered by the rejected attempt, so sending it
      // to another target is a first delivery, not a bypass.
      await send.execute('retarget', { kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' });
      expect(api.calls).toEqual(['first answer', 'pic.png']);
    } finally {
      fixture.close();
    }
  });

  test('the burn applies with the duplicate send guard turned off', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: false });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
    } finally {
      fixture.close();
    }
  });

  test('the burn expires with the invocation while reply dedup persists', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      toolAudit(fixture.store); // burn lives on inv2's rows
      const next = conversationContext(fixture, 3, 12, new Date('2026-08-15T00:02:00.000Z'));
      const tools = makeTools(fixture, api, next, { guard: true });
      // A fresh run may say the same words to a fresh message...
      await tools.send.execute('new-run', { text: 'second take', reply_to_message_id: '12' });
      // ...while the old reply target is still claimed, by reply dedup rather
      // than the expired burn.
      await expect(tools.send.execute('old-run', { text: 'third take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      expect(api.calls).toEqual(['first answer', 'second take']);
    } finally {
      fixture.close();
    }
  });
});
