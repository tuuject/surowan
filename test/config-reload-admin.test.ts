import { expect, test } from 'vitest';
import { chmod } from 'node:fs/promises';
import { AdminServer } from '../src/ingress/admin/server.ts';
import { readConfigRevision } from '../src/adapters/local-monolith/config-file.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { setup } from './config-reload-fixtures.ts';

test('admin config endpoints apply the file and report status', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.admin = { enabled: true, host: '127.0.0.1', port: 8899, session_ttl_hours: 12 };
    },
  });
  try {
    const server = new AdminServer({
      store: fixture.store,
      configStore: fixture.configStore,
      modelSwitcher: fixture.modelSwitcher,
      configReloader: fixture.reloader,
      secrets: new SecretStore(),
    });
    const call = (path: string, init: RequestInit = {}): Request => new Request(`http://127.0.0.1:8899${path}`, init);
    const json = async (response: Response): Promise<any> => await response.json();

    expect((await server.handle(call('/api/config/status'))).status).toBe(401);
    const created = await server.handle(
      call('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery' }),
      }),
    );
    const cookie = created.headers.get('set-cookie')?.split(';')[0] ?? '';
    const before = await json(await server.handle(call('/api/config/status', { headers: { cookie } })));
    expect(before).toEqual({
      generation: 1,
      active_hash: fixture.configStore.current().hash,
      file_hash: fixture.loaded.hash,
      restart_required: [],
      last_error: null,
    });

    // Cross-origin writes are rejected on both endpoints.
    const crossOrigin = { 'content-type': 'application/json', cookie, origin: 'http://evil.test' };
    const rejectedApply = await server.handle(call('/api/config/apply', { method: 'POST', headers: crossOrigin }));
    expect(rejectedApply.status).toBe(403);
    expect(await json(rejectedApply)).toMatchObject({ error: 'bad_origin' });
    const rejectedModel = await server.handle(
      call('/api/model', {
        method: 'PUT',
        headers: crossOrigin,
        body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
      }),
    );
    expect(rejectedModel.status).toBe(403);

    await fixture.patch((config) => {
      config.agent!.thinking_level = 'high';
    });
    const applied = await json(await server.handle(call('/api/config/apply', { method: 'POST', headers: { cookie } })));
    expect(applied).toMatchObject({
      status: 'applied',
      applied: ['agent.thinking_level'],
      restart_required: [],
      outside_serve: [],
      generation: 2,
    });
    expect(applied.active_hash).toBe(applied.file_hash);

    await fixture.writeText('{ broken');
    const failed = await server.handle(call('/api/config/apply', { method: 'POST', headers: { cookie } }));
    expect(failed.status).toBe(422);
    expect(await json(failed)).toMatchObject({ error: 'config_invalid' });
    const afterFailure = await json(await server.handle(call('/api/config/status', { headers: { cookie } })));
    expect(afterFailure.last_error).toMatchObject({ code: 'config_invalid' });
    expect(afterFailure.generation).toBe(2);

    // Put a valid file back; the failed write above never touched the model.
    await fixture.patch(() => undefined);

    const unknown = await server.handle(
      call('/api/model', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie,
          'if-match': await readConfigRevision(fixture.configPath),
        },
        body: JSON.stringify({ provider: 'ghost', model: 'agent-model' }),
      }),
    );
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ error: 'unknown_provider' });

    const switched = await json(
      await server.handle(
        call('/api/model', {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            cookie,
            'if-match': await readConfigRevision(fixture.configPath),
          },
          body: JSON.stringify({ provider: 'agent', model: 'agent-model' }),
        }),
      ),
    );
    // The switch resets the level to the weakest one `agent-model` has.
    expect(switched.current).toMatchObject({ provider: 'agent', model: 'agent-model', thinking_level: 'off' });
    expect(switched.apply).toEqual({
      applied: ['agent.model', 'agent.provider', 'agent.thinking_level'],
      restart_required: [],
    });

    // There is no default to restore: the request falls through to the 405.
    const removed = await server.handle(call('/api/model', { method: 'DELETE', headers: { cookie } }));
    expect(removed.status).toBe(405);
  } finally {
    fixture.store.close();
  }
});

test('rejects a configuration file that is not 0600 or whose directory is not 0700', async () => {
  if (process.platform === 'win32') {
    return;
  }
  const fixture = await setup();
  const before = fixture.configStore.current();
  try {
    await chmod(fixture.configPath, 0o644);
    const fileResult = await fixture.reloader.reloadFromFile();
    expect(fileResult.ok).toBe(false);
    if (fileResult.ok) {
      throw new Error('Expected the file mode to be rejected');
    }
    expect(fileResult.code).toBe('config_permissions');
    expect(fixture.configStore.current()).toBe(before);

    await chmod(fixture.configPath, 0o600);
    await chmod(fixture.directory, 0o755);
    const directoryResult = await fixture.reloader.reloadFromFile();
    expect(directoryResult.ok).toBe(false);
    if (directoryResult.ok) {
      throw new Error('Expected the directory mode to be rejected');
    }
    expect(directoryResult.code).toBe('config_permissions');
  } finally {
    await chmod(fixture.directory, 0o700).catch(() => undefined);
    await chmod(fixture.configPath, 0o600).catch(() => undefined);
    fixture.store.close();
  }
});

test('a write with a stale revision is refused and leaves the file unchanged', async () => {
  const fixture = await setup();
  try {
    const revision = await readConfigRevision(fixture.configPath);
    const before = await fixture.readText();

    const stale = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      'f'.repeat(64),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      throw new Error('Expected the stale revision to be refused');
    }
    expect(stale.code).toBe('config_conflict');
    expect(await fixture.readText()).toBe(before);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('low');

    const applied = await fixture.reloader.writeAndApply(
      [{ path: ['agent', 'thinking_level'], value: 'high' }],
      revision,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    expect(applied.applied).toEqual(['agent.thinking_level']);
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('high');
    // Leaf edits keep the comments the test configuration was written with.
    expect(await fixture.readText()).toBe(before.replace('"thinking_level": "low"', '"thinking_level": "high"'));
  } finally {
    fixture.store.close();
  }
});
