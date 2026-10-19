import { afterAll, expect, test, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  isAnimatedPng,
  LocalAssetRejected,
  PlaygroundAssetStore,
  sniffImageMime,
} from '../src/capabilities/media/local-assets.ts';
import { MediaService } from '../src/capabilities/media/media.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import { media, playgroundAssets } from '../src/store/schema.ts';
import { crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-room-media-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  const assets = new PlaygroundAssetStore({ orm: store.orm, root: join(directory, 'assets') });
  const room = new PlaygroundStore(store.orm).createRoom({
    title: 'Room',
    members: [{ name: 'Ada', role: 'admin' }],
  });
  return { directory, store, assets, room };
}

async function png(width = 32, height = 16): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer(),
  );
}

test('content sniffing refuses anything that is not a still JPEG, PNG or WebP', async () => {
  expect(sniffImageMime(await png())).toBe('image/png');
  expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniffImageMime(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]))).toBe(
    'image/webp',
  );
  expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  expect(sniffImageMime(Buffer.from('GIF89a'))).toBeNull();
  expect(sniffImageMime(Buffer.from('not an image at all'))).toBeNull();
});

test('an upload is validated by its real bytes, not by its name or MIME claim', async () => {
  const { store, assets, room } = await setup();
  const bytes = await png();

  await expect(
    assets.ingest(room.chatId, { bytes: new Uint8Array(), declaredMime: 'image/png' }),
  ).rejects.toMatchObject({
    reason: 'empty',
  });
  await expect(assets.ingest(room.chatId, { bytes, declaredMime: 'image/svg+xml' })).rejects.toBeInstanceOf(
    LocalAssetRejected,
  );
  await expect(assets.ingest(room.chatId, { bytes, declaredMime: 'image/jpeg' })).rejects.toMatchObject({
    reason: 'type_mismatch',
  });
  await expect(
    assets.ingest(room.chatId, { bytes: Buffer.from('<svg/>'), declaredMime: 'image/png' }),
  ).rejects.toMatchObject({ reason: 'unsupported_type' });

  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await expect(assets.ingest(room.chatId, { bytes: fakePng, declaredMime: 'image/png' })).rejects.toMatchObject({
    reason: 'corrupt',
  });

  const huge = await png(32, 16);
  const limited = new PlaygroundAssetStore({
    orm: store.orm,
    root: join(room.chatId.toString(), 'too-small'),
    maxBytes: 16,
  });
  await expect(limited.ingest(room.chatId, { bytes: huge, declaredMime: 'image/png' })).rejects.toMatchObject({
    reason: 'too_large',
  });
});

test('an accepted image is stored under the room and deduplicated by content', async () => {
  const { assets, room } = await setup();
  const bytes = await png();

  const first = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });
  const second = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });

  expect(first.id).toMatch(/^[a-f0-9]{32}$/);
  expect(second.id).toBe(first.id);
  expect(first.mime).toBe('image/png');
  expect(first.width).toBe(32);
  expect(first.height).toBe(16);
  await expect(access(first.path)).resolves.toBeUndefined();
  expect(new Uint8Array(await readFile(first.path))).toEqual(bytes);
  expect(first.path).toContain(room.chatId.toString());
});

test('a room message carries its images into the snapshot as local media rows', async () => {
  const { store, assets, room } = await setup();
  const ingress = new PlaygroundIngress(store.orm, { assets });
  const bytes = await png();
  const uploaded = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png', name: 'shot.png' });

  const result = await ingress.submit(room.chatId, {
    requestKey: 'req-image',
    senderId: room.members[0]!.senderId,
    text: '',
    assetIds: [uploaded.id],
  });
  expect(result.admitted).toBe(true);

  const rows = store.orm.select().from(media).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: 'photo',
    hostKind: 'playground',
    mimeType: 'image/png',
    width: 32n,
    height: 16n,
  });
  expect(rows[0]!.fileId).toMatch(/^local:[a-f0-9]{32}$/);
  expect(rows[0]!.fileUniqueId).toMatch(/^local:\d+:[a-f0-9]{64}$/);
  expect(rows[0]!.localAssetId).toBe(rows[0]!.fileId.slice('local:'.length));

  const playground = new PlaygroundStore(store.orm);
  const release = ingress.release(room.chatId, {
    releaseKey: 'rel-image',
    revision: playground.room(room.chatId).revision,
  });
  const [snapshotRow] = store.orm.all<{ snapshot_json: string }>(
    sql`SELECT snapshot_json FROM invocation_messages WHERE invocation_id = ${release.invocationId!}`,
  );
  const snapshot = JSON.parse(snapshotRow!.snapshot_json) as {
    media: { kind: string; mime_type: string; width: string; height: string }[];
  };
  expect(snapshot.media).toHaveLength(1);
  expect(snapshot.media[0]).toMatchObject({ kind: 'photo', mime_type: 'image/png', width: '32', height: '16' });

  await expect(
    ingress.submit(room.chatId, { requestKey: 'req-image-2', senderId: room.members[0]!.senderId, text: '' }),
  ).rejects.toMatchObject({ code: 'input_conflict' });
});

