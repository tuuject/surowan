import { afterAll, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import { cleanupDirectories, post, readJson, request, sessionCookie, tempDirectory } from './helpers.ts';

afterAll(cleanupDirectories);

test('admin panel manages memories with chat filter and long-TTL warnings', async () => {
  const directory = await tempDirectory('surowan-memory-admin-');
  const configPath = join(directory, 'config.jsonc');
  const staticDir = join(directory, 'bundle');
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>admin</title>');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.agent!.memory_ttl_warning_days = 2;
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
  const server = new AdminServer({ store, configStore });
  const PASSWORD = 'correct-horse-battery';
  try {
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hello',
        },
      } satisfies Update,
      received,
    );
    const setup = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(setup);
    const headers = { cookie };

    const unauthenticated = await server.handle(request('/api/memories'));
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'long-lived rule', ttl_seconds: 3 * 86_400 }),
      }),
    );
    expect(created.status).toBe(200);
    const item = await readJson(created);
    expect(item.id).toMatch(/^mem_[a-f0-9]{32}$/);
    expect(item.long_ttl).toBe(true);
    expect(item.expired).toBe(false);
    expect(item.chat).toMatchObject({ telegram_chat_id: '123456789', type: 'private', message_thread_id: 0 });

    const chats = await readJson(await server.handle(request('/api/memories/chats', { headers })));
    expect(chats.items).toContainEqual({ telegram_chat_id: '123456789', type: 'private', title: null, username: null });

    const listed = await readJson(await server.handle(request('/api/memories', { headers })));
    expect(listed.items).toHaveLength(1);
    const longOnly = await readJson(await server.handle(request('/api/memories?state=long_ttl', { headers })));
    expect(longOnly.items).toHaveLength(1);
    const activeOnly = await readJson(await server.handle(request('/api/memories?state=active', { headers })));
    expect(activeOnly.items).toHaveLength(1);

    // Expired rows surface with the expired flag and filter.
    store.db
      .prepare('UPDATE memories SET created_at = ?, expires_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', item.id);
    const expiredOnly = await readJson(await server.handle(request('/api/memories?state=expired', { headers })));
    expect(expiredOnly.items).toHaveLength(1);
    expect(expiredOnly.items[0].expired).toBe(true);
    const nowActive = await readJson(await server.handle(request('/api/memories?state=active', { headers })));
    expect(nowActive.items).toHaveLength(0);

    const filtered = await readJson(await server.handle(request('/api/memories?chat=999', { headers })));
    expect(filtered.items).toHaveLength(0);

    const updated = await server.handle(
      request(`/api/memories/${item.id}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'edited rule', ttl_seconds: 86_400 }),
      }),
    );
    expect(updated.status).toBe(200);
    expect((await readJson(updated)).content).toBe('edited rule');

    const removed = await server.handle(request(`/api/memories/${item.id}`, { method: 'DELETE', headers }));
    expect(removed.status).toBe(200);
    const missing = await server.handle(request(`/api/memories/${item.id}`, { method: 'DELETE', headers }));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });

    // Validation and method guards.
    const longContent = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'x'.repeat(151) }),
      }),
    );
    expect(longContent.status).toBe(400);
    expect(await readJson(longContent)).toMatchObject({ error: 'invalid_content' });
    const unknownChat = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '999', content: 'note' }),
      }),
    );
    expect(unknownChat.status).toBe(404);
    expect(await readJson(unknownChat)).toMatchObject({ error: 'chat_not_found' });
    const badTtl = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '123456789', content: 'note', ttl_seconds: 30 }),
      }),
    );
    expect(badTtl.status).toBe(400);
    expect(await readJson(badTtl)).toMatchObject({ error: 'invalid_ttl_seconds' });
    const badState = await server.handle(request('/api/memories?state=bogus', { headers }));
    expect(badState.status).toBe(400);
    expect(await readJson(badState)).toMatchObject({ error: 'invalid_state' });
    const badCursor = await server.handle(request('/api/memories?cursor=not-a-memory', { headers }));
    expect(badCursor.status).toBe(400);
    expect(await readJson(badCursor)).toMatchObject({ error: 'invalid_cursor' });
    const badId = await server.handle(request('/api/memories/not-an-id', { method: 'DELETE', headers }));
    expect(badId.status).toBe(400);
    expect(await readJson(badId)).toMatchObject({ error: 'invalid_id' });
    const auditWrite = await server.handle(request('/api/invocations', { method: 'PUT', headers, body: '{}' }));
    expect(auditWrite.status).toBe(405);
    const crossOrigin = await server.handle(
      request('/api/memories', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ chat_id: '123456789', content: 'note' }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  } finally {
    store.close();
  }
});
