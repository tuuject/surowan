import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import { type InvocationMediaVariant, listInvocationMedia } from '../src/ingress/admin/invocation-media.ts';
import type { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  IDS,
  closeInvocationMediaFixture,
  createReader,
  expectAdminError,
  expectSyncAdminError,
  fixtureWriter,
  itemOf,
  openInvocationMediaFixture,
  recordingDownloader,
  svgBytes,
  type InvocationMediaFixture,
} from './admin-invocation-media-fixtures.ts';

/**
 * Listing and reading invocation media: which rows the snapshot authorizes, and
 * the read paths that succeed. Failures, limits and cancellations live in the
 * sibling `admin-invocation-media-*` files.
 */

let fixture: InvocationMediaFixture;
let store: SqliteStore;
let opaquePng: Uint8Array;

beforeAll(async () => {
  fixture = await openInvocationMediaFixture();
  store = fixture.store;
  opaquePng = fixture.opaquePng;
});

afterAll(async () => {
  await closeInvocationMediaFixture(fixture);
});

const readerFor = (downloader: MediaDownloader, shutdownSignal?: AbortSignal) =>
  createReader(store.orm, downloader, shutdownSignal);

test('list reports only media authorized by the snapshotted revision of the invocation conversation', () => {
  const list = listInvocationMedia(store.orm, IDS.invocationMain);
  expect(list.invocation_id).toBe('4001');
  // 6201 is listed by the snapshot; 6206/6207/6209/6210/6211 too. 6204 shares
  // the revision but is not listed, 6202 belongs to the newer current revision,
  // and 6205 lives in another conversation.
  expect(list.items.map((entry) => entry.id)).toEqual(['6201', '6206', '6207', '6209', '6210', '6211']);
  expect(itemOf(list.items, '6201')).toEqual({
    id: '6201',
    message_id: '6001',
    revision_id: '6101',
    kind: 'photo',
    mime_type: 'image/png',
    file_size: 68,
    variants: ['original', 'preview'],
  });
  expect(itemOf(list.items, '6206')).toMatchObject({
    revision_id: '6101',
    kind: 'document',
    mime_type: 'image/svg+xml',
    variants: ['original'],
  });
  // A size that cannot round-trip through a JS number is reported as null.
  expect(itemOf(list.items, '6209').file_size).toBeNull();
  expect(itemOf(list.items, '6210').variants).toEqual(['original', 'preview']);
  // An unknown size stays unknown rather than being invented.
  expect(itemOf(list.items, '6211').file_size).toBeNull();
  // No file ID, Telegram JSON or Telegram message ID crosses the list API.
  expect(JSON.stringify(list)).not.toContain('file-photo-old');
  expect(JSON.stringify(list)).not.toContain('file_unique_id');
  expect(JSON.stringify(list)).not.toContain('telegram_message_id');
  expect(JSON.stringify(list)).not.toContain('9001');
});

test('list scopes media to the invocation conversation and reports sticker variants', () => {
  const other = listInvocationMedia(store.orm, IDS.invocationOther);
  expect(other.items.map((entry) => entry.id)).toEqual(['6205']);
  expect(itemOf(other.items, '6205')).toMatchObject({
    message_id: '6002',
    revision_id: '6103',
    kind: 'document',
    variants: ['original'],
  });
  const sticker = listInvocationMedia(store.orm, IDS.invocationSticker);
  expect(itemOf(sticker.items, '6208')).toMatchObject({
    kind: 'sticker',
    mime_type: 'application/x-tgsticker',
    variants: ['original', 'preview'],
  });
});

test('list rejects an unknown invocation and unreadable snapshots', () => {
  expectSyncAdminError(() => listInvocationMedia(store.orm, 9_999n), 'not_found', 404);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationBadJson), 'snapshot_invalid', 409);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationMissingId), 'snapshot_invalid', 409);
  expectSyncAdminError(() => listInvocationMedia(store.orm, IDS.invocationNumericId), 'snapshot_invalid', 409);
});

