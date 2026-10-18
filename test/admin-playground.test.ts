/**
 * T09 acceptance: the Admin Playground API.
 *
 * Driven through the real `AdminServer` router (session auth, Origin check,
 * body limits) over a real store, the real room ingress and the real local
 * asset store. Nothing here starts a model or a generation: the API's contract
 * is that reads never execute anything, every write is idempotent by request
 * key, and a nested id from another room reads as not found.
 */
import { afterAll, expect, test } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader } from '../src/adapters/local-monolith/config-reload.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { PlaygroundAssetStore } from '../src/capabilities/media/local-assets.ts';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { PlaygroundIngress } from '../src/ingress/playground.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import {
  hostSends,
  invocations,
  messages,
  playgroundAssets,
  playgroundInputs,
  playgroundMutations,
  playgroundReleases,
  rooms,
} from '../src/store/schema.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-admin-playground-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(join(staticDir, 'static'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
        static_dir: staticDir.replaceAll('\\', '/'),
      };
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const assetsRoot = join(directory, 'images', 'playground');
  const assets = new PlaygroundAssetStore({ orm: store.orm, root: assetsRoot });
  const rooms = new PlaygroundStore(store.orm);
  const ingress = new PlaygroundIngress(store.orm, { assets });
  const secrets = new SecretStore(keyJarPath(configPath));
  const modelSwitcher = new AgentModelSwitcher(configStore);
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const server = new AdminServer({
    store,
    configStore,
    configReloader,
    modelSwitcher,
    secrets,
    playground: { store, rooms, ingress, assets },
  });
  const setup = await server.handle(
    request('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    }),
  );
  return {
    store,
    server,
    rooms,
    ingress,
    assets,
    assetsRoot,
    cookie: sessionCookie(setup),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function post(path: string, body: unknown, cookie: string, origin?: string): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...(origin === undefined ? {} : { origin }) },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown, cookie: string): Request {
  return request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie: string): Request {
  return request(path, { headers: { cookie } });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

/**
 * The server's own JSON payload. One deliberate cast at the test boundary; every
 * assertion below names the fields it depends on.
 */
async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface RoomPayload {
  readonly room: {
    readonly id: string;
    readonly title: string;
    readonly revision: string;
    readonly next_seq: string;
    readonly hold: boolean;
    readonly image_enabled: boolean;
    readonly image_enabled_by: string | null;
    readonly pending: number;
  };
  readonly participants: readonly { readonly id: string; readonly name: string; readonly role: string }[];
  readonly held: readonly { readonly input_id: string; readonly seq: string }[];
  readonly staged_assets: readonly { readonly asset_id: string }[];
  readonly releases: readonly { readonly id: string; readonly invocation_id: string | null }[];
}

/** Creates a room through the API and returns its id and first revision. */
async function createRoom(
  f: Fixture,
  title: string,
  requestKey: string,
  members: readonly { name: string; role?: string }[] = [],
): Promise<{ id: string; revision: string }> {
  const response = await f.server.handle(
    post('/api/playground/rooms', { title, members, request_key: requestKey }, f.cookie),
  );
  expect(response.status).toBe(201);
  const payload = await readJson<{ room: { id: string; revision: string } }>(response);
  return { id: payload.room.id, revision: payload.room.revision };
}

async function addMember(f: Fixture, roomId: string, name: string, requestKey: string): Promise<string> {
  const response = await f.server.handle(
    post(`/api/playground/rooms/${roomId}/participants`, { name, request_key: requestKey }, f.cookie),
  );
  expect(response.status).toBe(201);
  const payload = await readJson<{ member: { id: string } }>(response);
  return payload.member.id;
}

async function roomState(f: Fixture, roomId: string): Promise<RoomPayload> {
  const response = await f.server.handle(get(`/api/playground/rooms/${roomId}`, f.cookie));
  expect(response.status).toBe(200);
  return await readJson<RoomPayload>(response);
}

function sendMessage(f: Fixture, roomId: string, body: Record<string, unknown>): Promise<Response> {
  return f.server.handle(post(`/api/playground/rooms/${roomId}/messages`, body, f.cookie));
}

function release(f: Fixture, roomId: string, body: Record<string, unknown>): Promise<Response> {
  return f.server.handle(post(`/api/playground/rooms/${roomId}/releases`, body, f.cookie));
}

/** The room's latest admitted input sequence, which a Release must state. */
function latestSeq(state: RoomPayload): string {
  return (BigInt(state.room.next_seq) - 1n).toString();
}

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

test('creates rooms and identities under request keys', async () => {
  const f = await fixture();
  try {
    const created = await createRoom(f, 'Room', 'room-1', [{ name: 'Ada' }]);
    const detail = await roomState(f, created.id);
    expect(detail.room).toMatchObject({ title: 'Room', hold: true, image_enabled: false, revision: '1' });
    expect(detail.participants.map((entry) => entry.name)).toEqual(['Ada']);

    const replay = await f.server.handle(
      post('/api/playground/rooms', { title: 'Room', members: [{ name: 'Ada' }], request_key: 'room-1' }, f.cookie),
    );
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ replayed: true, room: { id: created.id } });
    expect(f.store.orm.select().from(playgroundMutations).all()).toHaveLength(1);

    const conflicting = await f.server.handle(
      post('/api/playground/rooms', { title: 'Other', request_key: 'room-1' }, f.cookie),
    );
    expect(conflicting.status).toBe(409);
    expect(await readJson(conflicting)).toMatchObject({ error: 'input_conflict' });
    expect(f.store.orm.select().from(rooms).all()).toHaveLength(1);

    const member = await addMember(f, created.id, 'Bo', 'member-1');
    const memberReplay = await f.server.handle(
      post(`/api/playground/rooms/${created.id}/participants`, { name: 'Bo', request_key: 'member-1' }, f.cookie),
    );
    expect(memberReplay.status).toBe(200);
    expect(await readJson(memberReplay)).toMatchObject({ replayed: true, member: { id: member } });

    // The same key in another room is a different admission, not a replay.
    const other = await createRoom(f, 'Second', 'room-2');
    const otherMember = await addMember(f, other.id, 'Bo', 'member-1');
    expect(otherMember).not.toBe(member);
    expect(f.store.orm.select().from(playgroundMutations).all()).toHaveLength(4);
  } finally {
    f.store.close();
  }
});

