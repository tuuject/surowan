/**
 * Viewing a web image as the runtime serves it: the model reads a page through
 * `execute`, finds an image link in the Markdown, fetches that image with the
 * page as referer, and the next request carries the pixels.
 *
 * The claims are end-to-end because the risky part is the hand-off between
 * layers: a capability's tool image must survive the `execute` envelope, land
 * in canonical history as a reference (never bytes), and be projected back to
 * image content only at request time.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { capability } from '../../src/capabilities/execute-tool.ts';
import { localImageAssets } from '../../src/capabilities/media/local-assets.ts';
import { ingestToolImage } from '../../src/capabilities/media/tool-image-store.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { toolImageMarker } from '../../src/platform/tool-images.ts';
import { createWebFetchTool } from '../../src/plugins/web-fetch/web-fetch.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from '../helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

const CHAT_ID = 123456789;
const PAGE_URL = 'https://blog.example/posts/cat';
const IMAGE_URL = 'https://cdn.example/cat.png';

function resultText(message: ToolResultMessage): string {
  const first = message.content[0];
  return first?.type === 'text' ? first.text : '';
}

test('a web image fetched through execute reaches the provider as pixels and stays a reference on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-web-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.chats = [{ id: CHAT_ID, instructions_file: 'chat-instructions.md' }];
    }),
  );
  const loaded = await loadConfig(configPath);
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: CHAT_ID, is_bot: false, first_name: 'Alice' },
        text: `what does the cat in ${PAGE_URL} look like?`,
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const assets = localImageAssets(store.orm, loaded.config.data_dir);
  const referers: (string | undefined)[] = [];
  let pageResult: ToolResultMessage | undefined;
  let imageResult: ToolResultMessage | undefined;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('execute', { action: 'call', tool: 'web_fetch', input: { url: PAGE_URL } }, { id: 'page_call' }),
      { stopReason: 'toolUse' },
    ),
    (context) => {
      const page = context.messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === 'page_call',
      );
      if (page?.role !== 'toolResult') {
        throw new Error('Missing page result');
      }
      pageResult = page;
      return fauxAssistantMessage(
        fauxToolCall(
          'execute',
          { action: 'call', tool: 'web_fetch', input: { url: IMAGE_URL, referer: PAGE_URL } },
          { id: 'image_call' },
        ),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const image = context.messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === 'image_call',
      );
      if (image?.role !== 'toolResult') {
        throw new Error('Missing image result');
      }
      imageResult = image;
      return fauxAssistantMessage('');
    },
  ]);
  const telegramRuntime = testTelegramRuntime(
    {
      sendMessage: async () => {
        throw new Error('No sends in this test');
      },
      sendSticker: async () => {
        throw new Error('No sends in this test');
      },
    },
    { scope: 'private' },
  );
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversation: telegramRuntime.conversation,
    hosts: telegramRuntime.hosts,
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    capabilityTools: (context, deadline) => [
      capability(
        createWebFetchTool({
          audit: createToolAudit(store, context.invocationId),
          invocationDeadline: deadline,
          storeImage: (bytes, signal) => ingestToolImage(assets, context.internalChatId, bytes, signal),
          resolveHostname: async () => [{ address: '203.0.114.10', family: 4 }],
          requestResolved: async (url, _address, headers) => {
            referers.push(headers.referer);
            return url.href === PAGE_URL
              ? new Response(
                  '<html><head><title>Cat</title></head><body><article><h1>Cat</h1><p>Our cat sat for a portrait today and the whole family agreed it was the best photo of the year.</p><p><img src="https://cdn.example/cat.png" alt="the cat"></p><p>Read on for more about the cat, its habits and its favourite places to sleep in the house.</p></article></body></html>',
                  { headers: { 'content-type': 'text/html; charset=utf-8' } },
                )
              : new Response(png, { headers: { 'content-type': 'image/png' } });
          },
        }),
        false,
      ),
    ],
  });
  expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'completed',
  });

  // The page result is text only, and its Markdown names the image the model then fetched.
  if (pageResult === undefined || imageResult === undefined) {
    throw new Error('Expected both results to reach the provider');
  }
  expect(pageResult.content.every((block) => block.type === 'text')).toBe(true);
  expect(JSON.parse(resultText(pageResult)).text).toContain(`![the cat](${IMAGE_URL})`);
  expect(referers).toEqual([undefined, PAGE_URL]);

  // The provider sees the envelope, then the labeled image with real pixels.
  expect(imageResult.content.map((block) => block.type)).toEqual(['text', 'text', 'image']);
  expect(JSON.parse(resultText(imageResult)).text).toContain('Format: image attached below');
  expect(imageResult.content[1]).toEqual({
    type: 'text',
    text: 'Tool result image 1 from execute (tool_call_id: image_call)',
  });
  expect(imageResult.content[2]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });

  // Canonical history and audit keep the reference: marker after the envelope, no bytes.
  const stored = store.orm.all<{ payload_json: string }>(
    sql`SELECT payload_json FROM context_messages WHERE role = 'toolResult' ORDER BY seq`,
  );
  expect(stored).toHaveLength(2);
  const persisted = JSON.parse(stored[1]?.payload_json ?? '{}') as {
    content: { type: string; text: string }[];
    details: { action: string; tool: string; toolImages: { version: 1; items: { assetId: string }[] } };
  };
  const assetId = persisted.details.toolImages.items[0]?.assetId ?? '';
  expect(persisted.details).toMatchObject({
    action: 'call',
    tool: 'web_fetch',
    toolImages: { version: 1, items: [{ contentIndex: 1, mimeType: 'image/jpeg', width: 40, height: 30 }] },
  });
  expect(persisted.content[1]).toEqual({ type: 'text', text: toolImageMarker(assetId) });
  expect(JSON.parse(persisted.content[0]?.text ?? '{}').text).not.toContain(toolImageMarker(assetId));
  expect(stored[1]?.payload_json).not.toContain('/9j/');
  const rows = store.orm.all<{ tool_call_id: string; state: string; result_content_json: string | null }>(
    sql`SELECT tool_call_id, state, result_content_json FROM tool_calls ORDER BY id`,
  );
  expect(rows.map((row) => [row.tool_call_id, row.state, row.result_content_json === null])).toEqual([
    ['page_call', 'success', true],
    ['page_call:web_fetch', 'success', true],
    ['image_call', 'success', false],
    ['image_call:web_fetch', 'success', false],
  ]);
  const chat = store.orm.get<{ id: bigint }>(
    sql`SELECT id FROM chats WHERE host_kind = 'telegram' AND host_chat_id = ${BigInt(CHAT_ID)}`,
  );
  expect(assets.assetFor(chat?.id ?? 0n, assetId)).not.toBeNull();
  store.close();
});
