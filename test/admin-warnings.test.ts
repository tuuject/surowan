import { expect, test } from 'vitest';
import { ImConnectionRegistry } from '../src/platform/im-connection.ts';
import { WarningService } from '../src/store/warnings.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie } from './admin-fixtures.ts';

test('warnings API lists standing and event warnings, marks read and clears history', async () => {
  const f = await fixture();
  try {
    const setup = await f.server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(setup);
    const call = (path: string, init: RequestInit = {}) =>
      f.server.handle(
        request(`/api${path}`, {
          ...init,
          headers: { cookie, origin: 'http://127.0.0.1:8899', ...init.headers },
        }),
      );

    const empty = await readJson(await call('/warnings'));
    expect(empty).toMatchObject({ standing: [], items: [], next_cursor: null, unread_count: 0 });

    const writer = new WarningService(f.store.orm);
    const created = writer.record({
      code: 'invocation_failure_rate',
      variables: { failed: 51, total: 100, failure_rate: 0.51, threshold: 0.5, sample_size: 100 },
      now: new Date('2026-10-23T12:00:00.000Z'),
    });
    writer.record({
      code: 'invocation_failure_rate',
      variables: { failed: 60, total: 100, failure_rate: 0.6, threshold: 0.5, sample_size: 100 },
      now: new Date('2026-10-23T12:01:00.000Z'),
    });

    const listed = await readJson(await call('/warnings?unread=1&limit=5'));
    expect(listed.unread_count).toBe(1);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: created.id.toString(),
      kind: 'event',
      code: 'invocation_failure_rate',
      category: 'runtime',
      severity: 'critical',
      variables: { failed: 60, total: 100 },
      read_at: null,
    });

    const current = f.configStore.current();
    f.configStore.publish({
      ...current,
      config: {
        ...current.config,
        developer: { ...current.config.developer, record_model_payloads: true },
      },
    });
    const withStanding = await readJson(await call('/warnings'));
    expect(withStanding.standing).toEqual([
      expect.objectContaining({ kind: 'standing', code: 'developer_payload_recording', severity: 'warning' }),
    ]);

    const invalid = await call('/warnings?unknown=1');
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toMatchObject({ error: 'invalid_query' });
    expect((await call('/warnings?limit=0')).status).toBe(400);

    const marked = await call(`/warnings/${created.id.toString()}/read`, { method: 'POST' });
    expect(marked.status).toBe(200);
    expect(await readJson(marked)).toMatchObject({ item: { read_at: expect.any(String) } });
    const afterRead = await readJson(await call('/warnings?unread=1'));
    expect(afterRead).toMatchObject({ items: [], unread_count: 0 });

    const missing = await call('/warnings/999999/read', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect((await call('/warnings', { method: 'POST' })).status).toBe(405);

    const cleared = await call('/warnings', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(await readJson(cleared)).toEqual({ cleared: 1 });
    expect(await readJson(await call('/warnings'))).toMatchObject({ items: [], unread_count: 0 });
    // Standing warnings survive clearing history because they are derived.
    expect((await readJson(await call('/warnings'))).standing).toHaveLength(1);
  } finally {
    await f.server.stop();
    f.store.close();
  }
});

test('Telegram connection states appear and clear as standing warnings', async () => {
  const connections = new ImConnectionRegistry();
  const f = await fixture({ connections });
  try {
    const setup = await f.server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(setup);
    const call = (path: string) =>
      f.server.handle(
        request(`/api${path}`, {
          headers: { cookie, origin: 'http://127.0.0.1:8899' },
        }),
      );
    const telegramWarnings = async (): Promise<Record<string, unknown>[]> =>
      (await readJson(await call('/warnings'))).standing.filter((warning: { code: string }) =>
        warning.code.startsWith('telegram_'),
      );

    // No connection ever opened: disabled, and disabled never warns.
    expect(await telegramWarnings()).toEqual([]);

    connections.set('telegram', { status: 'network_error', since: '2026-10-25T00:00:00.000Z' });
    expect(await telegramWarnings()).toEqual([
      expect.objectContaining({ kind: 'standing', code: 'telegram_network_error', category: 'runtime' }),
    ]);

    for (const reason of ['unauthorized', 'conflict', 'token_unreadable'] as const) {
      connections.set('telegram', {
        status: 'config_error',
        reason,
        since: '2026-10-25T00:00:00.000Z',
      });
      expect(await telegramWarnings()).toEqual([
        expect.objectContaining({
          kind: 'standing',
          code: 'telegram_config_error',
          category: 'runtime',
          variables: { reason },
        }),
      ]);
    }

    connections.set('telegram', {
      status: 'connected',
      since: '2026-10-25T00:00:00.000Z',
      bot: { id: '1', username: 'bot' },
    });
    expect(await telegramWarnings()).toEqual([]);

    connections.set('telegram', { status: 'disabled', since: '2026-10-25T00:00:00.000Z' });
    expect(await telegramWarnings()).toEqual([]);
  } finally {
    await f.server.stop();
    f.store.close();
  }
});