test('admits messages under request keys and refuses a reused key with other content', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');

    const first = await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello' });
    expect(first.status).toBe(201);
    const admitted = await readJson<{ input_id: string; seq: string; revision: string; admitted: boolean }>(first);
    expect(admitted).toMatchObject({ seq: '1', admitted: true });

    const replay = await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello' });
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ input_id: admitted.input_id, admitted: false });

    const bo = await addMember(f, room.id, 'Bo', 'm-bo');
    for (const changed of [
      { sender_id: ada, text: 'different' },
      { sender_id: bo, text: 'hello' },
      { sender_id: ada, text: 'hello', reply_to_seq: admitted.seq },
    ]) {
      const conflict = await sendMessage(f, room.id, { request_key: 'msg-1', ...changed });
      expect(conflict.status).toBe(409);
      expect(await readJson(conflict)).toMatchObject({ error: 'input_conflict' });
    }
    expect(f.store.orm.select().from(playgroundInputs).all()).toHaveLength(1);

    // A sender of another room is not a member of this one.
    const other = await createRoom(f, 'Other', 'r2');
    const stranger = await addMember(f, other.id, 'Eve', 'm-2');
    const foreign = await sendMessage(f, room.id, { request_key: 'msg-2', sender_id: stranger, text: 'hi' });
    expect(foreign.status).toBe(404);
    expect(await readJson(foreign)).toMatchObject({ error: 'unknown_sender' });
    expect(f.store.orm.select().from(playgroundInputs).all()).toHaveLength(1);

    const timeline = await readJson<{
      items: {
        seq: string;
        text: string;
        input_state: string;
        sender: { id: string; name: string; is_bot: boolean };
      }[];
      has_more: boolean;
      status: { pending: number; revision: string; next_seq: string };
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/messages`, f.cookie)));
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]).toMatchObject({
      seq: '1',
      text: 'hello',
      input_state: 'held',
      sender: { id: ada, name: 'Ada', is_bot: false },
    });
    expect(timeline.status).toMatchObject({ pending: 1, revision: '2' });

    // The timeline pages backwards by the room's own sequence numbers, so a
    // page boundary stays stable while new messages arrive.
    await sendMessage(f, room.id, { request_key: 'msg-3', sender_id: ada, text: 'third' });
    const firstPage = await readJson<{
      items: { seq: string; text: string }[];
      has_more: boolean;
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/messages?limit=1`, f.cookie)));
    expect(firstPage.items.map((item) => item.seq)).toEqual(['2']);
    expect(firstPage.has_more).toBe(true);
    const secondPage = await readJson<{
      items: { seq: string; text: string }[];
      has_more: boolean;
    }>(
      await f.server.handle(
        get(`/api/playground/rooms/${room.id}/messages?limit=1&before=${firstPage.items[0]!.seq}`, f.cookie),
      ),
    );
    expect(secondPage.items.map((item) => item.text)).toEqual(['hello']);
    expect(secondPage.has_more).toBe(false);
  } finally {
    f.store.close();
  }
});

