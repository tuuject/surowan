import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createSendTools, duplicateSendGuard, type TelegramSendApi } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { RawConfig } from '../src/platform/config.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  type TestInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
} from './helpers.ts';

/**
 * Contract for the duplicate send guard (`agent.send_duplicate_guard_enabled`,
 * on unless set to false): within one invocation, a text or sticker identical
 * to one Telegram already accepted is rejected as `send_duplicate` without
 * reaching Telegram, and every rejection is reported so the run can stop.
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

interface RecordingApi extends TelegramSendApi {
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

function makeTools(fixture: Fixture, api: TelegramSendApi, guard: boolean | undefined, onRejected = () => {}) {
  const capabilities = invocationCapabilities(fixture.store, fixture.config, fixture.context.header);
  return {
    ...createSendTools({
      store: fixture.store,
      api,
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

function sendCounts(fixture: Fixture): { telegram_sends: bigint; sends_used: bigint } {
  const row = fixture.store.db
    .prepare<[bigint], { telegram_sends: bigint; sends_used: bigint }>(
      'SELECT (SELECT COUNT(*) FROM telegram_sends) AS telegram_sends, sends_used FROM invocations WHERE id = ?',
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
      // A different reply target or parse mode is a different message.
      await send.execute('unattached', { text: 'good morning' });
      await send.execute('markdown', { text: 'good morning', parse_mode: 'MarkdownV2' });
      // Ignored fields and an omitted kind do not make it a different message.
      // (Once a repeated reply is rejected, its text is burned for the run;
      // send-bypass-guard.test.ts covers that.)
      await expect(
        send.execute('repeat', { kind: 'text', text: 'good morning', reply_to_message_id: '10', sticker_ref: 'x' }),
      ).rejects.toThrow('Not sent: send_duplicate');
      expect(api.calls).toEqual(['good morning', 'good morning', 'good morning']);
      expect(rejections).toBe(1);
      expect(toolAudit(fixture.store)).toEqual([
        { tool_call_id: 'first', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'unattached', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'markdown', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'repeat', tool_name: 'send', state: 'error', error_code: 'send_duplicate' },
      ]);
      // The rejection spends no send budget.
      expect(sendCounts(fixture)).toEqual({ telegram_sends: 3n, sends_used: 3n });
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

  test('a send that Telegram did not accept may be retried unchanged', async () => {
    const fixture = await setup();
    try {
      const api = recordingApi(new Set(['retry me']));
      const { send } = makeTools(fixture, api, true);
      await expect(send.execute('failed', { text: 'retry me' })).rejects.toThrow('Telegram send failed: telegram_400');
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