test('original reads return the downloaded bytes with only whitelisted MIME types', async () => {
  const { downloader, calls, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  const photo = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', signal);
  expect(photo.variant).toBe('original');
  expect(photo.mime).toBe('image/png');
  expect(Buffer.from(photo.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  expect(calls).toEqual([{ fileId: 'file-photo-old', destination: join(directories[0] ?? '', 'original') }]);
  // The per-request temp directory is gone after a successful read.
  await expect(access(directories[0] ?? '')).rejects.toThrow();

  const svg = await reader(IDS.invocationMain, IDS.mediaSvg, 'original', signal);
  expect(svg.mime).toBe('application/octet-stream');
  expect(Buffer.from(svg.bytes).equals(Buffer.from(svgBytes))).toBe(true);

  const unknown = await reader(IDS.invocationMain, IDS.mediaUnknownMime, 'original', signal);
  expect(unknown.mime).toBe('application/octet-stream');
  expect(Buffer.from(unknown.bytes).equals(Buffer.from(svgBytes))).toBe(true);

  expect(calls.map((call) => call.fileId)).toEqual(['file-photo-old', 'file-svg', 'file-unknown-mime']);
  expect(directories).toHaveLength(3);
  for (const directory of directories) {
    await expect(access(directory)).rejects.toThrow();
  }
});

test('preview normalizes photos and stickers to JPEG or PNG through the shared pipeline', async () => {
  const { downloader, calls, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  const jpeg = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', signal);
  expect(jpeg.variant).toBe('preview');
  expect(jpeg.mime).toBe('image/jpeg');
  expect(jpeg.bytes[0]).toBe(0xff);
  expect(jpeg.bytes[1]).toBe(0xd8);

  const png = await reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'preview', signal);
  expect(png.mime).toBe('image/png');
  expect(png.bytes[0]).toBe(0x89);
  expect(png.bytes[1]).toBe(0x50);

  // Stickers preview from their metadata thumbnail, not from a caller-supplied ID.
  const sticker = await reader(IDS.invocationSticker, IDS.mediaSticker, 'preview', signal);
  expect(sticker.mime).toBe('image/jpeg');
  expect(calls.map((call) => call.fileId)).toEqual(['file-photo-old', 'file-photo-alpha', 'file-sticker-thumb']);
  for (const directory of directories) {
    await expect(access(directory)).rejects.toThrow();
  }
});

test('reads refuse media that is not snapshot-authorized before any download starts', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  // Media of the message's current revision is never authorized by an old snapshot.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaCurrentPhoto, 'original', signal), 'not_found', 404);
  // Same revision as the snapshot, but not listed in it.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaHiddenPhoto, 'original', signal), 'not_found', 404);
  // Listed by a snapshot row, but the message belongs to another conversation.
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaOtherDocument, 'original', signal), 'not_found', 404);
  // Unknown invocation and unknown media ID.
  await expectAdminError(reader(9_999n, IDS.mediaOldPhoto, 'original', signal), 'not_found', 404);
  await expectAdminError(reader(IDS.invocationMain, 9_998n, 'original', signal), 'not_found', 404);
  // The media is authorized in its own conversation.
  expect(calls).toHaveLength(0);

  await expectAdminError(reader(IDS.invocationBadJson, IDS.mediaOldPhoto, 'original', signal), 'snapshot_invalid', 409);
  await expectAdminError(
    reader(IDS.invocationMissingId, IDS.mediaOldPhoto, 'original', signal),
    'snapshot_invalid',
    409,
  );
  expect(calls).toHaveLength(0);
});

test('reads reject unsupported variants without touching Telegram', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const signal = new AbortController().signal;

  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'thumbnail' as unknown as InvocationMediaVariant, signal),
    'invalid_variant',
    400,
  );
  // Documents have no preview.
  await expectAdminError(
    reader(IDS.invocationOther, IDS.mediaOtherDocument, 'preview', signal),
    'invalid_variant',
    400,
  );
  await expectAdminError(reader(IDS.invocationMain, IDS.mediaSvg, 'preview', signal), 'invalid_variant', 400);
  expect(calls).toHaveLength(0);
});
