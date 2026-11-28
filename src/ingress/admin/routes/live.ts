import type { Orm } from '../../../store/store.ts';
import {
  invocationExists,
  invocationListLiveFingerprint,
  invocationLiveFingerprint,
} from '../audit/invocation-live.ts';
import { parseId } from '../audit/shared.ts';
import type { AdminAuth } from '../auth.ts';
import { SECURITY_HEADERS, json, readCookie } from '../http.ts';
import { SESSION_COOKIE } from './auth.ts';

/** One second is the shortest interval that keeps a watched run feeling live without tax on the store. */
const DEFAULT_TICK_MS = 1_000;
/** Idle proxies and Node's idle-socket handling both need traffic well inside a minute. */
const DEFAULT_HEARTBEAT_MS = 15_000;
/** A browser tab opens at most two of these; the rest of the budget covers several operators and tabs. */
const DEFAULT_MAX_STREAMS = 32;
/**
 * Chunks a stalled socket may leave unread before the stream gives up on it.
 * A healthy reader drains between two ticks (events are at most one per tick
 * plus one heartbeat every fifteen), so a backlog this deep means the client
 * stopped reading and the queue would otherwise grow for the life of the tab.
 */
const MAX_QUEUED_CHUNKS = 8;

export interface LiveStreamOptions {
  /** Fingerprint interval; tests shorten it instead of waiting out real seconds. */
  readonly tickMs?: number;
  readonly heartbeatMs?: number;
  /** Concurrent streams per process, so a misbehaving client cannot pin unbounded timers. */
  readonly maxStreams?: number;
}

export interface LiveAdminDeps {
  readonly orm: Orm;
  readonly auth: AdminAuth;
  /** Aborted when the admin server stops; joined with the host's shutdown signal. */
  readonly stopSignal: AbortSignal;
  readonly options?: LiveStreamOptions;
}

/**
 * The Server-Sent Events change channels of the Invocation pages.
 *
 * They carry no data: one event means "the fingerprint of what you are looking
 * at changed", and the browser refetches the ordinary JSON endpoint, so
 * redaction and response shapes stay in the one place that already owns them.
 * A same-origin `EventSource` sends the panel cookie by itself, which is why
 * these two routes are session-only: a key or a signed client has no cookie and
 * must never reach a long-lived read.
 */
