/**
 * The live Invocation streams (`GET /api/live/invocations[/:id]`): who may open
 * one, what it answers before a stream exists, and what it reports.
 *
 * How this surface can fail — every case below is one of these:
 *
 * 1.  No session cookie still gets a stream, leaking the panel's audit data.
 * 2.  A Bearer key or a signed client reaches a stream: the route must be
 *      session-only even before `@surowan/admin-surface` speaks.
 * 3.  A non-GET is treated as a stream instead of a 405.
 * 4.  A malformed `:id` is a 500, or an unknown one returns a 200 stream that
 *      `EventSource` then retries forever.
 * 5.  Missing SSE headers: the body is buffered by a proxy, cached, or sniffed.
 * 6.  No event on connect, leaving the gap between the page's first fetch and
 *      the stream opening permanently stale.
 * 7.  The fingerprint ignores an insert (tool call, model call, send, resumed-by
 *      link, new Invocation) or an UPDATE (`pending` → `success` keeps the same
 *      text length; tokens, request and response snapshots land after their
 *      insert; `queued` → `running` leaves the live set the same size).
 * 8.  The fingerprint changes when nothing changed, so every page refetches
 *      every second.
 * 9.  The fingerprint walks a whole table per tick instead of the Invocation's
 *      own indexed rows (pinned by `test/schema/index-plans.test.ts`).
 * 10. A revoked session keeps the stream (and so a logged-out browser) alive.
 * 11. A heartbeat reaches the client as a data event, so it refetches every
 *      fifteen seconds for nothing.
 * 12. An event carries the fingerprint itself: every column the page renders
 *      goes to the browser on each change, growing with the Invocation, when
 *      the page only needs to know that something changed.
 * 13. An event's `data` is empty: `EventSource` drops such an event without
 *      dispatching it, so no page would ever refetch.
 */
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { adminSessions, hostSends, invocations, modelCalls, toolCalls } from '../../src/store/schema/index.ts';
import { bearer, createKey } from './api-keys-fixtures.ts';
import { readJson, request } from './fixtures.ts';
import {
  disposeOpened,
  expectChange,
  expectQuiet,
  Frames,
  FAST_BEAT,
  liveFixture,
  open,
  track,
} from './live-fixtures.ts';

afterEach(disposeOpened);

test('a cookie session opens the stream; every other credential is refused', async () => {
  const f = await liveFixture();
  const anonymous = await f.server.handle(request('/api/live/invocations'));
  expect(anonymous.status).toBe(401);
  expect((await readJson(anonymous)).error).toBe('unauthenticated');

  // A read key reaches every read-only audit route; the live channels are not
  // one of them, because holding one open outlives the request that authorized
  // it and never re-runs the permission gate.
  const key = await createKey(f.server, f.cookie, 'live-reader', 'read');
  for (const path of ['/api/live/invocations', '/api/live/invocations/4001']) {
    const keyed = await f.server.handle(request(path, { headers: bearer(key.key) }));
    expect(keyed.status).toBe(403);
    expect(keyed.headers.get('content-type')).toBe('application/json; charset=utf-8');
  }

  const detail = await open(f, '/api/live/invocations/4001');
  expect(detail.initial.event).toBe('change');
  // The stream's own event number, never the fingerprint it compares.
  expect(detail.initial.data).toBe('1');
  await detail.controller.abort();
});

test('405, 400 and 404 are answered before any stream exists', async () => {
  const f = await liveFixture();
  const wrongMethod = await f.server.handle(
    request('/api/live/invocations', { method: 'POST', headers: { cookie: f.cookie }, body: '{}' }),
  );
  expect(wrongMethod.status).toBe(405);
  expect((await readJson(wrongMethod)).error).toBe('method_not_allowed');

  const malformed = await f.server.handle(request('/api/live/invocations/abc', { headers: { cookie: f.cookie } }));
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get('content-type')).toBe('application/json; charset=utf-8');

  // A well-formed id that names no Invocation is a 404, the same answer the
  // JSON detail route gives, so no stream is ever opened against nothing.
  for (const path of ['/api/live/invocations/987654', '/api/live/invocations/0']) {
    const unknown = await f.server.handle(request(path, { headers: { cookie: f.cookie } }));
    expect(unknown.status).toBe(404);
    expect((await readJson(unknown)).error).toBe('not_found');
  }
});

test('the response is an unbuffered event stream with the panel security headers', async () => {
  const f = await liveFixture();
  const response = await f.server.handle(request('/api/live/invocations/4001', { headers: { cookie: f.cookie } }));
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  const frames = new Frames(response.body as ReadableStream<Uint8Array>);
  track(frames);
  // The browser's own retry delay first, then the event that closes the gap
  // between the page's first fetch and this stream.
  expect((await frames.next())?.raw).toBe('retry: 3000');
  expect((await frames.next())?.event).toBe('change');
});

