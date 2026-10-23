/**
 * Shared room/server fixtures for the Admin Playground API suites.
 *
 * Driven through the real `AdminServer` router (session auth, Origin check,
 * body limits) over a real store, the real room ingress and the real local
 * asset store. Nothing here starts a model or a generation: the API's contract
 * is that reads never execute anything, every write is idempotent by request
 * key, and a nested id from another room reads as not found.
 *
 * This is not a test file: it is imported by the `admin-playground*.test.ts`
 * suites, and registers their shared temp-directory cleanup.
 */
import { afterAll, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const PASSWORD = 'correct-horse-battery';
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export async function fixture() {
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

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

export function post(path: string, body: unknown, cookie: string, origin?: string): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...(origin === undefined ? {} : { origin }) },
    body: JSON.stringify(body),
  });
}

export function put(path: string, body: unknown, cookie: string): Request {
  return request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

export function get(path: string, cookie: string): Request {
  return request(path, { headers: { cookie } });
}

export function sessionCookie(response: Response): string {
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
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface RoomPayload {
  readonly room: {
    readonly id: string;
    readonly title: string;
    readonly revision: string;
    readonly next_seq: string;
    readonly latest_input_seq: string;
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
export async function createRoom(
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

export async function addMember(f: Fixture, roomId: string, name: string, requestKey: string): Promise<string> {
  const response = await f.server.handle(
    post(`/api/playground/rooms/${roomId}/participants`, { name, request_key: requestKey }, f.cookie),
  );
  expect(response.status).toBe(201);
  const payload = await readJson<{ member: { id: string } }>(response);
  return payload.member.id;
}

export async function roomState(f: Fixture, roomId: string): Promise<RoomPayload> {
  const response = await f.server.handle(get(`/api/playground/rooms/${roomId}`, f.cookie));
  expect(response.status).toBe(200);
  return await readJson<RoomPayload>(response);
}

export function sendMessage(f: Fixture, roomId: string, body: Record<string, unknown>): Promise<Response> {
  return f.server.handle(post(`/api/playground/rooms/${roomId}/messages`, body, f.cookie));
}

export function release(f: Fixture, roomId: string, body: Record<string, unknown>): Promise<Response> {
  return f.server.handle(post(`/api/playground/rooms/${roomId}/releases`, body, f.cookie));
}

/** The room's latest admitted input sequence, which a Release must state. */
export function latestSeq(state: RoomPayload): string {
  return state.room.latest_input_seq;
}

export async function uploadPicture(f: Fixture, roomId: string, shade: number): Promise<string> {
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: shade, g: 5, b: 6 } } })
    .png()
    .toBuffer();
  const response = await f.server.handle(
    post(
      `/api/playground/rooms/${roomId}/assets`,
      { content_base64: png.toString('base64'), mime: 'image/png' },
      f.cookie,
    ),
  );
  expect(response.status).toBe(201);
  return (await readJson<{ asset_id: string }>(response)).asset_id;
}
