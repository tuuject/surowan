import { afterAll, describe, expect, test } from 'vitest';
import { cancelAlarm, listAlarms } from '../../src/plugins/alarm/admin.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import type { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { cleanupTestDirectories, ensureConversation, insertAlarm, setup, setupAdmin } from './fixtures.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

const ADMIN_PASSWORD = 'correct-horse-battery';

function adminRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:8899${path}`, init);
}

function adminPost(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return adminRequest(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function adminSessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('Expected a session cookie');
  }
  return header.slice(0, header.indexOf(';'));
}

async function readJson(response: Response): Promise<any> {
  return await response.json();
}

describe('alarm admin', () => {
  test('lists alarms with pending-first ordering and stable cursor pagination', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending1 = insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'pending 1' });
    const pending2 = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'pending 2' });
    const fired = insertAlarm(store, conversation, '2026-08-15T00:30:00.000Z', { state: 'fired', summary: 'fired' });
    store.db
      .prepare('UPDATE task_receipts SET claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?')
      .run('2026-08-15T00:30:00.000Z', '2026-08-15T00:30:00.000Z', '2026-08-15T00:30:00.000Z', fired);

    const first = listAlarms(store.orm, { limit: '2' });
    expect(first.items.map((item) => item.id)).toEqual([pending2.toString(), pending1.toString()]);
    expect(first.next_cursor).not.toBe(null);
    const second = listAlarms(store.orm, { limit: '2', cursor: first.next_cursor });
    expect(second.items.map((item) => item.id)).toEqual([fired.toString()]);
    expect(second.next_cursor).toBe(null);
    store.close();
  });

  test('filters by state, chat, and target and keeps bigint ids as strings', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z', { summary: 'mine', targetUserId: 42n });
    insertAlarm(store, conversation, '2026-08-15T02:00:00.000Z', { summary: 'other', targetUserId: 7n });
    const mine = listAlarms(store.orm, { target: '42' });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.target_user_id).toBe('42');
    expect(mine.items[0]?.chat.message_thread_id).toBe('0');
    expect(mine.items[0]?.conversation_id).toBe(conversation.toString());
    const pending = listAlarms(store.orm, { state: 'pending' });
    expect(pending.items).toHaveLength(2);
    const fired = listAlarms(store.orm, { state: 'fired' });
    expect(fired.items).toHaveLength(0);
    store.close();
  });

  test('atomically cancels only pending alarms and records the admin actor', async () => {
    const { store } = await setup();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    expect(cancelAlarm(new LongTaskService(store.orm), store.orm, pending, 'owner')).toEqual({ status: 'cancelled' });
    const row = store.db
      .prepare<
        [bigint],
        { state: string; cancelled_by: string | null; admin_cancelled: bigint; cancel_reason: string | null }
      >(`SELECT lt.state, tr.cancelled_by, tr.admin_cancelled, tr.cancel_reason
         FROM long_tasks lt JOIN task_receipts tr ON tr.task_id = lt.id WHERE lt.id = ?`)
      .get(pending);
    expect(row).toEqual({
      state: 'cancelled',
      cancelled_by: 'owner',
      admin_cancelled: 1n,
      cancel_reason: 'admin_cancelled',
    });
    expect(() => cancelAlarm(new LongTaskService(store.orm), store.orm, pending, 'owner')).toThrow(
      'Only pending alarms can be cancelled',
    );
    expect(() => cancelAlarm(new LongTaskService(store.orm), store.orm, 999999n, 'owner')).toThrow('does not exist');
    store.close();
  });
});

describe('alarm admin HTTP', () => {
  test('enforces auth/Origin/method and 404/409/wake semantics for alarm routes', async () => {
    const { store, configStore } = await setupAdmin();
    const conversation = ensureConversation(store);
    const pending = insertAlarm(store, conversation, '2026-08-15T01:00:00.000Z');
    let wakeCalls = 0;
    const fakeScheduler = {
      wake: () => {
        wakeCalls += 1;
      },
    };
    const server = new AdminServer({
      store,
      configStore,
      scheduler: fakeScheduler as unknown as BucketScheduler,
    });
    try {
      expect((await server.handle(adminRequest('/api/alarms'))).status).toBe(401);

      const created = await server.handle(
        adminPost('/api/auth/setup', { username: 'owner', password: ADMIN_PASSWORD }),
      );
      const cookie = adminSessionCookie(created);

      const list = await readJson(await server.handle(adminRequest('/api/alarms', { headers: { cookie } })));
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        id: pending.toString(),
        chat: { telegram_chat_id: '123456789', message_thread_id: '0' },
      });

      const method = await server.handle(adminPost('/api/alarms', {}, cookie));
      expect(method.status).toBe(405);

      const missing = await server.handle(
        adminRequest('/api/alarms/999999', { method: 'DELETE', headers: { cookie } }),
      );
      expect(missing.status).toBe(404);
      expect(await readJson(missing)).toMatchObject({ error: 'not_found' });

      const crossOrigin = await server.handle(
        adminRequest(`/api/alarms/${pending}`, {
          method: 'DELETE',
          headers: { cookie, origin: 'http://evil.test' },
        }),
      );
      expect(crossOrigin.status).toBe(403);
      expect(await readJson(crossOrigin)).toMatchObject({ error: 'bad_origin' });

      const cancelled = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(cancelled.status).toBe(200);
      expect(await readJson(cancelled)).toEqual({ status: 'cancelled' });
      expect(wakeCalls).toBe(1);

      const conflict = await server.handle(
        adminRequest(`/api/alarms/${pending}`, { method: 'DELETE', headers: { cookie } }),
      );
      expect(conflict.status).toBe(409);
      expect(await readJson(conflict)).toMatchObject({ error: 'alarm_not_pending' });
    } finally {
      store.close();
    }
  });
});
