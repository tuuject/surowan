/**
 * The lifetime of one live Invocation stream: every way the tick can end, and
 * the guarantee that no timer outlives the reason it ended.
 *
 * 1.  The timer is created after the first fingerprint already closed the
 *     stream, so nothing ever clears `this` interval (the closure's `release()`
 *     returns early for the rest of the process).
 * 2.  The session re-check throws inside the interval callback — SQLite is
 *     busy or the store is closing — and takes the admin process with it.
 * 3.  A client that stops draining grows the stream's queue for the life of the
 *     tab; the 32-stream cap does not bound that memory.
 * 4.  A timer survives the client disconnect or the server stop and queries the
 *     store after the panel closed it.
 * 5.  Streams are unbounded: a misbehaving client pins a timer per request.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { readJson, request } from './fixtures.ts';
import { disposeOpened, Frames, LIVE, liveFixture, open, track } from './live-fixtures.ts';

afterEach(disposeOpened);

test('the server stop and the client abort both end the stream and its timer', async () => {
  const f = await liveFixture();
  const counted = vi.spyOn(f.store.orm, 'all');
  try {
    const client = await open(f, '/api/live/invocations/4001');
    // The spy has to see the real ticks, or "no queries after the stop" would
    // pass on a stream that never queried anything in the first place.
    const whileOpen = counted.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counted.mock.calls.length).toBeGreaterThan(whileOpen);
    await client.controller.abort();
    await client.frames.end();
    const afterAbort = counted.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counted.mock.calls.length).toBe(afterAbort);

    const stopped = await open(f, '/api/live/invocations');
    await f.server.stop();
    await stopped.frames.end();
    const afterStop = counted.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counted.mock.calls.length).toBe(afterStop);
  } finally {
    counted.mockRestore();
  }
});

test('the stream budget rejects the connection past the cap with 503', async () => {
  const f = await liveFixture({ ...LIVE, maxStreams: 1 });
  const first = await open(f, '/api/live/invocations');
  const refused = await f.server.handle(request('/api/live/invocations/4001', { headers: { cookie: f.cookie } }));
  expect(refused.status).toBe(503);
  expect((await readJson(refused)).error).toBe('live_streams_exhausted');

  // Releasing one slot admits the next stream again.
  await first.controller.abort();
  await first.frames.end();
  const admitted = await open(f, '/api/live/invocations/4001');
  await admitted.controller.abort();
});

test('a fingerprint that fails or vanishes on connect leaves no timer behind', async () => {
  for (const failure of ['throws', 'vanishes'] as const) {
    const f = await liveFixture();
    const started = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    vi.spyOn(f.store.orm, 'all').mockImplementation(() => {
      if (failure === 'throws') {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      // No row: the Invocation disappeared between the 404 probe and the first
      // fingerprint, which closes the stream from inside `start()`.
      return [] as never;
    });
    try {
      const response = await f.server.handle(request('/api/live/invocations/4001', { headers: { cookie: f.cookie } }));
      const frames = new Frames(response.body as ReadableStream<Uint8Array>);
      const controller = track(frames);
      expect((await frames.next())?.raw).toBe('retry: 3000');
      await frames.end();

      // The tick that closed the stream must not have been scheduled after it:
      // a timer created past `closed` is never cleared, and every later stop
      // path returns early.
      const handle = started.mock.results[0]?.value as ReturnType<typeof setInterval> | undefined;
      expect(handle).toBeDefined();
      expect(cleared.mock.calls.some(([value]) => value === handle)).toBe(true);
      await controller.abort();
    } finally {
      vi.restoreAllMocks();
      f.store.close();
    }
  }
});

test('a failing session re-check ends the stream instead of throwing out of the timer', async () => {
  const f = await liveFixture({ tickMs: 20, heartbeatMs: 20, maxStreams: 4 });
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  try {
    const stream = await open(f, '/api/live/invocations/4001');
    // The panel stops (or another process holds the write lock): `authenticate`
    // reads and writes SQLite, so it throws on the next heartbeat tick.
    f.store.close();
    await stream.frames.end();
    expect(cleared).toHaveBeenCalled();
    await stream.controller.abort();
  } finally {
    cleared.mockRestore();
  }
});

test('a reader that stops draining is cut off instead of growing its queue', async () => {
  // A heartbeat on every tick fills the queue while nothing is read.
  const f = await liveFixture({ tickMs: 20, heartbeatMs: 20, maxStreams: 4 });
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  try {
    const stream = await open(f, '/api/live/invocations/4001');
    // Never read again: a healthy reader drains between two ticks, so a queue
    // that keeps growing means the socket behind it stopped draining.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await stream.frames.end(3_000);
    expect(cleared).toHaveBeenCalled();
    await stream.controller.abort();
  } finally {
    cleared.mockRestore();
  }
});
