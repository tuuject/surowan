import { expect, test } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { KeyedSemaphore } from '../../src/platform/concurrency.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import { MediaService } from '../../src/capabilities/media/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { testConfigStore, writeTestConfig } from '../helpers.ts';
import { directories } from './fixtures.ts';

test('readOriginalFile hands over the downloaded bytes untouched, keeps a document name and refuses stickers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-media-original-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const chat = { id: 123456789, type: 'private', first_name: 'Owner' } as const;
  const from = { id: 42, is_bot: false, first_name: 'Alice' } as const;
  const updates: Update[] = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat,
        from,
        photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 32, height: 16, file_size: 100 }],
      },
    },
    {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        chat,
        from,
        document: {
          file_id: 'document-file',
          file_unique_id: 'document-unique',
          file_name: 'scan.png',
          mime_type: 'image/png',
          file_size: 100,
          thumbnail: { file_id: 'document-thumb', file_unique_id: 'document-thumb-unique', width: 32, height: 16 },
        },
      },
    },
    {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_002,
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
        },
      },
    },
  ];
  for (const [index, update] of updates.entries()) {
    ingestion.ingest(update, new Date(Date.UTC(2026, 7, 15, 0, 0, index)));
  }
  const rows = store.db.prepare<[], { id: bigint; kind: string }>('SELECT id, kind FROM media ORDER BY id').all();
  const [photoId, documentId, stickerId] = rows.map((row) => row.id);
  if (photoId === undefined || documentId === undefined || stickerId === undefined) {
    throw new Error('Expected photo, document and sticker media rows');
  }

  // Not a decodable image on purpose: any normalization would reject or
  // rewrite it, so equal bytes prove the file went through untouched.
  const payloads: Record<string, Uint8Array> = {
    'photo-file': new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
    'document-file': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]),
  };
  const downloaded: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      downloaded.push(fileId);
      const payload = payloads[fileId];
      if (payload === undefined) {
        throw new Error(`unexpected download of ${fileId}`);
      }
      await writeFile(destination, payload);
    },
  };
  const media = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: downloader,
    modelGate: new KeyedSemaphore(),
  });
  const signal = new AbortController().signal;

  const photo = await media.readOriginalFile(photoId, signal);
  expect(Buffer.from(photo.bytes)).toEqual(Buffer.from(payloads['photo-file'] ?? []));
  expect(photo).toMatchObject({ fileName: `photo-${photoId}`, mime: 'image/jpeg' });

  const document = await media.readOriginalFile(documentId, signal);
  expect(Buffer.from(document.bytes)).toEqual(Buffer.from(payloads['document-file'] ?? []));
  expect(document).toMatchObject({ fileName: 'scan.png', mime: 'image/png' });

  await expect(media.readOriginalFile(stickerId, signal)).rejects.toThrow('unavailable as a file');
  expect(downloaded).toEqual(['photo-file', 'document-file']);
  // The download directory is a scratch space, never a cache.
  expect(await readdir(loaded.config.paths.media_cache)).toEqual([]);
  store.close();
});
