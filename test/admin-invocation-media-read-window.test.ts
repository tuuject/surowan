import { access } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { MediaDownloader } from '../src/capabilities/media/media-download.ts';
import type { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  IDS,
  closeInvocationMediaFixture,
  createReader,
  expectAdminError,
  expectSettledError,
  fixtureWriter,
  openInvocationMediaFixture,
  parkFirstRead,
  recordingDownloader,
  settle,
  waitForPark,
  type InvocationMediaFixture,
} from './admin-invocation-media-fixtures.ts';

/**
 * Timeouts and cancellations that land after the download started: parked reads
 * prove the 60 second deadline and the request signal are honoured while the
 * bytes are in flight, and that the temp directory is always removed.
 */

/**
 * `readFile` is wrapped so a test can park a read or abort immediately before
 * or after the bytes arrive: the timeout and cancellation cases below must land
 * inside the read window, not merely before the download. `rm` is wrapped so a
 * transient or persistent Windows-style EBUSY cleanup failure is deterministic:
 * while a failure hook is set, the wrapper reproduces Node's documented
 * `maxRetries`/`retryDelay` contract for the options the caller passed, so the
 * options the reader passes decide whether a transient failure is absorbed.
 * Every other export stays real, and without hooks both wrappers are
 * pass-throughs.
 */
const fsHooks = vi.hoisted(() => ({
  beforeRead: undefined as ((path: string) => Promise<void> | void) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  rmFailure: undefined as ((path: string, attempt: number) => Error | undefined) | undefined,
  rmOptions: [] as { readonly maxRetries?: number | undefined; readonly retryDelay?: number | undefined }[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (path: string, options?: { readonly signal?: AbortSignal }) => {
      await fsHooks.beforeRead?.(path);
      const bytes = await actual.readFile(path, options);
      fsHooks.afterRead?.(path);
      return bytes;
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const failure = fsHooks.rmFailure;
      if (failure === undefined) {
        return actual.rm(path, options);
      }
      fsHooks.rmOptions.push({ maxRetries: options?.maxRetries, retryDelay: options?.retryDelay });
      const maxRetries = options?.maxRetries ?? 0;
      const retryDelay = options?.retryDelay ?? 100;
      for (let attempt = 0; ; attempt += 1) {
        const error = failure(String(path), attempt);
        if (error === undefined) {
          break;
        }
        if (attempt >= maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
      return actual.rm(path, options);
    },
  };
});

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
  fsHooks.beforeRead = undefined;
  fsHooks.afterRead = undefined;
  fsHooks.rmFailure = undefined;
  fsHooks.rmOptions = [];
});

const readerFor = (downloader: MediaDownloader, shutdownSignal?: AbortSignal) =>
  createReader(store.orm, downloader, shutdownSignal);

test('a timeout while the downloaded original is being read fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { downloader, directories } = recordingDownloader(fixtureWriter);
    const reader = readerFor(downloader);
    const parked = parkFirstRead(fsHooks);
    const settled = settle(reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal));
    await waitForPark(parked.reached);
    await vi.advanceTimersByTimeAsync(60_000);
    parked.release();
    await expectSettledError(settled, 'media_timeout', 504);
    expect(directories).toHaveLength(1);
    await expect(access(directories[0] ?? '')).rejects.toThrow();

    // The timeout released the single-flight slot and the directory.
    fsHooks.beforeRead = undefined;
    const retry = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
    expect(Buffer.from(retry.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('a timeout while preview normalization reads its input fails with media_timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { downloader, directories } = recordingDownloader(fixtureWriter);
    const reader = readerFor(downloader);
    const parked = parkFirstRead(fsHooks);
    const settled = settle(reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', new AbortController().signal));
    await waitForPark(parked.reached);
    await vi.advanceTimersByTimeAsync(60_000);
    parked.release();
    await expectSettledError(settled, 'media_timeout', 504);
    expect(directories).toHaveLength(1);
    await expect(access(directories[0] ?? '')).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test('a cancelled request during preview normalization fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  fsHooks.beforeRead = () => {
    request.abort();
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'preview', request.signal),
    'media_aborted',
    499,
  );
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a request cancelled right after the original bytes were read fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  fsHooks.afterRead = () => {
    request.abort();
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', request.signal),
    'media_aborted',
    499,
  );
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a request cancelled while the preview output is being read fails with media_aborted', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const request = new AbortController();
  let reads = 0;
  fsHooks.beforeRead = () => {
    reads += 1;
    if (reads === 2) {
      // The second read is the normalized output: normalization already
      // succeeded, so only the read-window check can stop this response.
      request.abort();
    }
  };
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaAlphaPhoto, 'preview', request.signal),
    'media_aborted',
    499,
  );
  expect(reads).toBe(2);
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});
