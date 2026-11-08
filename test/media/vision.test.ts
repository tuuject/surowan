import { expect, test } from 'vitest';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { KeyedSemaphore } from '../../src/platform/concurrency.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import { MediaService } from '../../src/capabilities/media/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import {
  fauxRegistry,
  invocationCapabilities,
  renderInvocationContext,
  testConfigStore,
  writeTestConfig,
} from '../helpers.ts';
import { directories } from './fixtures.ts';

test('read_image normalizes once and reuses the 30-day description cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-media-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-model', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      photo: [
        {
          file_id: 'file-id',
          file_unique_id: 'unique-id',
          width: 32,
          height: 16,
          file_size: 100,
        },
      ],
    },
  };
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  const capabilities = invocationCapabilities(store, loaded.config, context.header);
  const [imageRef] = context.imageCapabilities.keys();
  if (imageRef === undefined) {
    throw new Error('Expected an image capability');
  }
  expect(context.directImages).toEqual([]);

  let visionReasoning: string | undefined;
  faux.setResponses([
    (_context, options) => {
      visionReasoning = options?.reasoning;
      return fauxAssistantMessage('A translucent red rectangle.');
    },
  ]);
  let downloads = 0;
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      signal.throwIfAborted();
      downloads += 1;
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
  const tool = media.createReadImageTool(context, capabilities, Date.now() + 60_000);
  const first = await tool.execute('read-1', { image_ref: imageRef });
  const second = await tool.execute('read-2', { image_ref: imageRef });
  expect(first.content).toEqual([{ type: 'text', text: 'A translucent red rectangle.' }]);
  expect(second.details.cached).toBe(true);
  expect(downloads).toBe(1);
  expect(faux.state.callCount).toBe(1);
  expect(visionReasoning).toBe('low');
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM media_analyses WHERE state = 'success'")
      .get()?.count,
  ).toBe(1n);
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});

test('vision analyses run at vision.thinking_level, or at the model default when it is unset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-media-thinking-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-model', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const colors = ['red', 'green', 'blue'] as const;
  for (const [index, color] of colors.entries()) {
    await sharp({
      create: {
        width: 8 + index,
        height: 8,
        channels: 3,
        background: { r: color === 'red' ? 255 : 0, g: color === 'green' ? 255 : 0, b: color === 'blue' ? 255 : 0 },
      },
    })
      .png()
      .toFile(join(directory, `${color}.png`));
  }
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  for (const [index, color] of colors.entries()) {
    ingestion.ingest(
      {
        update_id: index + 1,
        message: {
          message_id: 10 + index,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          photo: [{ file_id: color, file_unique_id: `unique-${color}`, width: 8 + index, height: 8, file_size: 100 }],
        },
      },
      received,
    );
  }
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  const capabilities = invocationCapabilities(store, loaded.config, context.header);
  const refs = [...context.imageCapabilities.keys()];
  expect(refs).toHaveLength(3);
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      await copyFile(join(directory, `${fileId}.png`), destination);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const tool = media.createReadImageTool(context, capabilities, Date.now() + 60_000);
  const seen: Array<string | undefined> = [];
  const respond = (_context: unknown, options: { reasoning?: string } | undefined) => {
    seen.push(options?.reasoning);
    return fauxAssistantMessage('A square.');
  };
  const analyzeWith = async (thinkingLevel: 'high' | 'off' | undefined, ref: string | undefined): Promise<void> => {
    if (ref === undefined) {
      throw new Error('Expected an image ref');
    }
    const current = configStore.current();
    const config = structuredClone(current.config);
    if (thinkingLevel === undefined) {
      delete config.vision.thinking_level;
    } else {
      config.vision.thinking_level = thinkingLevel;
    }
    configStore.publish({ ...current, config, hash: `vision-${thinkingLevel ?? 'default'}` });
    const result = await tool.execute(`read-${ref}`, { image_ref: ref });
    expect(result.details.cached).toBe(false);
  };

  faux.setResponses([respond, respond]);
  // The level is read from the snapshot each analysis starts with, so a hot
  // switch reaches the next one; `off` sends no effort at all.
  await analyzeWith('high', refs[0]);
  await analyzeWith('off', refs[1]);
  expect(seen).toEqual(['high', undefined]);

  // Unset on a model without `low`: the weakest effort above `off`, which is
  // what a fixed `low` used to miss.
  const noLow = fauxProvider({
    provider: 'vision',
    models: [
      { id: 'vision-no-low', reasoning: true, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 8_192 },
    ],
  });
  noLow.setResponses([respond]);
  const noLowModels = createModels();
  noLowModels.setProvider(noLow.provider);
  // The registry builds this map from a model's declared `thinking_levels`.
  const noLowModel = { ...noLow.getModel(), thinkingLevelMap: { minimal: null, low: null } };
  configStore.publish({ ...configStore.current(), models: noLowModels, visionModel: noLowModel });
  await analyzeWith(undefined, refs[2]);
  expect(seen).toEqual(['high', undefined, 'medium']);
  expect(
    store.db
      .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM media_analyses WHERE state = 'success'")
      .get()?.count,
  ).toBe(3n);
  store.close();
});
