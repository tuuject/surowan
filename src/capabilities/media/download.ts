/**
 * The transport-neutral media download contract. One implementation per host
 * whose `mediaSource` is `download` lives in that host's adapter (the Telegram
 * one is `adapters/local-monolith/telegram/media.ts`); core only ever sees the
 * interface and the size-limit error.
 */
export interface MediaDownloader {
  download(fileId: string, destination: string, signal: AbortSignal): Promise<void>;
}

/**
 * The payload is larger than the 20 MB ceiling, whether that surfaced from the
 * response `content-length` or from the streamed byte count. Callers map this
 * type (never its message) to their own oversized outcome, such as the Admin
 * panel's 413 `media_too_large`.
 */
export class MediaTooLargeError extends Error {
  constructor() {
    super('Telegram media exceeds 20 MB');
    this.name = 'MediaTooLargeError';
  }
}
