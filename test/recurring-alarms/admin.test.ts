import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { CronerScheduleEngine } from '../../src/adapters/local-monolith/recurring-schedule.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { RecurringAlarmService } from '../../src/store/recurring-alarms/index.ts';
import {
  bearer,
  createKey,
  installAdminApiKeyHooks,
  post,
  readJson,
  request,
  setupAdmin,
} from '../admin/api-keys-fixtures.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

installAdminApiKeyHooks();

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const DRAFT = {
  title: 'Morning greeting',
  prompt: 'Say good morning.',
  rules: ['0 8 * * *'],
  input_mode: 'builder',
  time_zone: 'Asia/Shanghai',
  enabled: true,
};

async function adminFixture(options: { wired?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-recurring-admin-'));
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
      config.telegram.chats.push({ id: -100500, topic_ids: [7] });
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  const at = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES
       (1, 123456789, 123456789, 'private', 'Owner', ?), (2, -100500, -100500, 'supergroup', 'Forum', ?)`,
    )
    .run(at, at);
  store.db
    .prepare('INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, ?, ?)')
    .run(at, at);
  const tasks = new LongTaskService(store.orm);
  const recurring = new RecurringAlarmService({
    store,
    engine: new CronerScheduleEngine(),
    tasks,
    config: () => configStore.current().config,
  });
  const server = new AdminServer({
    store,
    configStore,
    secrets: new SecretStore(),
    tasks,
    ...(options.wired === false ? {} : { recurringAlarms: recurring }),
  });
  const cookie = await setupAdmin(server);
  return { store, server, cookie };
}

function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Request {
  return request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('recurring alarm admin API', () => {
  test('targets, preview, create, edit, run and delete through a panel session', async () => {
    const { store, server, cookie } = await adminFixture();
    const auth = { cookie };

    const targets = await readJson(await server.handle(request('/api/recurring-alarms/targets', { headers: auth })));
    expect(targets.items).toEqual([
      expect.objectContaining({ chat_id: '1', message_thread_id: '0', conversation_id: '1', available: true }),
      expect.objectContaining({ chat_id: '2', message_thread_id: '7', conversation_id: null, available: true }),
    ]);

    const preview = await readJson(
      await server.handle(post('/api/recurring-alarms/preview', { rules: ['*/2 * * * *'], time_zone: 'UTC' }, auth)),
    );
    expect(preview).toMatchObject({ issues: [], time_zone: 'UTC', short_interval: true });
    expect(preview.next).toHaveLength(5);
    const badPreview = await readJson(
      await server.handle(post('/api/recurring-alarms/preview', { rules: ['0 8 L * *'], time_zone: 'UTC' }, auth)),
    );
    expect(badPreview).toMatchObject({ next: [], issues: [{ index: 0, code: 'unsupported' }] });

    const invalid = await server.handle(
      post('/api/recurring-alarms', { ...DRAFT, rules: ['0 0 8 * * *'], chat_id: '1', message_thread_id: '0' }, auth),
    );
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toMatchObject({ error: 'invalid_rules', issues: [{ index: 0, code: 'syntax' }] });
    // A refused draft for a Topic nobody wrote in leaves no Conversation behind.
    const refusedTopic = await server.handle(
      post('/api/recurring-alarms', { ...DRAFT, title: '', chat_id: '2', message_thread_id: '7' }, auth),
    );
    expect(refusedTopic.status).toBe(400);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE chat_id = 2').get()).toEqual({ n: 0n });
    const outside = await server.handle(
      post('/api/recurring-alarms', { ...DRAFT, chat_id: '2', message_thread_id: '8' }, auth),
    );
    expect(outside.status).toBe(409);
    expect(await readJson(outside)).toMatchObject({ error: 'target_unavailable' });

    const topic = await readJson(
      await server.handle(post('/api/recurring-alarms', { ...DRAFT, chat_id: '2', message_thread_id: '7' }, auth)),
    );
    expect(topic.target).toMatchObject({ chat_id: '2', message_thread_id: '7', telegram_chat_id: '-100500' });
    const created = await readJson(
      await server.handle(post('/api/recurring-alarms', { ...DRAFT, chat_id: '1', message_thread_id: '0' }, auth)),
    );
    expect(created).toMatchObject({
      revision: '1',
      rules: ['0 8 * * *'],
      input_mode: 'builder',
      time_zone: 'Asia/Shanghai',
      enabled: true,
      created_by: 'owner',
      last_firing: null,
      target: { conversation_id: '1', chat_id: '1', host_kind: 'telegram' },
    });
    expect(created.next_fire_at).toMatch(/T00:00:00\.000Z$/);

    const listed = await readJson(
      await server.handle(request('/api/recurring-alarms?chat=123456789', { headers: auth })),
    );
    expect(listed).toMatchObject({ total: 1, items: [{ id: created.id }] });

    const path = `/api/recurring-alarms/${created.id}`;
    expect((await server.handle(send('PUT', path, auth, DRAFT))).status).toBe(400);
    const stale = await server.handle(send('PUT', path, { ...auth, 'if-match': '7' }, DRAFT));
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'revision_conflict' });
    const disabled = await readJson(
      await server.handle(send('PUT', path, { ...auth, 'if-match': '1' }, { ...DRAFT, enabled: false })),
    );
    expect(disabled).toMatchObject({ revision: '2', enabled: false, next_fire_at: null });

    const run = await server.handle(post(`${path}/run`, {}, auth));
    expect(run.status).toBe(200);
    const ran = await readJson(run);
    expect(ran).toMatchObject({ firing_id: expect.any(String), task_id: expect.any(String) });
    const again = await server.handle(post(`${path}/run`, {}, auth));
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({ error: 'previous_pending' });

    const detail = await readJson(await server.handle(request(path, { headers: auth })));
    expect(detail.firings).toEqual([
      expect.objectContaining({ source: 'manual', outcome: 'scheduled', triggered_by: 'owner', task_id: ran.task_id }),
    ]);
    expect(detail.last_firing).toMatchObject({ source: 'manual' });

    expect(await readJson(await server.handle(send('DELETE', path, auth)))).toEqual({ status: 'deleted' });
    expect((await server.handle(request(path, { headers: auth }))).status).toBe(404);
    expect((await server.handle(post(`${path}/run`, {}, auth))).status).toBe(404);
  });

  test('API keys need write and paid grants to save or run, and cross-origin writes are refused (F13)', async () => {
    const { server, cookie } = await adminFixture();
    const body = { ...DRAFT, chat_id: '1', message_thread_id: '0' };
    const keys = {
      read: bearer((await createKey(server, cookie, 'reader', 'read')).key),
      write: bearer((await createKey(server, cookie, 'writer', 'read_write')).key),
      paid: bearer((await createKey(server, cookie, 'payer', 'read_paid')).key),
      all: bearer((await createKey(server, cookie, 'owner-key', 'all')).key),
    };
    expect((await server.handle(request('/api/recurring-alarms', { headers: keys.read }))).status).toBe(200);
    expect((await server.handle(request('/api/recurring-alarms/targets', { headers: keys.read }))).status).toBe(200);
    expect(
      (
        await server.handle(
          post('/api/recurring-alarms/preview', { rules: ['0 8 * * *'], time_zone: 'UTC' }, keys.read),
        )
      ).status,
    ).toBe(200);
    for (const key of [keys.read, keys.write, keys.paid]) {
      expect((await server.handle(post('/api/recurring-alarms', body, key))).status).toBe(403);
    }
    const created = await server.handle(post('/api/recurring-alarms', body, keys.all));
    expect(created.status).toBe(200);
    const { id } = await readJson(created);
    expect(
      (await readJson(await server.handle(request(`/api/recurring-alarms/${id}`, { headers: keys.read })))).created_by,
    ).toMatch(/^api-key:\d+$/);
    for (const key of [keys.read, keys.write, keys.paid]) {
      expect((await server.handle(post(`/api/recurring-alarms/${id}/run`, {}, key))).status).toBe(403);
      expect(
        (await server.handle(send('PUT', `/api/recurring-alarms/${id}`, { ...key, 'if-match': '1' }, DRAFT))).status,
      ).toBe(403);
    }
    expect((await server.handle(post(`/api/recurring-alarms/${id}/run`, {}, keys.all))).status).toBe(200);

    const crossOrigin = await server.handle(
      post('/api/recurring-alarms', body, { cookie, origin: 'https://evil.example' }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

    expect((await server.handle(send('DELETE', `/api/recurring-alarms/${id}`, keys.read))).status).toBe(403);
    expect((await server.handle(send('DELETE', `/api/recurring-alarms/${id}`, keys.write))).status).toBe(200);
  });

  test('a panel without the recurring alarm service answers 503', async () => {
    const { server, cookie } = await adminFixture({ wired: false });
    const response = await server.handle(request('/api/recurring-alarms', { headers: { cookie } }));
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: 'recurring_alarms_unavailable' });
  });
});
