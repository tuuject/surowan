import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binaryResponse,
  jsonResponse,
  onlyRequest,
  requestPath,
  requestQuery,
  runCli,
  startServer,
} from './harness.ts';
import {
  cleanup,
  type ContentEntry,
  ENV,
  JPEG_BYTES,
  mediaItem,
  mediaServer,
  type MediaManifest,
  PDF_BYTES,
} from './media-fixtures.ts';

describe('surowan-utils invocation media', () => {
  it('downloads every item sequentially into a fresh directory with a hashed manifest', async () => {
    const items = [
      mediaItem('5'),
      mediaItem('6', { kind: 'document', mime_type: 'application/pdf', variants: ['original'] }),
    ];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([
        ['5', { body: JPEG_BYTES, contentType: 'image/jpeg' }],
        ['6', { body: PDF_BYTES, contentType: 'application/pdf' }],
      ]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42'], { env: ENV(server.baseUrl) });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.invocation_id).toBe('42');
      expect(manifest.variant).toBe('original');
      expect(isAbsolute(manifest.directory)).toBe(true);
      expect(result.stdout).toContain('\n  ');

      expect(server.requests).toHaveLength(3);
      expect(requestPath(onlyRequest(server, 0))).toBe('/api/invocations/42/media');
      expect(requestPath(onlyRequest(server, 1))).toBe('/api/invocations/42/media/5/content');
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ variant: 'original' });
      expect(requestPath(onlyRequest(server, 2))).toBe('/api/invocations/42/media/6/content');

      const [photo, pdf] = manifest.items;
      expect(photo?.status).toBe('downloaded');
      expect(photo?.path).toBe(join(manifest.directory, '5.jpg'));
      expect(photo?.mime_type).toBe('image/jpeg');
      expect(photo?.bytes).toBe(JPEG_BYTES.byteLength);
      expect(photo?.sha256).toBe(createHash('sha256').update(JPEG_BYTES).digest('hex'));
      expect(photo?.error).toBeNull();
      expect(pdf?.path).toBe(join(manifest.directory, '6.pdf'));
      expect(pdf?.sha256).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));

      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      expect(await readFile(join(manifest.directory, '6.pdf'))).toEqual(PDF_BYTES);
      const manifestFile = JSON.parse(await readFile(join(manifest.directory, 'manifest.json'), 'utf8'));
      expect(manifestFile).toEqual(manifest);
      expect((await readdir(manifest.directory)).sort()).toEqual(['5.jpg', '6.pdf', 'manifest.json']);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('canonicalizes a leading-zero invocation id before comparing the echoed id', async () => {
    const server = await startServer((request, response) => {
      if (requestPath(request).endsWith('/media')) {
        // The Admin API always echoes the canonical decimal invocation id.
        jsonResponse(response, 200, { invocation_id: '42', items: [mediaItem('5')] });
        return;
      }
      binaryResponse(response, 200, JPEG_BYTES, {
        'content-type': 'image/jpeg',
        'x-plasticwan-media-variant': 'original',
      });
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '042', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.invocation_id).toBe('42');
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(server.requests.map((request) => requestPath(request))).toEqual([
        '/api/invocations/42/media',
        '/api/invocations/42/media/5/content',
      ]);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('derives file names from the validated id and MIME type, ignoring remote file names', async () => {
    const items = [
      mediaItem('9', {
        mime_type: '../../evil.jpg',
        filename: '../../evil.sh',
        path: 'C:\\Windows\\evil.exe',
        url: 'https://evil.example/evil',
        telegram_message_id: 'tg-must-not-leak',
      }),
    ];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['9', { body: JPEG_BYTES, contentType: 'application/octet-stream' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(0);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.path).toBe(join(manifest.directory, '9.bin'));
      expect((await readdir(manifest.directory)).sort()).toEqual(['9.bin', 'manifest.json']);
      expect(JSON.stringify(manifest)).not.toContain('evil');
      // Fields the server may add are neither required nor copied into the manifest.
      expect(manifest.items[0]).not.toHaveProperty('telegram_message_id');
      expect(result.stdout).not.toContain('tg-must-not-leak');
      expect(await readFile(join(manifest.directory, 'manifest.json'), 'utf8')).not.toContain('tg-must-not-leak');
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);
});