test('holds, releases once per key and refuses a stale boundary', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');

    // An empty release seals nothing, queues nothing and still closes the hold.
    const fresh = await roomState(f, room.id);
    const empty = await release(f, room.id, {
      request_key: 'rel-empty',
      revision: fresh.room.revision,
      through_seq: latestSeq(fresh),
    });
    expect(empty.status).toBe(201);
    expect(await readJson(empty)).toMatchObject({ invocation_id: null, replayed: false });
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(0);

    const emptyReplay = await release(f, room.id, {
      request_key: 'rel-empty',
      revision: fresh.room.revision,
      through_seq: latestSeq(fresh),
    });
    expect(emptyReplay.status).toBe(200);
    expect(await readJson(emptyReplay)).toMatchObject({ replayed: true, invocation_id: null });

    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'one' });
    await sendMessage(f, room.id, { request_key: 'msg-2', sender_id: ada, text: 'two' });

    // Hold is open-only: closing it is a Release.
    const throughHold = await f.server.handle(put(`/api/playground/rooms/${room.id}/hold`, { hold: false }, f.cookie));
    expect(throughHold.status).toBe(400);
    expect(await readJson(throughHold)).toMatchObject({ error: 'release_required' });
    const opened = await f.server.handle(put(`/api/playground/rooms/${room.id}/hold`, {}, f.cookie));
    expect(opened.status).toBe(200);
    const afterHold = await roomState(f, room.id);
    expect(afterHold.room.hold).toBe(true);

    // A boundary that is not the room's latest input is refused.
    const stale = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: '1',
    });
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'release_conflict' });

    const released = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: latestSeq(afterHold),
    });
    expect(released.status).toBe(201);
    const releaseBody = await readJson<{ release_id: string; invocation_id: string; through_seq: string }>(released);
    expect(releaseBody.invocation_id).not.toBeNull();
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);

    const replayAfterReal = await release(f, room.id, {
      request_key: 'rel-1',
      revision: afterHold.room.revision,
      through_seq: latestSeq(afterHold),
    });
    expect(replayAfterReal.status).toBe(200);
    expect(await readJson(replayAfterReal)).toMatchObject({
      replayed: true,
      invocation_id: releaseBody.invocation_id,
    });
    expect(f.store.orm.select().from(invocations).all()).toHaveLength(1);

    const detail = await readJson<{
      release: { through_seq: string; invocation_id: string };
      attempts: { id: string; state: string }[];
      sends: unknown[];
    }>(await f.server.handle(get(`/api/playground/rooms/${room.id}/releases/${releaseBody.release_id}`, f.cookie)));
    expect(detail.release).toMatchObject({
      through_seq: latestSeq(afterHold),
      invocation_id: releaseBody.invocation_id,
    });
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ id: releaseBody.invocation_id, state: 'queued' });
    expect(detail.sends).toEqual([]);

    const listed = await readJson<{ items: { id: string }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/invocations`, f.cookie)),
    );
    expect(listed.items).toHaveLength(1);
    const one = await readJson<{ invocation: { id: string } }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/invocations/${releaseBody.invocation_id}`, f.cookie)),
    );
    expect(one.invocation.id).toBe(releaseBody.invocation_id);

    // A retry is refused while nothing terminal happened, and says why.
    const refusedRetry = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/releases/${releaseBody.release_id}/retry`,
        { attempt_key: 'try-1' },
        f.cookie,
      ),
    );
    expect(refusedRetry.status).toBe(409);
    expect(await readJson(refusedRetry)).toMatchObject({ error: 'retry_refused' });
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
    ]) {
      expect((await f.server.handle(get(path, f.cookie))).status).toBe(400);
    }

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

test('uploads a picture, serves its bytes and refuses what the store rejects', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const png = Buffer.from(
      await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 4, g: 5, b: 6 } } })
        .png()
        .toBuffer(),
    );

    const uploaded = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        { content_base64: png.toString('base64'), mime: 'image/png', name: 'room.png' },
        f.cookie,
      ),
    );
    expect(uploaded.status).toBe(201);
    const asset = await readJson<{ asset_id: string; mime: string; byte_size: number }>(uploaded);
    expect(asset).toMatchObject({ mime: 'image/png', byte_size: png.byteLength });

    const staged = await readJson<{ items: { asset_id: string }[] }>(
      await f.server.handle(get(`/api/playground/rooms/${room.id}/assets`, f.cookie)),
    );
    expect(staged.items.map((item) => item.asset_id)).toEqual([asset.asset_id]);

    const content = await f.server.handle(
      get(`/api/playground/rooms/${room.id}/assets/${asset.asset_id}/content`, f.cookie),
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await content.arrayBuffer()).equals(png)).toBe(true);

    // The upload is not a message yet: it waits as a staged asset the room's
    // sweep may drop once it is an hour old.
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    expect(f.store.orm.select().from(messages).all()).toHaveLength(0);
    const roomDetail = await roomState(f, room.id);
    expect(roomDetail.staged_assets.map((item) => item.asset_id)).toEqual([asset.asset_id]);

    const notAnImage = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        {
          content_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mime: 'image/png',
        },
        f.cookie,
      ),
    );
    expect(notAnImage.status).toBe(422);
    expect((await readJson<{ error: string }>(notAnImage)).error).toMatch(/^upload_/);
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);
    const files = await readdir(f.assetsRoot, { recursive: true });
    expect(files.filter((entry) => entry.endsWith('.png'))).toHaveLength(1);

    // One element over the size cap is refused by itself (no "at least one" rule).
    const oversized = await f.server.handle(
      post(
        `/api/playground/rooms/${room.id}/assets`,
        { content_base64: Buffer.alloc(10 * 1024 * 1024 + 1, 7).toString('base64'), mime: 'image/png' },
        f.cookie,
      ),
    );
    expect(oversized.status).toBe(422);
    expect(await readJson(oversized)).toMatchObject({ error: 'upload_too_large' });
    expect(f.store.orm.select().from(playgroundAssets).all()).toHaveLength(1);

    // Content reads are authenticated like every other playground route.
    const anonymous = await f.server.handle(
      request(`/api/playground/rooms/${room.id}/assets/${asset.asset_id}/content`),
    );
    expect(anonymous.status).toBe(401);
  } finally {
    f.store.close();
  }
});

test('flips the image switch with a revision and keeps it attributed', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Room', 'r');
    const enabled = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: true, revision: room.revision }, f.cookie),
    );
    expect(enabled.status).toBe(200);
    expect(await readJson(enabled)).toMatchObject({
      room: { image_enabled: true, image_enabled_by: 'owner', revision: '2' },
    });

    const stale = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: false, revision: room.revision }, f.cookie),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'room_revision_mismatch' });
    expect(f.rooms.room(BigInt(room.id)).imageEnabled).toBe(true);

    // Setting the value it already has is a no-op, so a retried request does
    // not fail on the revision it just created.
    const idempotent = await f.server.handle(
      put(`/api/playground/rooms/${room.id}/capabilities`, { image_enabled: true, revision: room.revision }, f.cookie),
    );
    expect(idempotent.status).toBe(200);
    expect(await readJson(idempotent)).toMatchObject({ room: { revision: '2' } });
  } finally {
    f.store.close();
  }
});

test('mixed room data does not break the existing Telegram-scoped lists', async () => {
  const f = await fixture();
  try {
    const room = await createRoom(f, 'Mixed', 'r');
    const ada = await addMember(f, room.id, 'Ada', 'm-1');
    await sendMessage(f, room.id, { request_key: 'msg-1', sender_id: ada, text: 'hello room' });
    const state = await roomState(f, room.id);
    const released = await readJson<{ invocation_id: string }>(
      await release(f, room.id, {
        request_key: 'rel-1',
        revision: state.room.revision,
        through_seq: latestSeq(state),
      }),
    );
    expect(released.invocation_id).not.toBeNull();

    for (const path of [
      '/api/invocations',
      '/api/contexts',
      '/api/messages',
      '/api/chats',
      '/api/memories?state=active',
      '/api/overview',
      '/api/usage',
    ]) {
      const response = await f.server.handle(get(path, f.cookie));
      expect(response.status, `${path} must survive mixed hosts`).toBe(200);
    }

    // The Telegram-scoped lists do not present the room as a Telegram chat, and
    // the room's run is not a Telegram run.
    const invocationsList = await readJson<{ items: { chat?: { id?: string } }[] }>(
      await f.server.handle(get('/api/invocations', f.cookie)),
    );
    expect(invocationsList.items.every((item) => item.chat?.id !== room.id)).toBe(true);
    const chatsList = await readJson<{ items: { id?: string }[] }>(await f.server.handle(get('/api/chats', f.cookie)));
    expect(chatsList.items.some((item) => item.id === room.id)).toBe(false);
    const messagesList = await readJson<{ items: { chat_id?: string; chat?: { id?: string } }[] }>(
      await f.server.handle(get('/api/messages', f.cookie)),
    );
    expect(messagesList.items.some((item) => (item.chat_id ?? item.chat?.id) === room.id)).toBe(false);
  } finally {
    f.store.close();
  }
});
