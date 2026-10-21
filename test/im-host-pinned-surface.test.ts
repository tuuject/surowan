/**
 * Frozen Telegram surface.
 *
 * The host extraction and the storage changes that follow move code around but
 * must not move anything a model, an operator, or the audit trail can see. This
 * file pins exactly that seam for one fixed incoming update: the rendered
 * envelope the model reads, the invocation header, the request the transport
 * receives, the audit rows, and the tool result text.
 *
 * If a later task needs a different value here, that is a deliberate contract
 * change and belongs in its own commit.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Update } from 'grammy/types';
import { expect, test } from 'vitest';

import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createSendTool } from '../src/capabilities/send-tool.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import {
  invocationCapabilities,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  testSendToolEnv,
  writeTestConfig,
} from './helpers.ts';

const CHAT_ID = 123456789;
const SENDER_ID = 42;
const MESSAGE_ID = 50;
const RECEIVED_AT = new Date('2023-11-14T22:13:20Z');

const PINNED_ENVELOPE = '[50 2023-11-14T22:14:10 uid:42] Alice\n  hello there';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-pinned-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: CHAT_ID, instructions_file: 'chat-instructions.md' }];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const update: Update = {
    update_id: 1,
    message: {
      message_id: MESSAGE_ID,
      date: Math.floor(RECEIVED_AT.getTime() / 1000) + 50,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: SENDER_ID, is_bot: false, first_name: 'Alice' },
      text: 'hello there',
    },
  };
  ingestion.ingest(update, RECEIVED_AT);
  const [invocationId] = scheduler.processDue(new Date(RECEIVED_AT.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('expected an invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
  });
  const capabilities = invocationCapabilities(store, loaded.config, context.header);
  const requests: unknown[] = [];
  const sendContext = context;
  const tool = createSendTool({
    store,
    ...testSendToolEnv(
      {
        sendMessage: async (...args: unknown[]) => {
          requests.push(args.slice(0, 3));
          return { message_id: 77, date: 1_700_000_100, chat: { id: CHAT_ID } };
        },
        sendSticker: async (...args: unknown[]) => {
          requests.push(args.slice(0, 3));
          return { message_id: 78, date: 1_700_000_101, chat: { id: CHAT_ID } };
        },
        sendTyping: async () => undefined,
        sendGeneratedPhoto: async () => {
          throw new Error('not used');
        },
        sendGeneratedPhotoGroup: async () => {
          throw new Error('not used');
        },
      },
      sendContext,
    ),
    context,
    capabilities,
    sendRateLimit: { sendsPerWindow: 6, windowSeconds: 300 },
    maxTextLength: undefined,
    disallowBlankLines: false,
    allowReplyMessageMultipleTimes: false,
    deadline: Date.now() + 30_000,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
  } as never);
  return { store, context, tool, requests };
}

test('the model-visible envelope for a fixed update is pinned', async () => {
  const { store, context } = await fixture();
  expect(context.userPrompt).toContain(PINNED_ENVELOPE);
  expect(context.systemPrompt).toContain("re:N marks a reply to message N, uid:N is the sender's user ID");
  store.close();
});

test('the invocation header identity is pinned', async () => {
  const { store, context } = await fixture();
  expect(String(context.header.id)).toBe('1');
  expect(String(context.header.conversationId)).toBe('1');
  expect(String(context.header.headSeq)).toBe('1');
  expect(String(context.header.nextSeq)).toBe('1');
  expect(String(context.header.sendCountTotal)).toBe('0');
  store.close();
});

test('the Telegram send request and audit rows are pinned', async () => {
  const { store, tool, requests } = await fixture();
  const result = await tool.execute('call-1', { text: 'hi', reply_to_message_id: String(MESSAGE_ID) });

  expect(requests).toEqual([[String(CHAT_ID), 'hi', { reply_parameters: { message_id: MESSAGE_ID } }]]);

  const send = store.db
    .prepare(
      'SELECT kind, state, telegram_message_id, request_json, response_json, error_code FROM host_sends ORDER BY id',
    )
    .all() as Record<string, unknown>[];
  expect(send).toEqual([
    {
      kind: 'text',
      state: 'success',
      telegram_message_id: 77n,
      request_json: '{"kind":"text","reply_to_message_id":"50"}',
      response_json: '{"message_id":77}',
      error_code: null,
    },
  ]);

  const call = store.db
    .prepare('SELECT tool_name, arguments_json, result_text, state, side_effect FROM tool_calls ORDER BY id')
    .all() as Record<string, unknown>[];
  expect(call).toEqual([
    {
      tool_name: 'send',
      arguments_json: '{"kind":"text","text":"hi","reply_to_message_id":"50"}',
      result_text: 'telegram_message_id=77',
      state: 'success',
      side_effect: 1n,
    },
  ]);

  expect(result).toEqual({
    content: [{ type: 'text', text: 'Sent Telegram message 77' }],
    details: { telegramMessageId: '77' },
  });
  store.close();
});
