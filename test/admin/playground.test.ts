/**
 * T09 acceptance: the Admin Playground API.
 *
 * Driven through the real `AdminServer` router (session auth, Origin check,
 * body limits) over a real store, the real room ingress and the real local
 * asset store. Nothing here starts a model or a generation: the API's contract
 * is that reads never execute anything, every write is idempotent by request
 * key, and a nested id from another room reads as not found.
 */
import { expect, test } from 'vitest';
import {
  addMember,
  createRoom,
  fixture,
  get,
  latestSeq,
  post,
  put,
  readJson,
  release,
  request,
  roomState,
  sendMessage,
} from './playground-fixtures.ts';
import {
  hostSends,
  invocations,
  playgroundInputs,
  playgroundMutations,
  playgroundReleases,
} from '../../src/store/schema/index.ts';

test('the playground API demands a session, refuses a foreign Origin and never accepts an API key', async () => {
  const f = await fixture();
  try {
    expect((await f.server.handle(request('/api/playground/rooms'))).status).toBe(401);

    const crossOrigin = await f.server.handle(
      post('/api/playground/rooms', { title: 'x', request_key: 'k' }, f.cookie, 'https://evil.test'),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

    // A key is not a session: a playground route stays unreachable with one, and
    // the request never falls back to the cookie it also carries.
    const withKey = await f.server.handle(
      request('/api/playground/rooms', {
        headers: { authorization: 'Bearer pwk_not-a-real-key', cookie: f.cookie },
      }),
    );
    expect(withKey.status).toBe(401);

    const authorized = await f.server.handle(get('/api/playground/rooms', f.cookie));
    expect(authorized.status).toBe(200);
    expect(await readJson(authorized)).toEqual({ items: [] });
  } finally {
    f.store.close();
  }
});

test('the invocation audit answers for a room under its own identity, for a session and an API key', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Audit Room', 'room-audit');
    const ada = await addMember(f, room.id, 'Ada', 'member-ada');
    expect((await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello' })).status).toBe(201);
    const state = await roomState(f, room.id);
    const released = await release(f, room.id, {
      request_key: 'rel-1',
      revision: state.room.revision,
      through_seq: latestSeq(state),
    });
    expect(released.status).toBe(201);
    const invocationId = (await readJson<{ invocation_id: string }>(released)).invocation_id;
    const chat = {
      host_kind: 'playground',
      telegram_chat_id: null,
      room_id: room.id,
      type: 'group',
      title: 'Audit Room',
      username: null,
      message_thread_id: 0,
    };

    const keyResponse = await f.server.handle(post('/api/api-keys', { name: 'audit' }, f.cookie));
    expect(keyResponse.status).toBe(200);
    const { key } = await readJson<{ key: string }>(keyResponse);
    for (const headers of [{ cookie: f.cookie }, { authorization: `Bearer ${key}` }]) {
      const listed = await f.server.handle(request('/api/invocations?host=playground', { headers }));
      expect(listed.status).toBe(200);
      expect((await readJson<{ items: unknown[] }>(listed)).items).toEqual([
        expect.objectContaining({ id: invocationId, state: 'queued', chat }),
      ]);
      const detail = await f.server.handle(request(`/api/invocations/${invocationId}`, { headers }));
      expect(detail.status).toBe(200);
      expect(await readJson(detail)).toMatchObject({ id: invocationId, chat });
    }
    const telegramOnly = await f.server.handle(get('/api/invocations?host=telegram', f.cookie));
    expect((await readJson<{ items: unknown[] }>(telegramOnly)).items).toEqual([]);
    const badHost = await f.server.handle(get('/api/invocations?host=irc', f.cookie));
    expect(badHost.status).toBe(400);
    expect(await readJson(badHost)).toMatchObject({ error: 'invalid_host' });
    // Reading the audit is not a way into the room: its own routes stay session-only.
    const roomWithKey = await f.server.handle(
      request(`/api/playground/rooms/${room.id}`, { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(roomWithKey.status).toBe(403);
  } finally {
    f.store.close();
  }
});

test('every nested id must belong to the room in the path', async () => {
  const f = await fixture();
  try {
    const first = await createRoom(f, 'One', 'r1');
    const second = await createRoom(f, 'Two', 'r2', [{ name: 'Eve' }]);
    const eveInSecond = (await roomState(f, second.id)).participants[0]!.id;
    const secondRelease = await readJson<{ release_id: string }>(
      await release(f, second.id, { request_key: 'rel', revision: second.revision, through_seq: '0' }),
    );
    const before = {
      inputs: f.store.orm.select().from(playgroundInputs).all().length,
      releases: f.store.orm.select().from(playgroundReleases).all().length,
      mutations: f.store.orm.select().from(playgroundMutations).all().length,
      sends: f.store.orm.select().from(hostSends).all().length,
      invocations: f.store.orm.select().from(invocations).all().length,
    };

    // A release of another room reads as not found.
    const foreignRelease = await f.server.handle(
      get(`/api/playground/rooms/${first.id}/releases/${secondRelease.release_id}`, f.cookie),
    );
    expect(foreignRelease.status).toBe(404);

    // A message naming another room's identity is refused.
    const foreignSender = await sendMessage(f, first.id, {
      request_key: 'x',
      sender_id: eveInSecond,
      text: 'hi',
    });
    expect(foreignSender.status).toBe(404);
    expect(await readJson(foreignSender)).toMatchObject({ error: 'unknown_sender' });

    // An unrelated asset id and an unknown room both read as not found.
    const foreignAsset = await f.server.handle(
      get(`/api/playground/rooms/${first.id}/assets/${'0'.repeat(32)}/content`, f.cookie),
    );
    expect(foreignAsset.status).toBe(404);
    expect((await f.server.handle(get('/api/playground/rooms/999999', f.cookie))).status).toBe(404);

    expect({
      inputs: f.store.orm.select().from(playgroundInputs).all().length,
      releases: f.store.orm.select().from(playgroundReleases).all().length,
      mutations: f.store.orm.select().from(playgroundMutations).all().length,
      sends: f.store.orm.select().from(hostSends).all().length,
      invocations: f.store.orm.select().from(invocations).all().length,
    }).toEqual(before);
  } finally {
    f.store.close();
  }
});

test('refuses ids that are not canonical decimals', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');

    for (const path of [
      '/api/playground/rooms/007',
      '/api/playground/rooms/-1',
      '/api/playground/rooms/pmsg_5',
      '/api/playground/rooms/99999999999999999999',
      // 19 digits, but past SQLite's int64: refused before any query binds it.
      '/api/playground/rooms/9999999999999999999',
      `/api/playground/rooms/${room.id}/messages?before=9999999999999999999`,
      `/api/playground/rooms/${room.id}/releases/9999999999999999999`,
      `/api/playground/rooms/${room.id}/invocations/9999999999999999999`,
    ]) {
      expect((await f.server.handle(get(path, f.cookie))).status).toBe(400);
    }
    const hugeRevision = await f.server.handle(
      put(
        `/api/playground/rooms/${room.id}/capabilities`,
        { image_enabled: true, revision: '9999999999999999999' },
        f.cookie,
      ),
    );
    expect(hugeRevision.status).toBe(400);

    for (const sender of ['007', '-1', 'puser_2', '99999999999999999999']) {
      const response = await sendMessage(f, room.id, { request_key: `k-${sender}`, sender_id: sender, text: 'x' });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: 'invalid_body' });
    }
    expect(f.store.orm.select().from(playgroundInputs).all()).toHaveLength(0);
    expect(ada).toBeDefined();
  } finally {
    f.store.close();
  }
});

test('a route deeper than its endpoint is not found and runs nothing', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r', [{ name: 'Ada' }]);
    const ada = (await roomState(f, room.id)).participants[0]!.id;
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    const state = await roomState(f, room.id);
    const released = await readJson<{ release_id: string }>(
      await release(f, room.id, { request_key: 'rel', revision: state.room.revision, through_seq: latestSeq(state) }),
    );
    f.store.orm.update(invocations).set({ state: 'failed', finishedAt: new Date().toISOString() }).run();
    const deeper = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/releases/${released.release_id}/retry/extra`,
        { attempt_key: 'try-1' },
        f.cookie,
      ),
    );
    expect(deeper.status).toBe(404);
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
