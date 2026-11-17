import { expect, test } from 'vitest';
import {
  adminFixture,
  type Fixture,
  installAdminProviderHooks,
  readJson,
  request,
  revisionOf,
  write,
} from './providers-fixtures.ts';

installAdminProviderHooks();

/** A bearer API key with write permission, obtained through the panel session. */
async function bearerKey(fixture: Fixture, mode = 'read_write'): Promise<Record<string, string>> {
  const created = await write(fixture, '/api/api-keys', 'POST', { name: 'caller', mode }, await revisionOf(fixture));
  expect(created.status).toBe(200);
  const body = (await readJson(created)) as { key: string };
  return { authorization: `Bearer ${body.key}` };
}

/** The same write, but authorized with a bearer key instead of the session. */
function bearerWrite(
  fixture: Fixture,
  path: string,
  method: string,
  body: unknown,
  auth: Record<string, string>,
  revision: string | null = null,
): Promise<Response> {
  return fixture.server.handle(
    request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...auth,
        ...(revision === null ? {} : { 'if-match': revision }),
      },
      body: JSON.stringify(body),
    }),
  );
}

const SESSION = (fixture: Fixture): Record<string, string> => ({
  cookie: fixture.cookie,
  origin: 'http://127.0.0.1:8899',
});

test('a programmatic credential cannot reference an existing entry anywhere', async () => {
  const fixture = await adminFixture();
  try {
    const auth = await bearerKey(fixture);
    const revision = await revisionOf(fixture);
    // A new provider whose key is a reused entry.
    const provider = await bearerWrite(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'probe',
        kind: 'custom',
        base_url: 'https://probe.example.test/v1',
        api: 'openai-completions',
        api_key: { entry: 'agent' },
        models: [
          {
            id: 'probe-model',
            name: 'Probe',
            reasoning: false,
            input: ['text'],
            context_window: 128_000,
            max_tokens: 8_192,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      },
      auth,
      revision,
    );
    expect(provider.status).toBe(403);
    expect(await readJson(provider)).toMatchObject({ error: 'entry_not_allowed' });
    // The same request through a panel session goes through.
    const sessionProvider = await write(
      fixture,
      '/api/providers',
      'POST',
      {
        alias: 'probe',
        kind: 'custom',
        base_url: 'https://probe.example.test/v1',
        api: 'openai-completions',
        api_key: { entry: 'agent' },
        models: [
          {
            id: 'probe-model',
            name: 'Probe',
            reasoning: false,
            input: ['text'],
            context_window: 128_000,
            max_tokens: 8_192,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      },
      await revisionOf(fixture),
    );
    expect(sessionProvider.status).toBe(200);
    expect(fixture.file().providers.probe?.api_key).toEqual({ jar: 'agent' });
    // The file never names a plaintext.
    expect(await fixture.read()).not.toContain('agent-secret');
    void auth;
  } finally {
    fixture.store.close();
  }
});

test('a programmatic credential must re-enter the key when it moves an address', async () => {
  const fixture = await adminFixture();
  try {
    const auth = await bearerKey(fixture);
    const moved = await bearerWrite(
      fixture,
      '/api/providers/agent',
      'PUT',
      { base_url: 'https://attacker.example.test/v1' },
      auth,
      await revisionOf(fixture),
    );
    expect(moved.status).toBe(400);
    expect(await readJson(moved)).toMatchObject({ error: 'credentials_required' });
    expect(fixture.file().providers.agent).toMatchObject({ base_url: 'https://example.test/v1' });

    // A panel session is the admin: the move goes through and keeps the key.
    const sessionMove = await write(
      fixture,
      '/api/providers/agent',
      'PUT',
      { base_url: 'https://moved.example.test/v1' },
      await revisionOf(fixture),
    );
    expect(sessionMove.status).toBe(200);
    expect(fixture.file().providers.agent).toMatchObject({ base_url: 'https://moved.example.test/v1' });
    expect(fixture.secret(fixture.file().providers.agent?.api_key)).toBe('agent-secret');
    void auth;
  } finally {
    fixture.store.close();
  }
});

test('a programmatic credential cannot move a search endpoint while keeping its key', async () => {
  const fixture = await adminFixture();
  try {
    const auth = await bearerKey(fixture);
    // The session sets the engine up with its own entry.
    const revision = await revisionOf(fixture);
    const created = await write(
      fixture,
      '/api/search/config',
      'PUT',
      {
        enabled: true,
        url_filters: [],
        engines: [
          {
            id: 'main',
            provider: 'tavily',
            endpoint: null,
            results: null,
            timeout_seconds: null,
            note: null,
            api_key: 'tvly-original',
            enabled: true,
          },
        ],
      },
      revision,
    );
    expect(created.status).toBe(200);
    const moved = await bearerWrite(
      fixture,
      '/api/search/config',
      'PUT',
      {
        enabled: true,
        url_filters: [],
        engines: [
          {
            id: 'main',
            provider: 'tavily',
            endpoint: 'https://attacker.example.test/search',
            results: null,
            timeout_seconds: null,
            note: null,
            keep_api_key: true,
            enabled: true,
          },
        ],
      },
      auth,
      await revisionOf(fixture),
    );
    expect(moved.status).toBe(400);
    const movedBody = await readJson(moved);
    expect(movedBody).toMatchObject({ error: 'search_invalid' });
    expect(movedBody.message).toContain('changed its endpoint');
    // The stored key was never sent anywhere: the endpoint stays the default.
    expect(fixture.file().web_search?.engines?.[0]).toMatchObject({
      provider: 'tavily',
      endpoint: 'https://api.tavily.com/search',
      api_key: fixture.file().web_search?.engines?.[0]?.api_key,
    });
    void auth;
  } finally {
    fixture.store.close();
  }
});

test('a panel session may move a search endpoint and keep the key', async () => {
  const fixture = await adminFixture();
  try {
    const revision = await revisionOf(fixture);
    const created = await write(
      fixture,
      '/api/search/config',
      'PUT',
      {
        enabled: true,
        url_filters: [],
        engines: [
          {
            id: 'main',
            provider: 'tavily',
            endpoint: null,
            results: null,
            timeout_seconds: null,
            note: null,
            api_key: 'tvly-original',
            enabled: true,
          },
        ],
      },
      revision,
    );
    expect(created.status).toBe(200);
    const moved = await write(
      fixture,
      '/api/search/config',
      'PUT',
      {
        enabled: true,
        url_filters: [],
        engines: [
          {
            id: 'main',
            provider: 'tavily',
            endpoint: 'https://mirror.example.test/search',
            results: null,
            timeout_seconds: null,
            note: null,
            keep_api_key: true,
            enabled: true,
          },
        ],
      },
      await revisionOf(fixture),
    );
    expect(moved.status).toBe(200);
    expect(fixture.file().web_search?.engines?.[0]).toMatchObject({
      provider: 'tavily',
      endpoint: 'https://mirror.example.test/search',
    });
  } finally {
    fixture.store.close();
  }
});

test('panel sessions see where each secret comes from; programmatic callers do not', async () => {
  const fixture = await adminFixture();
  try {
    const auth = await bearerKey(fixture);
    const sessionView = (await readJson(
      await fixture.server.handle(request('/api/providers', { headers: SESSION(fixture) })),
    )) as {
      providers: { alias: string; api_key_source?: unknown; header_sources?: unknown }[];
    };
    const agent = sessionView.providers.find((provider) => provider.alias === 'agent');
    expect(agent?.api_key_source).toEqual({ kind: 'entry', name: 'agent' });
    expect(agent?.header_sources).toEqual({ 'x-route': { kind: 'entry', name: 'header' } });

    const bearerView = (await readJson(await fixture.server.handle(request('/api/providers', { headers: auth })))) as {
      providers: { alias: string; api_key_source?: unknown; header_sources?: unknown }[];
    };
    const bearerAgent = bearerView.providers.find((provider) => provider.alias === 'agent');
    expect(bearerAgent?.api_key_source).toBeUndefined();
    expect(bearerAgent?.header_sources).toBeUndefined();

    const sessionTelegram = (await readJson(
      await fixture.server.handle(request('/api/telegram', { headers: SESSION(fixture) })),
    )) as { token_configured: boolean; token_source?: unknown };
    expect(sessionTelegram.token_configured).toBe(true);
    expect(sessionTelegram.token_source).toEqual({ kind: 'entry', name: 'telegram' });
    const bearerTelegram = (await readJson(
      await fixture.server.handle(request('/api/telegram', { headers: auth })),
    )) as { token_source?: unknown };
    expect(bearerTelegram.token_source).toBeUndefined();

    const sessionSearch = (await readJson(
      await fixture.server.handle(request('/api/search/config', { headers: SESSION(fixture) })),
    )) as { engines: { key_source?: unknown }[] };
    expect(sessionSearch.engines).toEqual([]);
    const sessionImage = (await readJson(
      await fixture.server.handle(request('/api/image/config', { headers: SESSION(fixture) })),
    )) as { credential_key_sources?: unknown };
    expect(sessionImage.credential_key_sources).toEqual({});
    const bearerImage = (await readJson(
      await fixture.server.handle(request('/api/image/config', { headers: auth })),
    )) as { credential_key_sources?: unknown };
    expect(bearerImage.credential_key_sources).toBeUndefined();
  } finally {
    fixture.store.close();
  }
});
