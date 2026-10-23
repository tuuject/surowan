import { expect, test } from 'vitest';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import sharp from 'sharp';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { testConfigStore, writeTestConfig } from './helpers.ts';
import { directories } from './media-fixtures.ts';

test('prepareSceneImage reads photos, image documents and stickers read-only, while generation input still rejects stickers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-media-scene-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const fixturePath = join(directory, 'fixture.png');
  await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png()
    .toFile(fixturePath);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const chat = { id: 123456789, type: 'private', first_name: 'Owner' } as const;
  const from = { id: 42, is_bot: false, first_name: 'Alice' } as const;
  const photoUpdate: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat,
      from,
      photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 32, height: 16, file_size: 100 }],
    },
  };
  const stickerUpdate: Update = {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_700_000_001,
      chat,
      from,
      sticker: {
        file_id: 'sticker-file',
        file_unique_id: 'sticker-unique',
        type: 'regular',
        width: 32,
        height: 16,
        is_animated: false,
        is_video: false,
        thumbnail: { file_id: 'sticker-thumb', file_unique_id: 'sticker-thumb-unique', width: 32, height: 16 },
      },
    },
  };
  const documentUpdate: Update = {
    update_id: 3,
    message: {
      message_id: 12,
      date: 1_700_000_002,
      chat,
      from,
      document: {
        file_id: 'document-file',
        file_unique_id: 'document-unique',
        mime_type: 'image/png',
        file_size: 100,
        thumbnail: { file_id: 'document-thumb', file_unique_id: 'document-thumb-unique', width: 32, height: 16 },
      },
    },
  };
  ingestion.ingest(photoUpdate, new Date('2026-08-15T00:00:00.000Z'));
  ingestion.ingest(stickerUpdate, new Date('2026-08-15T00:00:01.000Z'));
  ingestion.ingest(documentUpdate, new Date('2026-08-15T00:00:02.000Z'));
  const mediaRows = store.db.prepare<[], { id: bigint; kind: string }>('SELECT id, kind FROM media ORDER BY id').all();
  expect(mediaRows.map((row) => row.kind)).toEqual(['photo', 'sticker', 'document']);
  const [photoId, stickerId, documentId] = mediaRows.map((row) => row.id);
  if (photoId === undefined || stickerId === undefined || documentId === undefined) {
    throw new Error('Expected photo, sticker and document media rows');
  }

  const downloaded: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      downloaded.push(fileId);
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
  const productionCounts = (): Record<string, bigint> => {
    const read = (table: string): bigint =>
      store.db.prepare<[], { count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? -1n;
    return {
      media_analyses: read('media_analyses'),
      model_calls: read('model_calls'),
      tool_calls: read('tool_calls'),
      daily_usage: read('daily_usage'),
      context_messages: read('context_messages'),
    };
  };
  const before = productionCounts();

  // The cache directory is created on demand: a scene read must not require an
  // earlier analysis to have made it exist.
  await rm(loaded.config.paths.media_cache, { recursive: true, force: true });
  const photo = await media.prepareSceneImage(photoId, new AbortController().signal);
  expect(photo.mime).toBe('image/png');
  const decoded = await sharp(Buffer.from(photo.base64, 'base64')).metadata();
  expect([decoded.format, decoded.width, decoded.height]).toEqual(['png', 32, 16]);

  // A sticker reads through its representative thumbnail, the same
  // normalization the vision path uses.
  const sticker = await media.prepareSceneImage(stickerId, new AbortController().signal);
  expect(sticker.mime).toBe('image/png');
  const document = await media.prepareSceneImage(documentId, new AbortController().signal);
  expect(document.mime).toBe('image/png');
  expect(downloaded).toEqual(['photo-file', 'sticker-thumb', 'document-file']);

  // The generation contract is unchanged: the same sticker stays unavailable as
  // generation input while the photo and the image document still work.
  await expect(media.prepareInputImage(stickerId, new AbortController().signal)).rejects.toThrow(
    'Media is unavailable as generation input',
  );
  await expect(media.prepareSceneImage(999_999n, new AbortController().signal)).rejects.toThrow(
    'Media is unavailable as scene input',
  );
  expect((await media.prepareInputImage(photoId, new AbortController().signal)).mime).toBe('image/png');
  expect((await media.prepareInputImage(documentId, new AbortController().signal)).mime).toBe('image/png');

  // An abort still removes the temporary directory, and every read above only
  // selected the media row: no analysis, audit, usage or context rows appear.
  const aborted = new AbortController();
  aborted.abort();
  await expect(media.prepareSceneImage(photoId, aborted.signal)).rejects.toThrow();
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  expect(productionCounts()).toEqual(before);
  store.close();
});
