import { expect, test } from 'vitest';
import {
  adminFixture,
  call,
  installAdminProviderHooks,
  model,
  readJson,
  revisionOf,
  write,
} from './providers-fixtures.ts';

installAdminProviderHooks();
const PATH = '/api/providers/models/delete';

// Failure boundaries: deleting ascending array indexes must not shift the next
// target; a missing, duplicate or referenced target must leave the entire file
// and active registry intact; stale revisions and malformed bodies never write.
const fixtureWithExtras = () =>
  adminFixture({
    transform: (config) => {
      config.providers.agent!.models.push(model('extra/first'), model('keep'), model('extra/last'));
      config.providers.vision!.models.push(model('vision-extra'));
    },
  });

test('deletes models across providers atomically without shifting remaining array indexes', async () => {
  const fixture = await fixtureWithExtras();
  try {
    const revision = await revisionOf(fixture);
    const response = await write(
      fixture,
      PATH,
      'POST',
      {
        models: [
          { provider: 'agent', model: 'extra/first' },
          { provider: 'vision', model: 'vision-extra' },
          { provider: 'agent', model: 'extra/last' },
        ],
      },
      revision,
    );
    expect(response.status).toBe(200);
    const result = await readJson(response);
    expect(result.revision).not.toBe(revision);
    expect(result.apply).toMatchObject({
      applied: expect.arrayContaining([
        'providers.agent.models[extra/first]',
        'providers.agent.models[extra/last]',
        'providers.vision.models[vision-extra]',
      ]),
      restart_required: [],
    });
    expect(fixture.file().providers.agent?.models.map((entry) => entry.id)).toEqual(['agent-model', 'keep']);
    expect(fixture.file().providers.vision?.models.map((entry) => entry.id)).toEqual(['vision-model']);
    const active = fixture.configStore.current();
    expect(active.models.getModel('agent', 'extra/first')).toBeUndefined();
    expect(active.models.getModel('agent', 'extra/last')).toBeUndefined();
    expect(active.models.getModel('vision', 'vision-extra')).toBeUndefined();
    expect(active.models.getModel('agent', 'keep')?.id).toBe('keep');
  } finally {
    fixture.store.close();
  }
});

test('keeps builtin and custom connections when their last models are deleted', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.spare = { ...config.providers.agent!, models: [model('spare')] };
      config.providers.builtin = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [model('deepseek-chat')],
      };
    },
  });
  try {
    const before = fixture.file();
    const response = await write(
      fixture,
      PATH,
      'POST',
      {
        models: [
          { provider: 'spare', model: 'spare' },
          { provider: 'builtin', model: 'deepseek-chat' },
        ],
      },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    for (const alias of ['spare', 'builtin']) {
      expect(fixture.file().providers[alias]).toEqual({ ...before.providers[alias], models: [] });
      expect(fixture.configStore.current().models.getProvider(alias)).toBeDefined();
      expect(fixture.configStore.current().models.getModels(alias)).toEqual([]);
    }
  } finally {
    fixture.store.close();
  }
});

// A mixed-catalog builtin (OpenRouter) derives its listed api from its first
// model; once emptied the view must still render, or the panel can neither
// report the committed deletion nor add a model back.
test('keeps an emptied mixed-catalog builtin listable and refillable', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.mixed = {
        kind: 'builtin',
        provider: 'openrouter',
        api_key: { jar: 'builtin' },
        models: [model('anthropic/claude-haiku-4.5')],
      };
    },
  });
  try {
    const before = fixture.file();
    const response = await write(
      fixture,
      PATH,
      'POST',
      { models: [{ provider: 'mixed', model: 'anthropic/claude-haiku-4.5' }] },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(200);
    const deleted = await readJson(response);
    const emptied = { alias: 'mixed', kind: 'builtin', provider: 'openrouter', models: [] };
    expect(deleted.providers).toContainEqual(expect.objectContaining({ ...emptied, api: 'openai-completions' }));
    expect(fixture.file().providers.mixed).toEqual({ ...before.providers.mixed, models: [] });
    expect(fixture.configStore.current().models.getModels('mixed')).toEqual([]);

    const listed = await call(fixture, '/api/providers');
    expect(listed.status).toBe(200);
    expect((await readJson(listed)).providers).toContainEqual(expect.objectContaining(emptied));

    const refilled = await write(
      fixture,
      '/api/providers/mixed/models',
      'POST',
      { models: [model('anthropic/claude-haiku-4.5')] },
      await revisionOf(fixture),
    );
    expect(refilled.status).toBe(200);
    expect((await readJson(refilled)).providers).toContainEqual(
      expect.objectContaining({ alias: 'mixed', api: 'anthropic-messages' }),
    );
    expect(fixture.configStore.current().models.getModel('mixed', 'anthropic/claude-haiku-4.5')?.api).toBe(
      'anthropic-messages',
    );
  } finally {
    fixture.store.close();
  }
});

