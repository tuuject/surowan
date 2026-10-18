import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createSendTools, duplicateSendGuard } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { RawConfig } from '../src/platform/config.ts';
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
 * Contract for the duplicate send guard (`agent.send_duplicate_guard_enabled`,
 * on unless set to false): within one invocation, a text or sticker identical
 * to one Telegram already accepted is rejected as `send_duplicate` without
 * reaching Telegram, and every rejection is reported so the run can stop.
 * The content of the message published right before may not be repeated
 * either, whatever reply target or parse mode the repeat carries.
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
  readonly context: TestInvocationContext;
}

async function setup(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-duplicate-send-'));
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
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_010,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'look at this',
      },
    },
    received,
  );
  ingestion.ingest(
    {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_011,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'and this',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  return { store, config: loaded.config, context };
}

interface RecordingApi extends TelegramTransport {
  readonly calls: string[];
}

/** Records every accepted message; `failOnce` texts fail with a 400 the first time only. */
function recordingApi(failOnce: ReadonlySet<string> = new Set()): RecordingApi {
  const calls: string[] = [];
  const failed = new Set<string>();
  const respond = (content: string) => {
    calls.push(content);
    return { message_id: 500 + calls.length, date: 1_700_000_100 + calls.length, chat: { id: 123456789 } };
  };
  return {
    calls,
    sendMessage: async (_chatId, text) => {
      if (failOnce.has(text) && !failed.has(text)) {
        failed.add(text);
        throw new GrammyError(
          'Bad Request: can not parse entities',
          { ok: false, error_code: 400, description: 'Bad Request: can not parse entities' },
          'sendMessage',
          {},
        );
      }
      return respond(text);
    },
    sendSticker: async (_chatId, sticker) => respond(sticker),
  };
}

function makeTools(fixture: Fixture, api: TelegramTransport, guard: boolean | undefined, onRejected = () => {}) {
  const capabilities = invocationCapabilities(fixture.store, fixture.config, fixture.context.header);
  return {
    ...createSendTools({
      store: fixture.store,
      ...testSendToolEnv(api, fixture.context),
      context: fixture.context,
      capabilities,
      sendRateLimit: { sendsPerWindow: 50, windowSeconds: 300 },
      maxTextLength: undefined,
      disallowBlankLines: false,
      ...duplicateSendGuard(guard, onRejected),
      deadline: Date.now() + 30_000,
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    }),
    capabilities,
  };
}

function toolAudit(
  store: SqliteStore,
): { tool_call_id: string; tool_name: string; state: string; error_code: string | null }[] {
  return store.db
    .prepare<[], { tool_call_id: string; tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_call_id, tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
}

function sendCounts(fixture: Fixture): { host_sends: bigint; sends_used: bigint } {
  const row = fixture.store.db
    .prepare<[bigint], { host_sends: bigint; sends_used: bigint }>(
      "SELECT (SELECT COUNT(*) FROM host_sends WHERE state = 'success') AS host_sends, sends_used FROM invocations WHERE id = ?",
    )
    .get(fixture.context.invocationId);
  if (row === undefined) {
    throw new Error('invocation row is missing');
  }
  return row;
}

describe('duplicate send guard', () => {
  test('is on unless explicitly disabled', () => {
    expect(duplicateSendGuard(undefined)).toHaveProperty('duplicateSendGuard');
    expect(duplicateSendGuard(true)).toHaveProperty('duplicateSendGuard');
    expect(duplicateSendGuard(false)).toEqual({});
  });

  test('rejects an identical text without reaching Telegram, and lets different messages through', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      let rejections = 0;
      const { send } = makeTools(fixture, api, undefined, () => (rejections += 1));
      expect(send.description).toContain('identical to one already sent in this run is rejected');
      await send.execute('first', { text: 'good morning', reply_to_message_id: '10' });
      // Once another message came in between, a different reply target or
      // parse mode makes a different message.
      await send.execute('between', { text: 'hello' });
      await send.execute('unattached', { text: 'good morning' });
      await send.execute('between-again', { text: 'hey' });
      await send.execute('markdown', { text: 'good morning', parse_mode: 'MarkdownV2' });
      // Ignored fields and an omitted kind do not make it a different message.
      // (Once a repeated reply is rejected, its text is burned for the run;
      // send-bypass-guard.test.ts covers that.)
      await expect(
        send.execute('repeat', { kind: 'text', text: 'good morning', reply_to_message_id: '10', sticker_ref: 'x' }),
      ).rejects.toThrow('Not sent: send_duplicate');
      expect(api.calls).toEqual(['good morning', 'hello', 'good morning', 'hey', 'good morning']);
      expect(rejections).toBe(1);
      expect(toolAudit(fixture.store)).toEqual([
        { tool_call_id: 'first', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'between', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'unattached', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'between-again', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'markdown', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'repeat', tool_name: 'send', state: 'error', error_code: 'send_duplicate' },
      ]);
      // The rejection spends no send budget.
      expect(sendCounts(fixture)).toEqual({ host_sends: 5n, sends_used: 5n });
    } finally {
      fixture.store.close();
    }
  });

  test('rejects a repeated sticker', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { send, capabilities } = makeTools(fixture, api, true);
      const stickerRef = capabilities.registerStickerRef('CAAD-fake-sticker');
      await send.execute('sticker', { kind: 'sticker', sticker_ref: stickerRef });
      await expect(send.execute('again', { kind: 'sticker', sticker_ref: stickerRef })).rejects.toThrow(
        'send_duplicate',
      );
      expect(api.calls).toEqual(['CAAD-fake-sticker']);
    } finally {
      fixture.store.close();
    }
  });

  test('rejects the last message re-aimed at another reply target, keyed on content', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      let rejections = 0;
      const { send, capabilities } = makeTools(fixture, api, true, () => (rejections += 1));
      await send.execute('to-10', { text: 'not my field', reply_to_message_id: '10' });
      await expect(send.execute('to-11', { text: 'not my field', reply_to_message_id: '11' })).rejects.toThrow(
        'Not sent: send_duplicate. Your previous message',
      );
      // The re-aimed reply is burned like an exact repeat, so dropping the target does not lift it.
      await expect(send.execute('bare', { text: 'not my field', parse_mode: 'MarkdownV2' })).rejects.toThrow(
        'send_bypass',
      );
      await send.execute('other', { text: 'something new', reply_to_message_id: '11' });
      // A fresh ref to the same sticker file is the same content.
      await send.execute('sticker', { kind: 'sticker', sticker_ref: capabilities.registerStickerRef('CAAD-same') });
      await expect(
        send.execute('sticker-again', { kind: 'sticker', sticker_ref: capabilities.registerStickerRef('CAAD-same') }),
      ).rejects.toThrow('send_duplicate');
      expect(api.calls).toEqual(['not my field', 'something new', 'CAAD-same']);
      expect(rejections).toBe(3);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['to-10', null],
        ['to-11', 'send_duplicate'],
        ['bare', 'send_bypass'],
        ['other', null],
        ['sticker', null],
        ['sticker-again', 'send_duplicate'],
      ]);
      expect(sendCounts(fixture)).toEqual({ telegram_sends: 3n, sends_used: 3n });
    } finally {
      fixture.store.close();
    }
  });

  test('send_reply compares part 1 with the last send and each later part with the part before it', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, api, true);
      await send.execute('said', { text: 'A', reply_to_message_id: '10' });
      await expect(sendReply.execute('leads-with-it', { parts: [{ text: 'A' }, { text: 'B' }] })).rejects.toThrow(
        'Nothing was sent: part 1 repeats the content of the message right before it',
      );
      await expect(
        sendReply.execute('aimed', { reply_to_message_id: '10', parts: [{ text: 'C' }, { text: 'C' }] }),
      ).rejects.toThrow('Nothing was sent: part 2 repeats the content of the message right before it');
      // Not adjacent: B comes between the two As.
      await sendReply.execute('apart', { parts: [{ text: 'B' }, { text: 'A' }] });
      // A part 1 aimed at a reply target is checked by the send itself, which still sends nothing.
      await expect(
        sendReply.execute('re-aimed', { reply_to_message_id: '11', parts: [{ text: 'A' }, { text: 'D' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed. Not sent: send_duplicate');
      expect(api.calls).toEqual(['A', 'B', 'A']);
      expect(toolAudit(fixture.store).filter((row) => row.error_code === 'send_duplicate')).toEqual([
        { tool_call_id: 'leads-with-it', tool_name: 'send_reply', state: 'error', error_code: 'send_duplicate' },
        { tool_call_id: 'aimed', tool_name: 'send_reply', state: 'error', error_code: 'send_duplicate' },
        { tool_call_id: 're-aimed', tool_name: 'send_reply', state: 'error', error_code: 'send_duplicate' },
        { tool_call_id: 're-aimed:1', tool_name: 'send', state: 'error', error_code: 'send_duplicate' },
      ]);
    } finally {
      fixture.store.close();
    }
  });

  test('a send that Telegram did not accept may be retried unchanged', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi(new Set(['retry me']));
      const { send } = makeTools(fixture, api, true);
      await expect(send.execute('failed', { text: 'retry me' })).rejects.toThrow(
        'Telegram send failed: telegram_400 (Bad Request: can not parse entities)',
      );
      await send.execute('retried', { text: 'retry me' });
      expect(api.calls).toEqual(['retry me']);
    } finally {
      fixture.store.close();
    }
  });

  test('send_reply rejects a part that repeats an earlier send or another part before anything goes out', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      let rejections = 0;
      const { send, sendReply } = makeTools(fixture, api, true, () => (rejections += 1));
      await send.execute('earlier', { text: 'already said' });
      await expect(
        sendReply.execute('repeats-send', { parts: [{ text: 'new' }, { text: 'already said' }] }),
      ).rejects.toThrow('Nothing was sent: part 2 repeats a message already published');
      await expect(sendReply.execute('repeats-part', { parts: [{ text: 'twin' }, { text: 'twin' }] })).rejects.toThrow(
        'Nothing was sent: part 2 repeats',
      );
      // Its parts are sends of this run, so a later send cannot repeat them either.
      await sendReply.execute('fine', { parts: [{ text: 'one' }, { text: 'two' }] });
      await expect(send.execute('repeats-part-two', { text: 'two' })).rejects.toThrow('send_duplicate');
      expect(api.calls).toEqual(['already said', 'one', 'two']);
      expect(rejections).toBe(3);
      expect(toolAudit(fixture.store).filter((row) => row.error_code === 'send_duplicate')).toEqual([
        { tool_call_id: 'repeats-send', tool_name: 'send_reply', state: 'error', error_code: 'send_duplicate' },
        { tool_call_id: 'repeats-part', tool_name: 'send_reply', state: 'error', error_code: 'send_duplicate' },
        { tool_call_id: 'repeats-part-two', tool_name: 'send', state: 'error', error_code: 'send_duplicate' },
      ]);
    } finally {
      fixture.store.close();
    }
  });

  test('turned off, identical messages are sent again', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, api, false);
      expect(send.description).not.toContain('identical to one already sent');
      await send.execute('one', { text: 'same' });
      await send.execute('two', { text: 'same' });
      await sendReply.execute('three', { parts: [{ text: 'same' }, { text: 'same' }] });
      expect(api.calls).toEqual(['same', 'same', 'same', 'same']);
    } finally {
      fixture.store.close();
    }
  });
});