export function createLiveAdminHandler(deps: LiveAdminDeps) {
  const tickMs = deps.options?.tickMs ?? DEFAULT_TICK_MS;
  const heartbeatMs = deps.options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxStreams = deps.options?.maxStreams ?? DEFAULT_MAX_STREAMS;
  // The heartbeat tick also re-reads the session, so it doubles as the
  // revocation check. A heartbeat shorter than a tick still beats once a tick.
  const ticksPerBeat = Math.max(1, Math.round(heartbeatMs / tickMs));
  let open = 0;

  /** The stream body: an initial event, then one event per changed fingerprint, plus heartbeats. */
  const openStream = (fingerprint: () => string | null, request: Request, token: string): Response => {
    if (open >= maxStreams) {
      return json({ error: 'live_streams_exhausted', message: 'Too many live streams are open' }, 503);
    }
    open += 1;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let ticks = 0;
    let last: string | null = null;
    let changes = 0;
    let closed = false;

    /** Drops every resource exactly once; safe to call from any of the stop paths. */
    function release(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (ticker !== undefined) {
        clearInterval(ticker);
      }
      deps.stopSignal.removeEventListener('abort', finish);
      request.signal.removeEventListener('abort', finish);
      open -= 1;
    }

    /** The stream ended from the server side: stop the timer, then close the response body. */
    function finish(): void {
      release();
      try {
        controller?.close();
      } catch {
        // The client canceled at the same moment; the stream is already gone.
      }
    }

    function write(chunk: string): void {
      if (closed) {
        return;
      }
      // `enqueue` never throws when the consumer stops reading; it only grows
      // the queue. Past the bound the reader is gone, so drop the timer with it.
      if ((controller?.desiredSize ?? 0) < 0) {
        finish();
        return;
      }
      try {
        controller?.enqueue(encoder.encode(chunk));
      } catch {
        // A canceled consumer rejects further writes; drop the stream and its timer.
        release();
      }
    }

    function poll(): void {
      if (closed) {
        return;
      }
      let next: string | null;
      try {
        next = fingerprint();
      } catch {
        // A store closing under us (shutdown racing the timer) must not throw
        // out of a timer callback; the page will recover on its next reconnect.
        finish();
        return;
      }
      if (next === null) {
        // The Invocation was deleted while its page was open.
        finish();
        return;
      }
      if (next === last) {
        return;
      }
      last = next;
      changes += 1;
      // The fingerprint is every rendered column of the page, so it stays here.
      // `data` only has to be non-empty: `EventSource` does not dispatch an
      // event whose data is empty.
      write(`event: change\ndata: ${changes}\n\n`);
    }

    function tick(): void {
      if (closed) {
        return;
      }
      ticks += 1;
      if (ticks % ticksPerBeat === 0) {
        let session: ReturnType<AdminAuth['authenticate']>;
        try {
          session = deps.auth.authenticate(token);
        } catch {
          // `authenticate` reads and writes SQLite (it refreshes `last_seen_at`),
          // so a busy or closing database must end the stream, not throw out of
          // a timer callback.
          finish();
          return;
        }
        if (session === null) {
          // Logout, or the session was revoked: end the stream instead of
          // signalling a page whose next fetch is already a 401.
          finish();
          return;
        }
        write(': ping\n\n');
      }
      poll();
    }

    const body = new ReadableStream<Uint8Array>(
      {
        start(streamController) {
          controller = streamController;
          if (deps.stopSignal.aborted || request.signal.aborted) {
            finish();
            return;
          }
          deps.stopSignal.addEventListener('abort', finish, { once: true });
          request.signal.addEventListener('abort', finish, { once: true });
          // The timer exists before the first fingerprint: that poll may fail or
          // find the row deleted, and it closes the stream through `finish()`,
          // which can only clear a timer that was already assigned.
          ticker = setInterval(tick, tickMs);
          // A leaked stream must not hold a stopping process open on its own.
          ticker.unref?.();
          // Reconnect delay for the browser's own retry, then the event that
          // closes the gap between the page's first fetch and this stream.
          write('retry: 3000\n\n');
          poll();
        },
        cancel() {
          release();
        },
      },
      // `desiredSize` is measured against this: `write` reads it to notice a
      // reader that stopped draining.
      { highWaterMark: MAX_QUEUED_CHUNKS },
    );

    return new Response(body, {
      headers: {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // nginx buffers proxied responses by default, which would hold every
        // event until the buffer filled; this is the documented opt-out.
        'x-accel-buffering': 'no',
      },
    });
  };

  const handle = async (
    request: Request,
    segments: readonly string[],
    caller: 'session' | 'programmatic',
  ): Promise<Response | undefined> => {
    if (segments[0] !== 'live') {
      return undefined;
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed', message: 'Live streams are read-only' }, 405);
    }
    if (caller !== 'session') {
      // Defence in depth: the live routes are not in the admin-surface specs,
      // so a key never reaches here; a signed client must not either.
      return json({ error: 'forbidden', message: 'Live streams require a panel session' }, 403);
    }
    const token = readCookie(request, SESSION_COOKIE);
    if (segments.length === 2 && segments[1] === 'invocations') {
      return openStream(() => invocationListLiveFingerprint(deps.orm), request, token);
    }
    if (segments.length === 3 && segments[1] === 'invocations') {
      // A malformed id is answered by `parseId` as a 400, and an unknown one as
      // a 404 before any stream exists; an `EventSource` that got a 200 would
      // otherwise retry forever against nothing.
      const id = parseId(segments[2] ?? '', 'id');
      if (!invocationExists(deps.orm, id)) {
        return json({ error: 'not_found', message: 'Invocation does not exist' }, 404);
      }
      return openStream(() => invocationLiveFingerprint(deps.orm, id), request, token);
    }
    return undefined;
  };

  return { handle };
}
