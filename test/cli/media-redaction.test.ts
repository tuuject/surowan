import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorDocument, runCli } from './harness.ts';
import {
  API_KEY,
  cleanup,
  type ContentEntry,
  ENV,
  JPEG_BYTES,
  mediaItem,
  mediaServer,
  type MediaManifest,
} from './media-fixtures.ts';

describe('surowan-utils invocation media', () => {
  it('keeps media bytes intact even when they contain the test key, while the manifest stays redacted', async () => {
    const bytes = Buffer.from(`binary fixture ${API_KEY}`, 'utf8');
    const server = await mediaServer(
      '42',
      [mediaItem('5')],
      new Map<string, ContentEntry>([['5', { body: bytes, contentType: 'application/octet-stream' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(API_KEY);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      const item = manifest.items[0];
      expect(item?.bytes).toBe(bytes.byteLength);
      expect(item?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(await readFile(join(manifest.directory, '5.bin'))).toEqual(bytes);
      const saved = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
      expect(saved).not.toContain(API_KEY);
      expect(JSON.parse(saved)).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('keeps successful files on a partial failure and redacts the manifest on stdout and disk', async () => {
    const items = [mediaItem('5'), mediaItem('6')];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['5', { body: JPEG_BYTES, contentType: 'image/jpeg' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      expect(result.stderr).not.toContain(API_KEY);
      // `--json` stdout is compact, so the key can only be echoed by the item error.
      expect(result.stdout).not.toContain(API_KEY);
      expect(result.stdout).toContain('[redacted]');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(manifest.items[1]?.status).toBe('failed');
      expect(manifest.items[1]?.error?.code).toBe('media_missing');
      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      const manifestText = await readFile(join(manifest.directory, 'manifest.json'), 'utf8');
      expect(manifestText).not.toContain(API_KEY);
      expect(manifestText).toContain('[redacted]');
      expect(JSON.parse(manifestText)).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);
});
