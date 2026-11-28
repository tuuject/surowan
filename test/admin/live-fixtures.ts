/**
 * Shared fixture for the live Invocation stream suites: a real `AdminServer`
 * over a real SQLite store with the stream timers shortened to milliseconds,
 * plus an SSE frame reader whose pending `read()` survives timeouts (racing a
 * fresh read each time would let two outstanding reads split one chunk and lose
 * frames).
 *
 * A suite that opens streams registers `disposeOpened` as its `afterEach`, so
 * every stream and its timer is gone before the next test starts.
 */
import { expect } from 'vitest';
import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { AdminServer } from '../../src/ingress/admin/index.ts';
import type { LiveStreamOptions } from '../../src/ingress/admin/routes/live.ts';
import { seedAdminFixture } from '../fixtures/admin-seed.ts';
import { setupAdmin } from './api-keys-fixtures.ts';
import { fixture, request } from './fixtures.ts';

export const LIVE: LiveStreamOptions = { tickMs: 20, heartbeatMs: 60_000, maxStreams: 4 };
/** Three ticks per heartbeat, for the idle-keepalive and session-revocation cases. */
export const FAST_BEAT: LiveStreamOptions = { tickMs: 20, heartbeatMs: 60, maxStreams: 4 };

type ReaderRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export interface Frame {
  /** The raw block, so the `retry:` line can be asserted as written. */
  readonly raw: string;
  readonly event: string | null;
  readonly data: string;
  readonly comment: string | null;
}

/**
 * Reads `text/event-stream` frames off a response body. The pending `read()` is
 * remembered across timeouts: racing a fresh read each time would let two
 * outstanding reads split one chunk between them and lose frames.
 */
export class Frames {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = '';
  #pending: Promise<ReaderRead> | null = null;
  #ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The next frame, or `null` when nothing arrived inside `timeoutMs`. */
  async next(timeoutMs = 2_000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const separator = this.#buffer.indexOf('\n\n');
      if (separator >= 0) {
        const block = this.#buffer.slice(0, separator);
        this.#buffer = this.#buffer.slice(separator + 2);
        return parseFrame(block);
      }
      if (this.#ended) {
        return null;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      const arrived = await this.#read(remaining);
      if (!arrived) {
        return null;
      }
    }
  }

  /** Waits for the stream to end; throws when it is still open at the deadline. */
  async end(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#ended) {
      if (Date.now() >= deadline) {
        throw new Error('The live stream is still open');
      }
      await this.#read(deadline - Date.now());
    }
  }

  async dispose(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }

  /** `true` when a chunk arrived (or the stream ended), `false` on timeout. */
  async #read(timeoutMs: number): Promise<boolean> {
    this.#pending ??= this.#reader.read();
    const decided = await Promise.race([
      this.#pending.then((result) => ({ result })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (decided === null) {
      return false;
    }
    this.#pending = null;
    if (decided.result.done) {
      this.#ended = true;
      return true;
    }
    this.#buffer += this.#decoder.decode(decided.result.value, { stream: true });
    return true;
  }
}

function parseFrame(raw: string): Frame {
  let event: string | null = null;
  let data = '';
  let comment: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data = data.length === 0 ? value : `${data}\n${value}`;
    }
  }
  return { raw, event, data, comment };
}

/** One change event, skipping the heartbeats that may share the window. */
export async function expectChange(frames: Frames): Promise<string> {
  while (true) {
    const frame = await frames.next();
    if (frame === null) {
      throw new Error('No change event arrived');
    }
    if (frame.comment !== null) {
      continue;
    }
    expect(frame.event).toBe('change');
    expect(frame.data).toMatch(/^[1-9]\d*$/);
    return frame.data;
  }
}

/** Nothing but heartbeats for the whole window. */
export async function expectQuiet(frames: Frames, timeoutMs = 120): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    const frame = await frames.next(remaining);
    if (frame === null) {
      return;
    }
    expect(frame.comment).not.toBeNull();
  }
}

export interface LiveFixture {
  readonly store: SqliteStore;
  readonly server: AdminServer;
  readonly cookie: string;
}

const opened: Array<{ readonly frames: Frames; readonly controller: AbortController }> = [];

/** Registers a stream reader for the suite-wide teardown (abort + dispose). */
export function track(frames: Frames, controller: AbortController = new AbortController()): AbortController {
  opened.push({ frames, controller });
  return controller;
}

/** Aborts and disposes every stream this test opened; call it from `afterEach`. */
export async function disposeOpened(): Promise<void> {
  for (const entry of opened.splice(0)) {
    entry.controller.abort();
    await entry.frames.dispose();
  }
}

export async function liveFixture(options: LiveStreamOptions = LIVE): Promise<LiveFixture> {
  const booted = await fixture({ liveStreams: options });
  seedAdminFixture(booted.store);
  const cookie = await setupAdmin(booted.store, booted.server);
  return { store: booted.store, server: booted.server, cookie };
}

export interface OpenStream {
  readonly frames: Frames;
  readonly controller: AbortController;
  /** The fingerprint sent on connect. */
  readonly initial: Frame;
}

export async function open(f: LiveFixture, path: string): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await f.server.handle(request(path, { headers: { cookie: f.cookie }, signal: controller.signal }));
  expect(response.status).toBe(200);
  const frames = new Frames(response.body as ReadableStream<Uint8Array>);
  opened.push({ frames, controller });
  const retry = await frames.next();
  expect(retry?.raw).toBe('retry: 3000');
  const initial = await frames.next();
  if (initial === null) {
    throw new Error('The live stream sent no initial event');
  }
  return { frames, controller, initial };
}
