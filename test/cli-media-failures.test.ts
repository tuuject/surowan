import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binaryResponse,
  errorDocument,
  jsonResponse,
  onlyRequest,
  requestPath,
  requestQuery,
  runCli,
  startServer,
} from './cli-harness.ts';
import {
  API_KEY,
  cleanup,
  type ContentEntry,
  ENV,
  JPEG_BYTES,
  mediaItem,
  mediaServer,
  type MediaManifest,
} from './cli-media-fixtures.ts';

describe('surowan-utils invocation media', () => {
  it('uses the requested variant and records an item that cannot offer it', async () => {
    const items = [mediaItem('5'), mediaItem('6', { variants: ['original'] })];
    const server = await mediaServer(
      '42',
      items,
      new Map<string, ContentEntry>([['5', { body: JPEG_BYTES, contentType: 'image/jpeg', variant: 'preview' }]]),
    );
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--variant', 'preview', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(requestQuery(onlyRequest(server, 1))).toEqual({ variant: 'preview' });
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.variant).toBe('preview');
      expect(manifest.items[0]?.status).toBe('downloaded');
      expect(manifest.items[1]?.status).toBe('failed');
      expect(manifest.items[1]?.error?.code).toBe('variant_not_available');
      expect(await readFile(join(manifest.directory, '5.jpg'))).toEqual(JPEG_BYTES);
      expect(result.stderr).not.toContain(API_KEY);
      expect(JSON.stringify(manifest)).not.toContain(API_KEY);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 30_000);

  it('refuses a media id that could escape the fixed content path', async () => {
    const server = await mediaServer('42', [mediaItem('../evil')], new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(errorDocument(result).error).toBe('invalid_response');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('turns a redirect, a stall and an unconfirmed variant into item failures', async () => {
    const items = [mediaItem('5'), mediaItem('6'), mediaItem('7')];
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items });
        return;
      }
      if (path.endsWith('/media/5/content')) {
        response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        response.end();
        return;
      }
      if (path.endsWith('/media/6/content')) {
        response.writeHead(200, { 'content-type': 'image/jpeg', 'x-surowan-media-variant': 'original' });
        response.write(JPEG_BYTES);
        // Never end the body: only the client-side timeout can stop the read.
        return;
      }
      binaryResponse(response, 200, JPEG_BYTES, {
        'content-type': 'image/jpeg',
        'x-surowan-media-variant': 'preview',
      });
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--timeout-ms', '400', '--json'], {
        env: ENV(server.baseUrl),
      });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items.map((item) => [item.id, item.error?.code])).toEqual([
        ['5', 'redirect_not_allowed'],
        ['6', 'timeout'],
        ['7', 'invalid_response'],
      ]);
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 60_000);
});
