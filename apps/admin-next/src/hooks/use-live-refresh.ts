import { useEffect, useEffectEvent } from 'react';

/** Reconnect delay after a failed stream; doubles per failure up to the cap. */
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Poll interval used only while the stream is down. Browsers allow about six
 * HTTP/1.1 connections per origin, so a background tab must not hold a stream;
 * this keeps a visible tab with a broken stream at a reasonable freshness
 * without competing with the stream's own events.
 */
const FALLBACK_POLL_MS = 5_000;

/**
 * Keeps one page current from a Server-Sent Events channel.
 *
 * The stream carries no data: every event (including the one sent on connect)
 * means "the thing you are showing changed", and the caller refetches its
 * ordinary query. That keeps redaction, shapes and caching in one place, and
 * it means a session that expired under the stream surfaces through the same
 * 401 path as any other fetch instead of through a private error shape.
 *
 * A broken stream is not fatal. The hook closes it, polls the query until it
 * reconnects, and retries with backoff, so a restart of the panel or a
 * rejected connection degrades to a slow page rather than a frozen one.
 */
export function useLiveRefresh({
  url,
  enabled,
  onChange,
}: {
  /** The event-stream endpoint, or `null` when this page has none. */
  readonly url: string | null;
  /** The operator's preference; `false` disables the stream and every fallback. */
  readonly enabled: boolean;
  readonly onChange: () => void;
}): void {
  const notify = useEffectEvent(onChange);

  useEffect(() => {
    if (!enabled || url === null) {
      return undefined;
    }
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let backoff = INITIAL_BACKOFF_MS;
    let disposed = false;

    const stopPolling = (): void => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const connect = (): void => {
      if (disposed) {
        return;
      }
      const opened = new EventSource(url);
      source = opened;
      opened.addEventListener('open', () => {
        // A live stream makes the polling fallback redundant again.
        backoff = INITIAL_BACKOFF_MS;
        stopPolling();
      });
      opened.addEventListener('change', () => {
        notify();
      });
      opened.addEventListener('error', () => {
        // EventSource retries on its own with the server's `retry:` delay and no
        // backoff; closing it here hands the schedule to this hook, which backs
        // off and keeps the query fresh while the channel is unusable.
        opened.close();
        if (source === opened) {
          source = null;
        }
        if (disposed) {
          return;
        }
        stopPolling();
        pollTimer = setInterval(() => notify(), FALLBACK_POLL_MS);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          connect();
        }, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      });
    };

    const start = (): void => {
      if (source !== null || retryTimer !== undefined) {
        return;
      }
      connect();
    };

    /** A hidden tab keeps no connection: the browser would count it against the per-origin budget. */
    const stop = (): void => {
      source?.close();
      source = null;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      stopPolling();
      backoff = INITIAL_BACKOFF_MS;
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [url, enabled]);
}