test('a room image is read locally and never falls back to Telegram', async () => {
  const { store, directory, assets, room } = await setup();
  const loaded = await loadConfig(join(directory, 'config.jsonc'));
  const configStore = await testConfigStore(loaded);
  const bytes = await png();
  const asset = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });
  const download = vi.fn(async () => {
    throw new Error('telegram download must not run for a room asset');
  });
  const service = new MediaService({
    store,
    configStore,
    secrets: new SecretStore(),
    mediaClient: { download },
    modelGate: new KeyedSemaphore(),
    localAssets: assets,
  });

  const ingress = new PlaygroundIngress(store.orm, { assets });
  await ingress.submit(room.chatId, {
    requestKey: 'req-read',
    senderId: room.members[0]!.senderId,
    text: 'look',
    assetIds: [asset.id],
  });
  const mediaRows = store.orm.select().from(media).all();
  const images = await service.loadDirectImages(
    [{ mediaId: mediaRows[0]!.id, imageRef: 'img_1' }],
    new AbortController().signal,
  );
  expect(images).toHaveLength(1);
  expect(images[0]!.mimeType).toBe('image/jpeg');
  expect(images[0]!.data.length).toBeGreaterThan(0);
  expect(download).not.toHaveBeenCalled();

  // A row whose asset disappeared must fail instead of reaching for Telegram.
  store.orm.delete(media).run();
  store.orm
    .insert(media)
    .values({
      revisionId: 1n,
      kind: 'photo',
      fileId: 'local:missing',
      fileUniqueId: 'local:1:missing',
      mimeType: 'image/png',
      telegramJson: '{}',
      hostKind: 'playground',
      localAssetId: '0'.repeat(32),
    })
    .run();
  const orphan = store.orm.select().from(media).all().at(-1)!;
  await expect(
    service.loadDirectImages([{ mediaId: orphan.id, imageRef: 'img_2' }], new AbortController().signal),
  ).rejects.toThrow(/Room media is unavailable/);
  expect(download).not.toHaveBeenCalled();
  expect(assets.resolve(asset.id)?.path).toBe(asset.path);
});

test('a staged upload that never became a message is swept', async () => {
  const { assets, room } = await setup();
  const bytes = await png();
  const asset = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });

  const swept = await assets.sweep({ staleAfterMs: -1 });
  expect(swept.staged).toBe(1);
  await expect(access(asset.path)).rejects.toThrow();
  expect(assets.resolve(asset.id)).toBeNull();
});

test('an asset shared by two messages survives losing one of them', async () => {
  const { store, assets, room } = await setup();
  const ingress = new PlaygroundIngress(store.orm, { assets });
  const bytes = await png();
  for (const requestKey of ['req-first', 'req-second']) {
    // The same bytes uploaded twice resolve to the room's one asset.
    const uploaded = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });
    await ingress.submit(room.chatId, {
      requestKey,
      senderId: room.members[0]!.senderId,
      text: requestKey,
      assetIds: [uploaded.id],
    });
  }
  const rows = store.orm.select().from(media).all();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.localAssetId)).size).toBe(1);
  const assetId = rows[0]!.localAssetId!;

  // The asset row names only the latest attachment; dropping it nulls that
  // link while the first message still shows the image.
  store.orm.run(sql`DELETE FROM media WHERE id = ${rows[1]!.id}`);
  await assets.sweep({ staleAfterMs: -1 });
  expect(assets.resolve(assetId)).not.toBeNull();
  await expect(access(assets.resolve(assetId)!.path)).resolves.toBeUndefined();

  // With no message left, the asset is disposable.
  store.orm.run(sql`DELETE FROM media WHERE id = ${rows[0]!.id}`);
  const swept = await assets.sweep({ staleAfterMs: -1 });
  expect(swept.staged).toBe(1);
  expect(assets.resolve(assetId)).toBeNull();
});

