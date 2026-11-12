import { expect, test } from 'vitest';
import { WarningService } from '../../src/store/warnings.ts';
import { fixture, PASSWORD, post, readJson, request, sessionCookie } from './fixtures.ts';

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
    expect(empty).toMatchObject({
      standing: [],
      items: [],
      total: 0,
      limit: 25,
      offset: 0,
      as_of: '0',
      new_count: 0,
      unread_count: 0,
    });

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

test('warnings API pages one snapshot while new warnings arrive', async () => {
  const f = await fixture();
  try {
    const setup = await f.server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(setup);
    const call = (path: string) =>
      f.server.handle(request(`/api${path}`, { headers: { cookie, origin: 'http://127.0.0.1:8899' } }));
    const writer = new WarningService(f.store.orm);
    const created = writer.record({
      code: 'invocation_failure_rate',
      variables: { failed: 51, total: 100, failure_rate: 0.51, threshold: 0.5, sample_size: 100 },
      now: new Date('2026-10-23T12:00:00.000Z'),
    });

    const snapshot = await readJson(await call('/warnings?limit=1'));
    expect(snapshot).toMatchObject({ total: 1, offset: 0, as_of: created.id.toString(), new_count: 0 });
    const later = writer.record({
      code: 'admin_login_failures',
      variables: { consecutive_failures: 5, threshold: 5, last_failed_at: '2026-10-23T12:02:00.000Z' },
      now: new Date('2026-10-23T12:02:00.000Z'),
    });
    // The newer warning sorts first, yet the snapshot's page keeps its row and
    // total; only `new_count` reports the arrival, filtered like the page.
    const pinned = await readJson(await call(`/warnings?limit=1&as_of=${snapshot.as_of}`));
    expect(pinned.items.map((item: { id: string }) => item.id)).toEqual([created.id.toString()]);
    expect(pinned).toMatchObject({ total: 1, as_of: created.id.toString(), new_count: 1 });
    writer.markRead(later.id);
    expect(await readJson(await call(`/warnings?limit=1&unread=1&as_of=${snapshot.as_of}`))).toMatchObject({
      total: 1,
      new_count: 0,
    });
    const renewed = await readJson(await call('/warnings?limit=1'));
    expect(renewed.items.map((item: { id: string }) => item.id)).toEqual([later.id.toString()]);
    expect(renewed).toMatchObject({ total: 2, as_of: later.id.toString(), new_count: 0 });
    expect(await readJson(await call(`/warnings?limit=1&offset=1&as_of=${renewed.as_of}`))).toMatchObject({
      items: [expect.objectContaining({ id: created.id.toString() })],
      total: 2,
      offset: 1,
    });

    for (const [query, error] of [
      ['as_of=abc', 'invalid_as_of'],
      ['as_of=-1', 'invalid_as_of'],
      ['offset=-1', 'invalid_offset'],
      ['offset=1000000000', 'invalid_offset'],
      ['cursor=1', 'invalid_query'],
    ] as const) {
      const rejected = await call(`/warnings?${query}`);
      expect(rejected.status).toBe(400);
      expect(await readJson(rejected)).toMatchObject({ error });
    }
  } finally {
    await f.server.stop();
    f.store.close();
  }
});
