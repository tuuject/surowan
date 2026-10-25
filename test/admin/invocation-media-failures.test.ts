import { access, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { MediaDownloader } from '../../src/capabilities/media/download.ts';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import {
  IDS,
  closeInvocationMediaFixture,
  createReader,
  ebusy,
  expectAdminError,
  fixtureWriter,
  openInvocationMediaFixture,
  recordingDownloader,
  type InvocationMediaFixture,
} from './invocation-media-fixtures.ts';

/**
 * Failure modes around the download and the per-request temp directory: a
 * failed download, a Windows-style cleanup lock the reader retries, a cleanup
 * that never succeeds, and an abort that must still leave no directory behind.
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

test('an aborted request fails with media_aborted and leaves no temp directory', async () => {
  const { downloader, calls } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  const aborted = new AbortController();
  aborted.abort();
  await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', aborted.signal),
    'media_aborted',
    499,
  );
  expect(calls).toHaveLength(0);

  const shutdown = new AbortController();
  let started = false;
  const pending = recordingDownloader(async (_fileId, destination, signal) => {
    started = true;
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await writeFile(destination, opaquePng);
  });
  const startedReader = readerFor(pending.downloader, shutdown.signal);
  const read = startedReader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  await vi.waitFor(() => {
    expect(started).toBe(true);
  });
  shutdown.abort();
  await expectAdminError(read, 'media_aborted', 499);
  expect(pending.directories).toHaveLength(1);
  await expect(access(pending.directories[0] ?? '')).rejects.toThrow();
});

test('a failing download reports one generic error and removes partial files', async () => {
  const { downloader, calls, directories } = recordingDownloader(async (_fileId, destination) => {
    await writeFile(destination, opaquePng.subarray(0, 8));
    throw new Error(`telegram getFile failed for https://api.telegram.org/file/bot987:SECRET/${destination}`);
  });
  const reader = readerFor(downloader);
  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_download_failed',
    502,
  );
  expect(error.message).toBe('Invocation media download failed');
  expect(error.message).not.toContain('SECRET');
  expect(error.message).not.toContain('telegram');
  expect(error.message).not.toContain('surowan-invocation-media-');
  expect(calls).toHaveLength(1);
  expect(directories).toHaveLength(1);
  // The whole per-request directory (including the partial file) is removed.
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a transient cleanup failure is retried with bounded options and the bytes still return', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  // First attempt fails, the retry succeeds: a Windows lock that lands after
  // the bytes were read must not turn a successful read into a failure.
  fsHooks.rmFailure = (path, attempt) => (attempt === 0 ? ebusy(path) : undefined);

  const result = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  expect(Buffer.from(result.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  // The retry budget is bounded and configured at the call site.
  expect(fsHooks.rmOptions).toEqual([{ maxRetries: 3, retryDelay: 100 }]);
  expect(directories).toHaveLength(1);
  await expect(access(directories[0] ?? '')).rejects.toThrow();
});

test('a persistent cleanup failure rejects a successful read with a redacted code and frees the slot', async () => {
  const { downloader, directories } = recordingDownloader(fixtureWriter);
  const reader = readerFor(downloader);
  fsHooks.rmFailure = (path) => ebusy(path);

  // The download and the read both succeeded, yet no bytes may be returned:
  // the temp directory was not cleaned, and a raw EBUSY error carrying the temp
  // path must never reach the Admin API.
  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_cleanup_failed',
    500,
  );
  expect(error.message).toBe('Invocation media temporary files could not be removed');
  expect(error.message).not.toContain('EBUSY');
  expect(error.message).not.toContain('surowan-invocation-media-');
  expect(directories).toHaveLength(1);

  // The single-flight slot is released even though cleanup failed.
  fsHooks.rmFailure = undefined;
  const retry = await reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal);
  expect(Buffer.from(retry.bytes).equals(Buffer.from(opaquePng))).toBe(true);
  expect(directories).toHaveLength(2);

  // The failed cleanup left its directory behind (that is the condition under
  // test); remove it explicitly now that the injection is off.
  await rm(directories[0] ?? '', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('a failed read whose cleanup keeps failing ends with the cleanup code, not a leaked fs error', async () => {
  const { downloader, directories } = recordingDownloader(async (_fileId, destination) => {
    throw new Error(`telegram getFile failed for https://api.telegram.org/file/bot987:SECRET/${destination}`);
  });
  const reader = readerFor(downloader);
  fsHooks.rmFailure = (path) => ebusy(path);

  const error = await expectAdminError(
    reader(IDS.invocationMain, IDS.mediaOldPhoto, 'original', new AbortController().signal),
    'media_cleanup_failed',
    500,
  );
  // The cleanup failure is reported, not swallowed, and neither the fs error
  // nor the download error leaks a path or a secret.
  expect(error.message).toBe('Invocation media temporary files could not be removed');
  expect(error.message).not.toContain('EBUSY');
  expect(error.message).not.toContain('surowan-invocation-media-');

  // The failed cleanup left its directory behind (that is the condition under
  // test); remove it explicitly now that the injection is off.
  fsHooks.rmFailure = undefined;
  await rm(directories[0] ?? '', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
