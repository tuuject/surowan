import { Buffer } from 'node:buffer';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorDocument, jsonResponse, requestPath, runCli, startServer } from './harness.ts';
import { cleanup, ENV, mediaItem, mediaServer, type MediaManifest } from './media-fixtures.ts';

describe('surowan-utils invocation media', () => {
  it('fails fast on the item-count and declared-total limits before downloading', async () => {
    const tooMany = Array.from({ length: 33 }, (_value, index) => mediaItem(String(index + 1), { file_size: 1 }));
    const manyServer = await mediaServer('42', tooMany, new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(manyServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_too_many_items');
      expect(manyServer.requests).toHaveLength(1);
    } finally {
      await manyServer.close();
    }

    const large = Array.from({ length: 6 }, (_value, index) =>
      mediaItem(String(index + 1), { file_size: 20 * 1024 * 1024 }),
    );
    const largeServer = await mediaServer('42', large, new Map());
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(largeServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_total_too_large');
      expect(largeServer.requests).toHaveLength(1);
      expect(result.stdout).toBe('');
    } finally {
      await largeServer.close();
    }

    const oversized = [mediaItem('7', { file_size: 21 * 1024 * 1024 })];
    const oversizedServer = await mediaServer('42', oversized, new Map());
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(oversizedServer.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      expect(oversizedServer.requests).toHaveLength(1);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.error?.code).toBe('media_file_too_large');
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await oversizedServer.close();
    }
  }, 30_000);

  it('refuses an oversized stream, leaves no half file and removes the directory', async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 4096, 0x61);
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items: [mediaItem('5', { file_size: null })] });
        return;
      }
      // Chunked (no content-length) so only the streaming cap can stop it.
      response.writeHead(200, { 'content-type': 'image/jpeg', 'x-plasticwan-media-variant': 'original' });
      response.end(oversized);
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(errorDocument(result).error).toBe('media_download_failed');
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items[0]?.status).toBe('failed');
      expect(manifest.items[0]?.error?.code).toBe('media_file_too_large');
      expect(manifest.items[0]?.path).toBeNull();
      await expect(stat(manifest.directory)).rejects.toThrow();
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 60_000);

  it('aborts the last stream when the cumulative 100MiB budget runs out and keeps the partial manifest', async () => {
    // Every item declares no size and the server answers chunked (no
    // content-length), so only the streaming budget can stop the sixth item:
    // 20+20+20+20+19 MiB succeed and the last 1 MiB of the total is what the
    // final 4 MiB stream runs into.
    const body = Buffer.alloc(20 * 1024 * 1024, 0x62);
    const megabytes = [20, 20, 20, 20, 19, 4];
    const items = megabytes.map((_size, index) => mediaItem(String(index + 1), { file_size: null }));
    const server = await startServer((request, response) => {
      const path = requestPath(request);
      if (path === '/api/invocations/42/media') {
        jsonResponse(response, 200, { invocation_id: '42', items });
        return;
      }
      const match = /\/(\d+)\/content$/.exec(path);
      const size = match?.[1] === undefined ? undefined : megabytes[Number(match[1]) - 1];
      if (size === undefined) {
        jsonResponse(response, 404, { error: 'media_missing' });
        return;
      }
      response.writeHead(200, { 'content-type': 'image/jpeg', 'x-plasticwan-media-variant': 'original' });
      response.end(body.subarray(0, size * 1024 * 1024));
    });
    let manifest: MediaManifest | undefined;
    try {
      const result = await runCli(['invocation', 'media', '42', '--json'], { env: ENV(server.baseUrl) });
      expect(result.code).toBe(1);
      expect(errorDocument(result).error).toBe('media_download_failed');
      // The list plus all six content requests: the item that cannot fit is
      // still attempted, then cancelled while its body streams.
      expect(server.requests).toHaveLength(7);
      expect(server.requests.map((request) => requestPath(request))).toEqual([
        '/api/invocations/42/media',
        ...megabytes.map((_size, index) => `/api/invocations/42/media/${index + 1}/content`),
      ]);
      manifest = JSON.parse(result.stdout) as MediaManifest;
      expect(manifest.items.map((item) => item.status)).toEqual([
        'downloaded',
        'downloaded',
        'downloaded',
        'downloaded',
        'downloaded',
        'failed',
      ]);
      const downloadedBytes = manifest.items.reduce((total, item) => total + (item.bytes ?? 0), 0);
      expect(downloadedBytes).toBe(99 * 1024 * 1024);
      const last = manifest.items[5];
      expect(last?.error?.code).toBe('media_total_too_large');
      expect(last?.error?.message).toContain(String(1024 * 1024));
      expect(last?.path).toBeNull();
      expect(last?.bytes).toBeNull();
      expect(last?.sha256).toBeNull();
      // Partial successes keep their files and the manifest; the aborted item
      // left neither a body file nor a stray partial file.
      expect((await readdir(manifest.directory)).sort()).toEqual([
        '1.jpg',
        '2.jpg',
        '3.jpg',
        '4.jpg',
        '5.jpg',
        'manifest.json',
      ]);
      expect(JSON.parse(await readFile(join(manifest.directory, 'manifest.json'), 'utf8'))).toEqual(manifest);
    } finally {
      await cleanup(manifest);
      await server.close();
    }
  }, 120_000);
});
