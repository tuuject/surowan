import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { keychainPath } from '../../src/platform/keychain.ts';
import {
  adminFixture,
  installAdminProviderHooks,
  readJson,
  request,
  revisionOf,
  rewriteFile,
  write,
} from './providers-fixtures.ts';

installAdminProviderHooks();

function model(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'] as const,
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  };
}

async function jarOf(fixture: Awaited<ReturnType<typeof adminFixture>>): Promise<Record<string, { value: string }>> {
  return (
    JSON.parse(await readFile(keychainPath(fixture.configPath), 'utf8')) as {
      entries: Record<string, { value: string }>;
    }
  ).entries;
}

test('two slots of one request cannot silently share an explicit entry name', async () => {
  const fixture = await adminFixture();
  try {
    const provider = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'probe',
        kind: 'custom',
        base_url: 'https://probe.example.test/v1',
        api: 'openai-completions',
        api_key: { value: 'api-secret', name: 'shared' },
        headers: { 'x-a': { value: 'header-secret', name: 'shared' } },
        models: [model('probe-model')],
      },
      await revisionOf(fixture),
    );
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'keychain_exists' });
    // Nothing landed: no provider, no entry.
    expect(fixture.file().providers.probe).toBeUndefined();
    expect(Object.keys(await jarOf(fixture))).not.toContain('shared');
  } finally {
    fixture.store.close();
  }
});

test('an explicit name colliding with another slot of the same request is a conflict', async () => {
  const fixture = await adminFixture();
  try {
    // The api_key takes the automatic name `probe`; the header asks for it explicitly.
    const provider = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'probe',
        kind: 'custom',
        base_url: 'https://probe.example.test/v1',
        api: 'openai-completions',
        api_key: 'api-secret',
        headers: { 'x-a': { value: 'header-secret', name: 'probe' } },
        models: [model('probe-model')],
      },
      await revisionOf(fixture),
    );
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'keychain_exists' });
    expect(fixture.file().providers.probe).toBeUndefined();
  } finally {
    fixture.store.close();
  }
});

test('a shared entry is not rotated in place: one use repoints, the other keeps the value', async () => {
  const fixture = await adminFixture();
  try {
    await write(
      fixture,
      '/api/keychain',
      'POST',
      { name: 'shared', value: 'shared-secret' },
      await revisionOf(fixture),
    );
    await rewriteFile(fixture, (config) => {
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.api_key = { jar: 'shared' };
      }
      const vision = config.providers.vision;
      if (vision?.kind === 'custom') {
        vision.api_key = { jar: 'shared' };
      }
    });
    const response = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { api_key: 'agent-new-secret' },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    // Only the agent provider repoints (derived from its own suggested name
    // , taken, hence ); vision keeps the shared entry.
    expect(fixture.file().providers.agent).toMatchObject({ api_key: { jar: 'agent-2' } });
    expect(fixture.file().providers.vision).toMatchObject({ api_key: { jar: 'shared' } });
    const entries = await jarOf(fixture);
    expect(entries.shared?.value).toBe('shared-secret');
    expect(entries['agent-2']?.value).toBe('agent-new-secret');
  } finally {
    fixture.store.close();
  }
});

test('an exclusive entry with a non-derived name rotates in place', async () => {
  const fixture = await adminFixture();
  try {
    await write(
      fixture,
      '/api/keychain',
      'POST',
      { name: 'my-own-name', value: 'old-secret' },
      await revisionOf(fixture),
    );
    await rewriteFile(fixture, (config) => {
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.api_key = { jar: 'my-own-name' };
      }
    });
    const response = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { api_key: 'rotated-secret' },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    expect(fixture.file().providers.agent).toMatchObject({ api_key: { jar: 'my-own-name' } });
    expect((await jarOf(fixture))['my-own-name']?.value).toBe('rotated-secret');
  } finally {
    fixture.store.close();
  }
});

