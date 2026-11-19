import { open, unlink } from 'node:fs/promises';
import { MediaTooLargeError, type MediaDownloader } from '../../../capabilities/media/download.ts';
import { versionUserAgent } from '../../../platform/version.ts';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface TelegramFileApi {
  getFile(fileId: string): Promise<{ readonly file_path?: string }>;
}

/**
 * `getFile` has no signal parameter, so an abort that lands while it is pending
 * would otherwise pin the caller's single-flight slot until Telegram answered.
 * The race rejects with the abort reason and ignores the late result; nothing is
 * written for the discarded call, so no cleanup runs concurrently with a writer.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class TelegramMediaClient implements MediaDownloader {
  readonly #api: TelegramFileApi;
  readonly #token: string;

  constructor(api: TelegramFileApi, token: string) {
    this.#api = api;
    this.#token = token;
  }

  async download(fileId: string, destination: string, signal: AbortSignal): Promise<void> {
    const file = await abortable(this.#api.getFile(fileId), signal);
    if (file.file_path === undefined) {
      throw new Error('Telegram getFile response omitted file_path');
    }
    const encodedPath = file.file_path
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await fetch(`https://api.telegram.org/file/bot${this.#token}/${encodedPath}`, {
      headers: { 'user-agent': versionUserAgent() },
      signal,
      redirect: 'error',
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Telegram media download failed with status ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new MediaTooLargeError();
    }
    const handle = await open(destination, 'wx', 0o600);
    const reader = response.body.getReader();
    let size = 0;
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) {
          throw new MediaTooLargeError();
        }
        await handle.write(value);
      }
      completed = true;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await handle.close();
      if (!completed) {
        await unlink(destination).catch(() => undefined);
      }
    }
  }
}
