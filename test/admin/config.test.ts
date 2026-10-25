/**
 * Admin config surface: bind host loading, the admin whitelist and the
 * agent model switch, all hot-applied through the config file.
 */
import { expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { readConfigRevision } from '../../src/adapters/local-monolith/config/file.ts';
import { ConfigReloader } from '../../src/adapters/local-monolith/config/reload.ts';
import { AdminServer } from '../../src/ingress/admin/index.ts';
import { AgentModelSwitcher } from '../../src/platform/models/switch.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { directories, fixture, PASSWORD, post, readJson, request, sessionCookie } from './fixtures.ts';

test('admin config accepts a non-loopback bind host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-host-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '0.0.0.0',
        port: 8899,
        session_ttl_hours: 12,
      };
    }),
  );
  // The operator owns the bind address, so a non-loopback host must load for
  // LAN/desktop deployments.
  await expect(loadConfig(configPath)).resolves.toMatchObject({
    config: { admin: { host: '0.0.0.0', port: 8899 } },
  });
});

test('admins API manages the config whitelist and hot-applies it', async () => {
  const { store, loaded, configStore, directory } = await fixture();
  const configPath = join(directory, 'config.jsonc');
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: new AgentModelSwitcher(configStore),
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, configReloader });
  try {
    const unauthenticated = await server.handle(request('/api/admins'));
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    let revision = await readConfigRevision(configPath);
    const write = (path: string, method: string, body?: unknown): Request => {
      const headers: Record<string, string> = { cookie, 'if-match': revision };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      return request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };

    const initial = await readJson(await server.handle(request('/api/admins', { headers: { cookie } })));
    expect(initial.items).toEqual([{ telegram_user_id: '7' }, { telegram_user_id: '42' }]);

    const withoutRevision = await server.handle(
      request('/api/admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ telegram_user_id: 99 }),
      }),
    );
    expect(withoutRevision.status).toBe(400);
    expect(await readJson(withoutRevision)).toMatchObject({ error: 'revision_required' });

    const stale = await server.handle(
      request('/api/admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'if-match': 'stale' },
        body: JSON.stringify({ telegram_user_id: 99 }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });

    const invalid = await server.handle(write('/api/admins', 'POST', { telegram_user_id: -5 }));
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toMatchObject({ error: 'invalid_telegram_user_id' });

    const added = await readJson(await server.handle(write('/api/admins', 'POST', { telegram_user_id: 99 })));
    expect(added.items.map((item: { telegram_user_id: string }) => item.telegram_user_id)).toEqual(['7', '42', '99']);
    expect(added.apply.applied).toContain('telegram.admins');
    // Hot: the running configuration — and thus the command gate — already sees 99.
    expect(configStore.current().config.telegram.admins).toEqual([7, 42, 99]);
    // The file is the source of truth across restarts.
    expect((await loadConfig(configPath)).config.telegram.admins).toEqual([7, 42, 99]);

    revision = added.revision;
    const idempotent = await readJson(await server.handle(write('/api/admins', 'POST', { telegram_user_id: 99 })));
    expect(idempotent.items).toEqual(added.items);
    expect(idempotent.apply.applied).toEqual([]);

    const removed = await readJson(await server.handle(write('/api/admins/99', 'DELETE')));
    expect(removed.items.map((item: { telegram_user_id: string }) => item.telegram_user_id)).toEqual(['7', '42']);
    expect(configStore.current().config.telegram.admins).toEqual([7, 42]);
    revision = removed.revision;

    const missing = await server.handle(write('/api/admins/55', 'DELETE'));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toMatchObject({ error: 'not_found' });
  } finally {
    store.close();
  }
});

test('model API lists and switches the agent model through the config file', async () => {
  const { store, loaded, configStore, directory } = await fixture();
  const configPath = join(directory, 'config.jsonc');
  const switcher = new AgentModelSwitcher(configStore);
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher: switcher,
    secrets: new SecretStore(),
    validateAgentModel: () => undefined,
    onPublished: () => undefined,
  });
  const server = new AdminServer({ store, configStore, modelSwitcher: switcher, configReloader });
  try {
    const unauthenticated = await server.handle(
      request('/api/model', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const created = await server.handle(post('/api/auth/setup', { username: 'owner', password: PASSWORD }));
    const cookie = sessionCookie(created);
    // The panel takes the revision from `GET /providers`; this test reads it the
    // same way the server computes it.
    const revision = await readConfigRevision(configPath);
    const call = (init: RequestInit = {}): Request =>
      request('/api/model', { ...init, headers: { ...init.headers, cookie } });
    const switchModel = (body: unknown): Request =>
      call({
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': revision },
        body: JSON.stringify(body),
      });

    // `GET /model` is gone with the Model page; the read now falls through to the
    // read-only audit branch.
    const removedGet = await server.handle(call());
    expect(removedGet.status).toBe(404);

    const withoutRevision = await server.handle(
      call({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'vision', model: 'vision-model' }),
      }),
    );
    expect(withoutRevision.status).toBe(400);
    expect(await readJson(withoutRevision)).toMatchObject({ error: 'revision_required' });

    const switched = await readJson(await server.handle(switchModel({ provider: 'vision', model: 'vision-model' })));
    // The vision model does not reason, so the switch resets the level to `off`.
    expect(switched.current).toMatchObject({
      provider: 'vision',
      model: 'vision-model',
      max_tokens: 8_192,
      thinking_level: 'off',
    });
    expect(switched.apply).toEqual({
      applied: ['agent.model', 'agent.provider', 'agent.thinking_level'],
      restart_required: [],
    });

    const malformed = await server.handle(switchModel({ provider: 'vision' }));
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: 'invalid_model_reference' });

    const unknownProvider = await server.handle(switchModel({ provider: 'ghost', model: 'agent-model' }));
    expect(unknownProvider.status).toBe(400);
    expect(await readJson(unknownProvider)).toMatchObject({ error: 'unknown_provider' });

    const unknownModel = await server.handle(switchModel({ provider: 'agent', model: 'ghost-model' }));
    expect(unknownModel.status).toBe(400);
    expect(await readJson(unknownModel)).toMatchObject({ error: 'unknown_model' });

    // The failed switches must not change the effective model.
    expect(switcher.current()).toMatchObject({ provider: 'vision', model: 'vision-model' });
    expect(configStore.current().config.agent).toMatchObject({ provider: 'vision', model: 'vision-model' });

    // There is no default to restore: the request falls through to the read-only 405.
    const removed = await server.handle(call({ method: 'DELETE' }));
    expect(removed.status).toBe(405);
  } finally {
    store.close();
  }
});