test.each([
  ['missing model', { provider: 'agent', model: 'missing' }, 404, 'model_not_found'],
  ['missing provider', { provider: 'missing', model: 'missing' }, 404, 'provider_not_found'],
  ['agent role', { provider: 'agent', model: 'agent-model' }, 409, 'model_in_use'],
  ['vision role', { provider: 'vision', model: 'vision-model' }, 409, 'model_in_use'],
  ['duplicate', { provider: 'agent', model: 'extra/first' }, 400, 'invalid_body'],
] as const)('rejects the whole batch for a %s', async (_name, target, status, code) => {
  const fixture = await fixtureWithExtras();
  try {
    const before = await fixture.read();
    const active = fixture.configStore.current();
    const revision = await revisionOf(fixture);
    const response = await write(
      fixture,
      PATH,
      'POST',
      {
        models: [{ provider: 'agent', model: 'extra/first' }, target],
      },
      revision,
    );
    expect(response.status).toBe(status);
    expect(await readJson(response)).toMatchObject({ error: code });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(active);
    expect(await revisionOf(fixture)).toBe(revision);
  } finally {
    fixture.store.close();
  }
});

test.each(['chat', 'tool'] as const)('protects a model referenced only by a %s', async (reference) => {
  const fixture = await adminFixture({
    transform: (config) => {
      config.providers.agent!.models.push(model('extra'), model('referenced'));
      if (reference === 'chat') {
        Object.assign(config.telegram.chats[0]!, { provider: 'agent', model: 'referenced', thinking_level: 'off' });
      } else {
        config.tool_model = { provider: 'agent', model: 'referenced', thinking_level: 'off' };
      }
    },
  });
  try {
    const before = await fixture.read();
    const active = fixture.configStore.current();
    const response = await write(
      fixture,
      PATH,
      'POST',
      {
        models: [
          { provider: 'agent', model: 'extra' },
          { provider: 'agent', model: 'referenced' },
        ],
      },
      await revisionOf(fixture),
    );
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: 'model_in_use' });
    expect(await fixture.read()).toBe(before);
    expect(fixture.configStore.current()).toBe(active);
  } finally {
    fixture.store.close();
  }
});

test('requires authentication, revision, and a bounded nonempty valid target list', async () => {
  const fixture = await fixtureWithExtras();
  try {
    const before = await fixture.read();
    const revision = await revisionOf(fixture);
    const models = [{ provider: 'agent', model: 'extra/first' }];
    const unauthenticated = await fixture.server.handle(
      new Request(`http://127.0.0.1:8899${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': revision },
        body: JSON.stringify({ models }),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    const noRevision = await write(fixture, PATH, 'POST', { models });
    expect(noRevision.status).toBe(400);
    expect(await readJson(noRevision)).toMatchObject({ error: 'revision_required' });
    const stale = await write(fixture, PATH, 'POST', { models }, 'stale');
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toMatchObject({ error: 'config_conflict' });
    for (const body of [
      { models: [] },
      { models: Array.from({ length: 201 }, () => models[0]) },
      { models: [{ provider: 'invalid/alias', model: 'extra/first' }] },
      { models: [{ provider: 'agent', model: '' }] },
      { models: [{ provider: 'agent', model: 'extra/first', extra: true }] },
      { models, extra: true },
    ]) {
      const response = await write(fixture, PATH, 'POST', body, revision);
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: 'invalid_body' });
    }
    const forbidden = await call(fixture, PATH, {
      method: 'POST',
      headers: { origin: 'https://foreign.example', 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify({ models }),
    });
    expect(forbidden.status).toBe(403);
    expect(await fixture.read()).toBe(before);
  } finally {
    fixture.store.close();
  }
});
