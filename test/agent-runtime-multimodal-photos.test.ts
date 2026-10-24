import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, withoutInitialSystemMessage } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './agent-runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('passes Telegram photos directly to the multimodal agent and keeps stickers tool-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-image-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.developer = { record_model_payloads: true };
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({
    create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  const update: Update = {
    update_id: 2,
    message: {
      message_id: 20,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        { file_id: 'photo-small', file_unique_id: 'photo-small-unique', width: 8, height: 4, file_size: 50 },
        { file_id: 'photo-large', file_unique_id: 'photo-large-unique', width: 16, height: 8, file_size: 100 },
      ],
      sticker: {
        file_id: 'sticker-file',
        file_unique_id: 'sticker-unique',
        width: 64,
        height: 64,
        is_animated: false,
        is_video: false,
        type: 'regular',
      },
    },
  };
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }

  const inlineImageBytes = Buffer.from('provider inline image bytes');
  const inlineImageDataUrl = `data:image/jpeg;base64,${inlineImageBytes.toString('base64')}`;
  faux.setResponses([
    (context, options) => {
      const providerPayload = {
        model: 'agent-model',
        messages: [{ content: [{ type: 'image_url', image_url: { url: inlineImageDataUrl } }] }],
      };
      options?.onPayload?.(providerPayload, faux.getModel());
      expect(providerPayload.messages[0]?.content[0]?.image_url.url).toBe(inlineImageDataUrl);
      const user = withoutInitialSystemMessage(context.messages)[0];
      expect(user?.role).toBe('user');
      if (user?.role !== 'user' || typeof user.content === 'string') {
        throw new Error('Expected multimodal user content');
      }
      const images = user.content.filter((entry) => entry.type === 'image');
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe('image/jpeg');
      expect(user.content[0]).toMatchObject({ type: 'text' });
      expect(user.content).toContainEqual({ type: 'text', text: expect.stringContaining('[photo figure_1 ') });
      return fauxAssistantMessage('saw the photo');
    },
    // Non-empty draft triggers the send nudge; the model then stays silent.
    fauxAssistantMessage(''),
  ]);
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      expect(fileId).toBe('photo-large');
      await copyFile(fixturePath, destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const api: TelegramTransport = {
    sendMessage: async () => ({ message_id: 501, date: 1_700_000_100, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: 502, date: 1_700_000_100, chat: { id: 123456789 } }),
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime(api),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
    directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM media').get()?.count).toBe(2n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM tool_calls WHERE tool_name = 'read_image'")
      .get()?.count,
  ).toBe(0n);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM model_calls WHERE role = 'vision_chat'")
      .get()?.count,
  ).toBe(0n);
  const requestJson = store.db
    .prepare<[], { request_json: string | null }>(
      "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
    )
    .get()?.request_json;
  expect(requestJson).not.toContain(inlineImageDataUrl);
  expect(requestJson === null || requestJson === undefined ? null : JSON.parse(requestJson)).toMatchObject({
    messages: [
      {
        content: [
          {
            image_url: {
              url: {
                __surowan_audit_omission__: 'base64_image',
                mime_type: 'image/jpeg',
                encoded_characters: inlineImageBytes.toString('base64').length,
                decoded_bytes: inlineImageBytes.byteLength,
                sha256: createHash('sha256').update(inlineImageBytes).digest('hex'),
              },
            },
          },
        ],
      },
    ],
  });
  // The stored transcript drops the attachment, so a replay can only reach the
  // photo through the img_ ref carried on its figure line.
  const storedBatch = store.db
    .prepare<[], { payload_json: string }>(
      "SELECT payload_json FROM context_messages WHERE role = 'user' ORDER BY seq LIMIT 1",
    )
    .get()?.payload_json;
  expect(storedBatch).not.toContain('"type":"image"');
  const storedRef = /\[photo figure_1 (img_[^\s\]]+)/.exec(storedBatch ?? '')?.[1];
  expect(storedRef).toBeDefined();
  expect(
    store.db
      .prepare<[string], { kind: string }>(
        "SELECT m.kind FROM context_refs r JOIN media m ON m.id = r.media_id WHERE r.ref = ? AND r.kind = 'media'",
      )
      .get(storedRef ?? ''),
  ).toEqual({ kind: 'photo' });
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
