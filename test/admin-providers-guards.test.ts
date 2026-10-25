import { expect, test } from 'vitest';
import {
  adminFixture,
  call,
  installAdminProviderHooks,
  model,
  readJson,
  request,
  revisionOf,
  write,
} from './admin-providers-fixtures.ts';

installAdminProviderHooks();

test('protects the providers and models that are in use', async () => {
  const fixture = await adminFixture();
  try {
    const provider = await write(fixture, '/api/providers/agent', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });

    const inUseModel = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(inUseModel.status).toBe(409);
    expect(await readJson(inUseModel)).toMatchObject({ error: 'model_in_use' });

    const added = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(added.status).toBe(200);
    expect(await readJson(added)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });

    const duplicate = await write(
      fixture,
      '/api/providers/agent/models',
      'POST',
      { models: [model('agent-extra')] },
      await revisionOf(fixture),
    );
    expect(duplicate.status).toBe(409);
    expect(await readJson(duplicate)).toMatchObject({ error: 'model_exists' });

    const replaced = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('agent-model', { reasoning: true, context_window: 300_000 }),
      await revisionOf(fixture),
    );
    expect(replaced.status).toBe(200);
    expect(await readJson(replaced)).toMatchObject({
      apply: { applied: ['providers.agent.models[agent-model]'], restart_required: [] },
    });
    expect(fixture.configStore.current().models.getModel('agent', 'agent-model')?.contextWindow).toBe(300_000);

    const mismatch = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      model('other-model'),
      await revisionOf(fixture),
    );
    expect(mismatch.status).toBe(400);
    expect(await readJson(mismatch)).toMatchObject({ error: 'invalid_model_id' });

    const removed = await write(
      fixture,
      '/api/providers/agent/models/agent-extra',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ apply: { applied: ['providers.agent.models[agent-extra]'] } });
  } finally {
    fixture.store.close();
  }
});

test('protects a provider and model used only by a Chat override', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent;
      if (provider === undefined) {
        throw new Error('Missing fixture provider');
      }
      config.providers.chat = { ...provider, models: [model('chat-only')] };
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'chat', model: 'chat-only', thinking_level: 'off' });
    },
  });
  try {
    const before = await fixture.read();
    const snapshot = fixture.configStore.current();
    const provider = await write(fixture, '/api/providers/chat', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });
    const selected = await write(
      fixture,
      '/api/providers/chat/models/chat-only',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(selected.status).toBe(409);
    expect(await readJson(selected)).toMatchObject({ error: 'model_in_use' });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(snapshot);
  } finally {
    fixture.store.close();
  }
});

test('protects a provider and model still used by a running Chat pending removal', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const provider = config.providers.agent;
      if (provider === undefined) {
        throw new Error('Missing fixture provider');
      }
      config.providers.chat = { ...provider, models: [model('chat-only')] };
      config.telegram.chats.push({ id: -999, provider: 'chat', model: 'chat-only', thinking_level: 'off' });
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/chats'));
    const removed = await write(fixture, '/api/chats/-999', 'DELETE', null, view.revision as string);
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toMatchObject({ apply: { restart_required: ['telegram.chats[-999]'] } });
    expect(fixture.configStore.current().config.telegram.chats.some((chat) => chat.id === -999)).toBe(true);

    const before = await fixture.read();
    const snapshot = fixture.configStore.current();
    const provider = await write(fixture, '/api/providers/chat', 'DELETE', {}, await revisionOf(fixture));
    expect(provider.status).toBe(409);
    expect(await readJson(provider)).toMatchObject({ error: 'provider_in_use' });
    const selected = await write(
      fixture,
      '/api/providers/chat/models/chat-only',
      'DELETE',
      {},
      await revisionOf(fixture),
    );
    expect(selected.status).toBe(409);
    expect(await readJson(selected)).toMatchObject({ error: 'model_in_use' });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(snapshot);
  } finally {
    fixture.store.close();
  }
});

test('global Admin writes preserve Chat overrides and reject incompatible inherited thinking', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.agent!.thinking_level = 'off';
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'vision', model: 'vision-model' });
      config.telegram.chats.push({ id: -999, provider: 'agent', model: 'agent-model', thinking_level: 'high' });
    },
  });
  try {
    const original = await fixture.read();
    const before = fixture.configStore.current();
    const rejected = await write(
      fixture,
      '/api/thinking-level',
      'PUT',
      { thinking_level: 'low' },
      await revisionOf(fixture),
    );
    expect(rejected.status).toBe(422);
    expect(await readJson(rejected)).toMatchObject({
      error: 'config_invalid',
      message: expect.stringContaining('chat 123456789.thinking_level low is not supported'),
    });
    expect(await fixture.read()).toBe(original);
    expect(fixture.configStore.current()).toBe(before);

    const switched = await write(
      fixture,
      '/api/model',
      'PUT',
      { provider: 'vision', model: 'vision-model' },
      await revisionOf(fixture),
    );
    expect(switched.status).toBe(200);
    expect(fixture.file().agent).toMatchObject({ provider: 'vision', model: 'vision-model', thinking_level: 'off' });
    expect(fixture.file().telegram?.chats).toEqual(fixture.loaded.fileConfig.telegram?.chats);
    expect(fixture.configStore.current().config.telegram.chats).toEqual(before.config.telegram.chats);
  } finally {
    fixture.store.close();
  }
});

test('rejects cross-origin provider writes', async () => {
  const fixture = await adminFixture();
  try {
    const response = await fixture.server.handle(
      request('/api/providers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: fixture.cookie,
          origin: 'http://evil.example.test',
        },
        body: JSON.stringify({ alias: 'relay' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ error: 'bad_origin' });
  } finally {
    fixture.store.close();
  }
});
