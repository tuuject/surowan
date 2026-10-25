import { expect, test, vi } from 'vitest';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaTooLargeError, TelegramMediaClient } from '../../src/capabilities/media/download.ts';
import { directories } from './fixtures.ts';

/** Drives the real download client with a scripted body; no network involved. */
function scriptedFetch(chunks: readonly Uint8Array[], headers: Record<string, string> = {}) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    headers: new Headers(headers),
  });
}

function telegramClient(getFile: () => Promise<{ readonly file_path?: string }>): TelegramMediaClient {
  return new TelegramMediaClient({ getFile }, 'test-token');
}

test('the download client types oversized content-length and streaming as MediaTooLargeError', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-media-download-'));
  directories.push(directory);
  const destination = join(directory, 'payload');
  const client = telegramClient(async () => ({ file_path: 'photos/payload.bin' }));
  const signal = new AbortController().signal;
  const cap = 20 * 1024 * 1024;

  vi.stubGlobal('fetch', scriptedFetch([], { 'content-length': String(cap + 1) }));
  try {
    await expect(client.download('file-big', destination, signal)).rejects.toBeInstanceOf(MediaTooLargeError);
  } finally {
    vi.unstubAllGlobals();
  }
  await expect(access(destination)).rejects.toThrow();

  // No content-length: only the streamed byte count can see the overrun. The
  // failed attempt must unlink its partial file, so the retry can reuse the
  // same destination (`open` with 'wx' would fail on a leftover file).
  vi.stubGlobal('fetch', scriptedFetch([new Uint8Array(1), new Uint8Array(cap)]));
  try {
    await expect(client.download('file-big', destination, signal)).rejects.toBeInstanceOf(MediaTooLargeError);
  } finally {
    vi.unstubAllGlobals();
  }
  await expect(access(destination)).rejects.toThrow();

  vi.stubGlobal('fetch', scriptedFetch([new Uint8Array([1, 2, 3])]));
  try {
    await client.download('file-small', destination, signal);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(new Uint8Array(await readFile(destination))).toEqual(new Uint8Array([1, 2, 3]));
});

test('an abort while getFile is pending rejects the download and a late response writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-media-download-'));
  directories.push(directory);
  const destination = join(directory, 'payload');
  const controller = new AbortController();
  let resolveGetFile: ((file: { readonly file_path?: string }) => void) | undefined;
  const pendingGetFile = new Promise<{ readonly file_path?: string }>((resolve) => {
    resolveGetFile = resolve;
  });
  const client = telegramClient(() => pendingGetFile);
  const download = client.download('file-id', destination, controller.signal);
  await vi.waitFor(() => {
    expect(resolveGetFile).toBeDefined();
  });

  // getFile cannot be cancelled; the download must not wait for Telegram.
  controller.abort();
  await expect(download).rejects.toMatchObject({ name: 'AbortError' });

  let fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch for a discarded download');
  });
  try {
    resolveGetFile?.({ file_path: 'photos/late.bin' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    vi.unstubAllGlobals();
  }
  expect(fetchCalls).toBe(0);
  await expect(access(destination)).rejects.toThrow();
});