test('every row the detail page renders changes the fingerprint; nothing else does', async () => {
  const f = await liveFixture();
  const { frames, controller, initial } = await open(f, '/api/live/invocations/4001');
  const now = new Date().toISOString();
  await expectQuiet(frames, 60);

  // A tool call that finishes without changing its text length: `pending` →
  // `success` is seven characters either way, so a "did anything get longer"
  // fingerprint would miss it and the row would stay Pending forever.
  f.store.orm
    .insert(toolCalls)
    .values({
      invocationId: 4_001n,
      toolCallId: 'call_live_pending',
      toolName: 'read',
      argumentsJson: '{}',
      state: 'pending',
      sideEffect: false,
      createdAt: now,
    })
    .run();
  const afterToolInsert = await expectChange(frames);
  // Events count up per stream; the quiet window above sent none.
  expect([initial.data, afterToolInsert]).toEqual(['1', '2']);
  f.store.orm
    .update(toolCalls)
    .set({ state: 'success', resultText: 'read:ok', finishedAt: now, durationMs: 5n })
    .where(eq(toolCalls.toolCallId, 'call_live_pending'))
    .run();
  expect(await expectChange(frames)).not.toBe(afterToolInsert);

  // A model call's tokens and cost land in an UPDATE after its pending insert.
  f.store.orm
    .insert(modelCalls)
    .values({
      invocationId: 4_001n,
      role: 'agent',
      provider: 'faux',
      model: 'faux-model',
      attempt: 1n,
      state: 'pending',
      createdAt: now,
    })
    .run();
  await expectChange(frames);
  // The request and response snapshots are written while the call is still
  // `pending` (`recordModelCallRequest`/`recordModelCallResponse`), once each,
  // so a page that read the row before them must still be told.
  const pending = f.store.orm
    .insert(modelCalls)
    .values({
      invocationId: 4_001n,
      role: 'agent',
      provider: 'faux',
      model: 'faux-thinking',
      attempt: 1n,
      state: 'pending',
      createdAt: now,
    })
    .returning({ id: modelCalls.id })
    .get();
  if (pending === undefined) {
    throw new Error('The fixture could not insert a pending model call');
  }
  await expectChange(frames);
  f.store.orm.update(modelCalls).set({ requestJson: '{"input":"live"}' }).where(eq(modelCalls.id, pending.id)).run();
  await expectChange(frames);
  f.store.orm.update(modelCalls).set({ responseJson: '{"status":200}' }).where(eq(modelCalls.id, pending.id)).run();
  await expectChange(frames);
  f.store.orm
    .update(modelCalls)
    .set({ state: 'success', inputTokens: 10n, outputTokens: 5n, totalTokens: 15n, cost: 0.5, finishedAt: now })
    .where(eq(modelCalls.id, pending.id))
    .run();
  await expectChange(frames);

  // A delivery: the send's state and message id both live on `host_sends`.
  f.store.orm
    .update(hostSends)
    .set({ state: 'error', errorCode: 'send_failed', finishedAt: now })
    .where(eq(hostSends.id, 8_101n))
    .run();
  await expectChange(frames);

  // The Invocation's own state, counters and side-effect bit.
  f.store.orm
    .update(invocations)
    .set({ state: 'running', startedAt: now, turnsUsed: 3n, sideEffectStarted: true })
    .where(eq(invocations.id, 4_001n))
    .run();
  await expectChange(frames);

  // The resumed-by link is a second Invocation row, not a column of this one.
  f.store.orm.update(invocations).set({ resumedFromInvocationId: 4_001n }).where(eq(invocations.id, 4_002n)).run();
  await expectChange(frames);

  await expectQuiet(frames, 120);
  await controller.abort();
});

test('the list stream reports arrivals and live-row changes only', async () => {
  const f = await liveFixture();
  const { frames, controller } = await open(f, '/api/live/invocations');
  await expectQuiet(frames, 60);

  const now = new Date().toISOString();
  const created = f.store.orm
    .insert(invocations)
    .values({
      bucketId: 3_001n,
      conversationId: 2_001n,
      state: 'queued',
      configHash: 'live-list',
      promptVersion: 1n,
      createdAt: now,
    })
    .returning({ id: invocations.id })
    .get();
  if (created === undefined) {
    throw new Error('The list fixture could not insert an Invocation');
  }
  await expectChange(frames);

  // queued → running changes only `state` and `started_at` of a row that was
  // already inside the live set, so a "live row count" fingerprint misses it.
  f.store.orm.update(invocations).set({ state: 'running', startedAt: now }).where(eq(invocations.id, created.id)).run();
  await expectChange(frames);

  // A tool call landing on that running row is its tool count on screen.
  f.store.orm
    .insert(toolCalls)
    .values({
      invocationId: created.id,
      toolCallId: 'call_live_list',
      toolName: 'read',
      argumentsJson: '{}',
      state: 'pending',
      sideEffect: false,
      createdAt: now,
    })
    .run();
  await expectChange(frames);

  // A terminal row that is deleted leaves the page entirely.
  f.store.orm.delete(invocations).where(eq(invocations.id, 4_002n)).run();
  await expectChange(frames);

  await expectQuiet(frames, 120);
  await controller.abort();
});

test('a comment heartbeat keeps an idle stream alive without signalling a change', async () => {
  const f = await liveFixture(FAST_BEAT);
  const { frames, controller } = await open(f, '/api/live/invocations/4001');
  const beat = await frames.next();
  expect(beat).toMatchObject({ event: null, data: '', comment: 'ping' });
  await expectQuiet(frames, 80);
  await controller.abort();
});

test('revoking the session ends the stream at the next heartbeat', async () => {
  const f = await liveFixture(FAST_BEAT);
  const { frames } = await open(f, '/api/live/invocations/4001');
  f.store.orm.delete(adminSessions).run();
  await frames.end();
  // A closed stream is what tells the client to stop trusting the channel and
  // fall back to its query, where the 401 reaches the login path.
  expect(frames.ended).toBe(true);
});
