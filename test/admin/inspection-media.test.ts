import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { media } from '../../src/store/schema/index.ts';
import { runCli } from '../cli/harness.ts';
import { auth, fixture, request } from './inspection-fixtures.ts';

test('CLI media export accepts the real authenticated Admin media projection and preserves original bytes', async () => {
  const f = await fixture();
  const admin = f.configStore.current().config.admin;
  if (admin === undefined) {
    throw new Error('Inspection fixture is missing its admin listener');
  }
  // The file schema requires a fixed positive port; only this isolated listener
  // uses an OS-assigned loopback port, with no access to saved CLI credentials.
  admin.port = 0;
  const listening = await f.server.start();
  let exportDirectory: string | undefined;
  try {
    const result = await runCli(['invocation', 'media', f.seeded.invocationA.toString(), '--json'], {
      env: {
        SUROWAN_ENDPOINT: `http://127.0.0.1:${listening.port}`,
        SUROWAN_API_KEY: f.key,
      },
      home: f.directory,
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout) as {
      invocation_id: string;
      directory: string;
      items: Array<{ id: string; status: string; path: string; bytes: number; sha256: string }>;
    };
    exportDirectory = manifest.directory;
    expect(manifest.invocation_id).toBe(f.seeded.invocationA.toString());
    expect(manifest.items).toHaveLength(1);
    const photo = f.store.orm.select().from(media).get();
    const downloaded = manifest.items[0];
    expect(downloaded).toMatchObject({ id: photo?.id.toString(), status: 'downloaded' });
    expect(downloaded).not.toHaveProperty('telegram_message_id');
    if (downloaded === undefined) {
      throw new Error('CLI export is missing its source media item');
    }
    const bytes = await readFile(downloaded.path);
    expect(bytes).toEqual(Buffer.from('fixture-original-bytes'));
    expect(downloaded.bytes).toBe(bytes.byteLength);
    expect(downloaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const savedManifest = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
    expect(JSON.parse(savedManifest)).toEqual(manifest);
    for (const forbidden of [f.key, 'file_id', 'file_unique_id', 'telegram_message_id']) {
      expect(result.stdout).not.toContain(forbidden);
      expect(savedManifest).not.toContain(forbidden);
    }
    expect(f.modelCalls()).toBe(0);
  } finally {
    await f.server.stop();
    if (exportDirectory !== undefined) {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  }
}, 30_000);

test('media content is authenticated, bounded to the source invocation and served as an attachment', async () => {
  const f = await fixture();
  const path = `/api/invocations/${f.seeded.invocationA}/media`;
  const list = await f.server.handle(request(path, { headers: auth(f.key) }));
  expect(list.status).toBe(200);
  const data = await list.json();
  const photo = f.store.orm.select().from(media).get();
  if (photo === undefined) {
    throw new Error('Inspection fixture is missing its photo');
  }
  expect(data).toMatchObject({ items: [{ id: photo.id.toString() }] });
  expect(JSON.stringify(data)).not.toContain('file_id');
  expect(JSON.stringify(data)).not.toContain('telegram_message_id');
  f.store.orm.update(media).set({ mimeType: 'image/svg+xml' }).where(eq(media.id, photo.id)).run();
  const contentPath = `${path}/${photo.id}/content`;
  expect((await f.server.handle(request(contentPath))).status).toBe(401);
  const response = await f.server.handle(request(`${contentPath}?variant=original`, { headers: auth(f.key) }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-disposition')).toBe('attachment');
  expect(response.headers.get('x-plasticwan-media-variant')).toBe('original');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    createHash('sha256').update('fixture-original-bytes').digest('hex'),
  );
  expect((await f.server.handle(request(`${contentPath}?variant=bad`, { headers: auth(f.key) }))).status).toBe(400);
  expect((await f.server.handle(request(`${contentPath}?path=anything`, { headers: auth(f.key) }))).status).toBe(400);
  expect((await f.server.handle(request(`${path}/999999/content`, { headers: auth(f.key) }))).status).toBe(404);
});