/** Insert an APNG animation control chunk right after IHDR. */
function withAnimationControl(png: Uint8Array): Uint8Array {
  const ihdrEnd = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, 2);
  const type = new TextEncoder().encode('acTL');
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  chunk.set(type, 4);
  chunk.set(body, 8);
  view.setUint32(8 + body.length, crc32(Buffer.concat([type, body])));
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

test('an animated PNG is refused even though it decodes as one frame', async () => {
  const { assets, room } = await setup();
  const still = await png();
  const animated = withAnimationControl(still);
  expect(isAnimatedPng(still)).toBe(false);
  expect(isAnimatedPng(animated)).toBe(true);

  await expect(assets.ingest(room.chatId, { bytes: animated, declaredMime: 'image/png' })).rejects.toMatchObject({
    reason: 'animated',
  });
});

test('an image with a valid header but a truncated payload is refused', async () => {
  const { assets, room } = await setup();
  const bytes = new Uint8Array(
    await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } })
      .png()
      .toBuffer(),
  );
  const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));

  await expect(assets.ingest(room.chatId, { bytes: truncated, declaredMime: 'image/png' })).rejects.toMatchObject({
    reason: 'corrupt',
  });
  expect(assets.ids(room.chatId)).toEqual([]);
});

test('concurrent uploads of the same bytes resolve to one asset and one file', async () => {
  const { assets, room } = await setup();
  const bytes = await png();

  const [first, second] = await Promise.all([
    assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' }),
    assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' }),
  ]);

  expect(second.id).toBe(first.id);
  expect(assets.ids(room.chatId)).toEqual([first.id]);
  const files = (await readdir(join(first.path, '..'))).filter((name) => !name.endsWith('.part'));
  expect(files).toHaveLength(1);
});

test('a sweep never deletes an asset attached while it was running', async () => {
  const { store, assets, room } = await setup();
  const one = await assets.ingest(room.chatId, { bytes: await png(8, 8), declaredMime: 'image/png' });
  const two = await assets.ingest(room.chatId, { bytes: await png(9, 9), declaredMime: 'image/png' });
  const playground = new PlaygroundStore(store.orm);

  // Both are stale when the sweep selects them. The sweep yields while it
  // removes the first file; a submission attaches the second in that window.
  const sweeping = assets.sweep({ staleAfterMs: -1 });
  playground.submit(room.chatId, {
    requestKey: 'req-late',
    senderId: room.members[0]!.senderId,
    text: '',
    media: [{ assetId: two.id, sha256: two.sha256, mime: two.mime, byteSize: two.byteSize, width: 9, height: 9 }],
  });
  await sweeping;

  expect(assets.resolve(one.id)).toBeNull();
  expect(assets.resolve(two.id)).not.toBeNull();
  await expect(access(two.path)).resolves.toBeUndefined();
  expect(store.orm.select({ id: playgroundAssets.id }).from(playgroundAssets).all()).toEqual([{ id: two.id }]);
});

test('an asset handed to a second uploader survives its creator rolling back', async () => {
  const { assets, room } = await setup();
  const bytes = await png();
  // A delivery creates the asset, an upload of the same bytes receives it, and
  // then the delivery rolls back what it created.
  const created = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });
  const reused = await assets.ingest(room.chatId, { bytes, declaredMime: 'image/png' });
  expect(created.created).toBe(true);
  expect(reused).toMatchObject({ id: created.id, created: false });
  await assets.discard(created.id);

  expect(assets.resolve(reused.id)).not.toBeNull();
  await expect(access(reused.path)).resolves.toBeUndefined();
  // Retention still applies to it.
  expect((await assets.sweep({ staleAfterMs: -1 })).staged).toBe(1);
  expect(assets.resolve(reused.id)).toBeNull();
});

test('uploads that are never sent age out without any submission', async () => {
  const { store, directory, room } = await setup();
  let clock = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const assets = new PlaygroundAssetStore({ orm: store.orm, root: join(directory, 'aging'), now: () => clock });
  const stale = await assets.ingest(room.chatId, { bytes: await png(8, 8), declaredMime: 'image/png' });
  // The sweep is throttled per process: a fresh process's first upload sweeps.
  clock = new Date();
  const fresh = await new PlaygroundIngress(store.orm, { assets }).upload(room.chatId, {
    bytes: await png(9, 9),
    declaredMime: 'image/png',
  });
  await vi.waitFor(() => expect(assets.resolve(stale.id)).toBeNull());
  expect(assets.resolve(fresh.id)).not.toBeNull();
});