test('a stale revision refuses a replace-only write and the entry value is unchanged', async () => {
  const fixture = await adminFixture();
  try {
    const revision = await revisionOf(fixture);
    // The file changes after the revision was read.
    await rewriteFile(fixture, (config) => {
      config.timezone = 'Asia/Shanghai';
    });
    const response = await write(fixture, '/api/providers/agent', 'PUT', { api_key: 'rotated' }, revision);
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: 'config_conflict' });
    expect((await jarOf(fixture)).agent?.value).toBe('agent-secret');
    expect(fixture.file().providers.agent).toMatchObject({ api_key: { jar: 'agent' } });
  } finally {
    fixture.store.close();
  }
});

test('a dangling reference is repaired by re-entering the key', async () => {
  const fixture = await adminFixture();
  try {
    // The file points at an entry the keychain does not have.
    await rewriteFile(fixture, (config) => {
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.api_key = { jar: 'missing-entry' };
      }
    });
    const response = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { api_key: 'repair-secret' },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    // The reference stays and the entry now exists with the submitted value.
    expect(fixture.file().providers.agent).toMatchObject({ api_key: { jar: 'missing-entry' } });
    expect((await jarOf(fixture))['missing-entry']?.value).toBe('repair-secret');
  } finally {
    fixture.store.close();
  }
});

test('an entry the running configuration still uses is not an orphan', async () => {
  const fixture = await adminFixture();
  try {
    // The startup config references `agent`; the file edit is never applied.
    await rewriteFile(fixture, (config) => {
      const agent = config.providers.agent;
      if (agent?.kind === 'custom') {
        agent.api_key = { jar: 'vision' };
      }
    });
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { usage: { file: Record<string, string[]> | null; active: string[] } };
    expect(view.usage.file?.agent).toBeUndefined();
    expect(view.usage.active).toContain('agent');

    const purge = await write(fixture, '/api/keychain/purge', 'POST', { names: ['agent'] }, await revisionOf(fixture));
    expect(purge.status).toBe(200);
    expect(await readJson(purge)).toEqual({ deleted: [], skipped: ['agent'] });

    const removed = await fixture.server.handle(
      request('/api/keychain/agent', {
        method: 'DELETE',
        headers: { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' },
      }),
    );
    expect(removed.status).toBe(409);
    expect(await readJson(removed)).toMatchObject({ error: 'keychain_in_use' });
  } finally {
    fixture.store.close();
  }
});

test('entry names that are Object.prototype keys survive the manager and a provider use', async () => {
  const fixture = await adminFixture();
  try {
    const headers = { cookie: fixture.cookie, origin: 'http://127.0.0.1:8899' };
    const created = await fixture.server.handle(
      request('/api/keychain', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '__proto__', value: 'proto-secret' }),
      }),
    );
    expect(created.status).toBe(201);
    const view = (await readJson(
      await fixture.server.handle(request('/api/keychain', { headers: { cookie: fixture.cookie } })),
    )) as { entries: { name: string }[]; usage: { file: Record<string, string[]> | null } };
    expect(view.entries.map((entry) => entry.name)).toContain('__proto__');
    // The raw file does not reference it, and a plain-object lookup must not
    // read the prototype instead of the (absent) own key.
    expect(Object.hasOwn(view.usage.file ?? {}, '__proto__')).toBe(false);

    // Reusing it as a provider key lands the reference in the file.
    const provider = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'probe',
        kind: 'custom',
        base_url: 'https://probe.example.test/v1',
        api: 'openai-completions',
        api_key: { entry: '__proto__' },
        models: [model('probe-model')],
      },
      await revisionOf(fixture),
    );
    expect(provider.status).toBe(200);
    expect(fixture.file().providers.probe).toMatchObject({ api_key: { jar: '__proto__' } });

    // Deleting it again works.
    const deleted = await fixture.server.handle(request('/api/keychain/__proto__', { method: 'DELETE', headers }));
    expect(deleted.status).toBe(409); // still used by the new provider
  } finally {
    fixture.store.close();
  }
});
