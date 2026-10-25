import { access, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import { AdminQueryError } from '../../src/ingress/admin/audit/shared.ts';
import { listInvocationMedia } from '../../src/ingress/admin/invocation-media.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  IDS,
  closeInvocationMediaFixture,
  createReader,
  expectAdminError,
  fixtureWriter,
  openInvocationMediaFixture,
  recordingDownloader,
  stubTelegramFetch,
  telegramClient,
  type InvocationMediaFixture,
} from './invocation-media-fixtures.ts';

/**
 * The size, concurrency and wall-clock ceilings a read runs under: the stored
 * and streamed 20 MiB cap, the single download slot, the 60 second timeout and
 * aborts that must free the slot instead of holding it.
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

afterEach(() => {
  vi.unstubAllGlobals();
});

const readerFor = (downloader: MediaDownloader, shutdownSignal?: AbortSignal) =>
  createReader(store.orm, downloader, shutdownSignal);

test('reads refuse media whose stored size already exceeds 20 MiB', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaHugeSize, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
  expect(calls).toHaveLength(0);
});

test('a second concurrent read is refused with media_busy while the metadata list still works', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const downloader: MediaDownloader = {
    download: async (_fileId, destination, signal) => {
      started = true;
      await gate;
      signal.throwIfAborted();
      await writeFile(destination, opaquePng);
    },
  };
  const reader = readerFor(downloader);
  const first = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  await vi.waitFor(() => {
    expect(started).toBe(true);
  });
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'original', new AbortController().signal),
    'media_busy',
    429,
  );
  // The metadata list does not take the download slot.
  expect(listInvocationMedia(store.orm, IDS.invocationMain).items.length).toBeGreaterThan(0);
  release();
  const result = await first;
  expect(result.mime).toBe('image/png');
});

test('a read that exceeds the 60 second timeout fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let started = false;
    const pending = recordingDownloader(async (_fileId, destination, signal) => {
      started = true;
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      await writeFile(destination, opaquePng);
    });
    const reader = readerFor(pending.downloader);
    const read = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
    const outcome = read.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    while (!started) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (settled.ok) {
      throw new Error('Expected the timed-out read to fail');
    }
    expect(settled.error).toBeInstanceOf(AdminQueryError);
    expect((settled.error as AdminQueryError).code).toBe('media_timeout');
    expect((settled.error as AdminQueryError).status).toBe(504);
    expect(pending.directories).toHaveLength(1);
    await expect(access(pending.directories[0] ?? '')).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test('a payload Telegram itself reports as oversized maps to 413 media_too_large', async () => {
  const reader = readerFor(telegramClient(async () => ({ file_path: 'photos/payload.bin' })));
  // Media 6201 stores 68 bytes; Telegram's content-length says 20 MiB + 1. The
  // stored size is metadata, and the response header alone must end as 413.
  stubTelegramFetch({ 'content-length': String(20 * 1024 * 1024 + 1) }, []);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
});

test('a payload that only outgrows the cap while streaming maps to 413 media_too_large', async () => {
  const reader = readerFor(telegramClient(async () => ({ file_path: 'photos/payload.bin' })));
  // Media 6211 has no stored size at all, so only the streamed count can stop it.
  stubTelegramFetch({}, [new Uint8Array(1), new Uint8Array(20 * 1024 * 1024)]);
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaNullSize, 'original', new AbortController().signal),
    'media_too_large',
    413,
  );
});

test('a request abort while Telegram getFile is pending fails fast and frees the slot', async () => {
  let getFileCalls = 0;
  const client = telegramClient(() => {
    getFileCalls += 1;
    // getFile has no signal parameter: without the client-side race this would
    // never settle and the read would hold the single-flight slot forever.
    return new Promise<never>(() => undefined);
  });
  const reader = readerFor(client);
  const first = new AbortController();
  const read = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', first.signal);
  await vi.waitFor(() => {
    expect(getFileCalls).toBe(1);
  });
  first.abort();
  await expectAdminError(read, 'media_aborted', 499);

  // The slot is free again: the second read reaches its own getFile call
  // instead of being refused with media_busy.
  const second = new AbortController();
  const next = reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', second.signal);
  await vi.waitFor(() => {
    expect(getFileCalls).toBe(2);
  });
  second.abort();
  await expectAdminError(next, 'media_aborted', 499);
});
