import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { adminFixture, call, installAdminProviderHooks, readJson, revisionOf, write } from './providers-fixtures.ts';

installAdminProviderHooks();

test('checks the vision model before writing it', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom') {
        throw new Error('Expected a custom agent provider');
      }
      agent.models.push({
        id: 'tiny-vision',
        name: 'Tiny Vision',
        reasoning: false,
        input: ['text', 'image'],
        context_window: 4_096,
        max_tokens: 1_024,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
      agent.models.push({
        id: 'text-only',
        name: 'Text Only',
        reasoning: false,
        input: ['text'],
        context_window: 200_000,
        max_tokens: 32_768,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
    },
  });
  try {
    const revision = await revisionOf(fixture);
    const missing = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'ghost' }, revision);
    expect(missing.status).toBe(400);
    expect(await readJson(missing)).toMatchObject({ error: 'unknown_model' });

    const textOnly = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'text-only' }, revision);
    expect(textOnly.status).toBe(400);
    expect(await readJson(textOnly)).toMatchObject({ error: 'not_image_capable' });

    const tooSmall = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'tiny-vision' }, revision);
    expect(tooSmall.status).toBe(400);
    expect(await readJson(tooSmall)).toMatchObject({ error: 'max_output_tokens_exceeded' });

    const ok = await write(fixture, '/api/vision', 'PUT', { provider: 'agent', model: 'agent-model' }, revision);
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({
      apply: { applied: ['vision.model', 'vision.provider'], restart_required: [] },
    });
    expect(fixture.file().vision).toMatchObject({ provider: 'agent', model: 'agent-model' });
    // The switch is hot: the running process analyzes with the new model.
    expect(fixture.configStore.current().config.vision).toMatchObject({ provider: 'agent', model: 'agent-model' });
    expect(fixture.configStore.current().visionModel?.id).toBe('agent-model');
  } finally {
    fixture.store.close();
  }
});

test('sets the vision thinking level with its model and drops a level the next model rejects', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const agent = config.providers.agent;
      if (agent?.kind !== 'custom' || agent.models[0] === undefined) {
        throw new Error('Expected a custom agent provider');
      }
      agent.models[0].thinking_levels = ['off', 'low', 'high', 'max'];
      agent.models.push({
        id: 'vision-medium',
        name: 'Vision Medium',
        reasoning: true,
        thinking_levels: ['off', 'medium'],
        input: ['text', 'image'],
        context_window: 128_000,
        max_tokens: 8_192,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
    },
  });
  try {
    // The fixture vision model does not reason, so its analyses run at `off`.
    expect(await readJson(await call(fixture, '/api/providers'))).toMatchObject({
      vision: { provider: 'vision', model: 'vision-model', thinking_level: 'off' },
    });
    const before = await readFile(fixture.configPath, 'utf8');
    const unsupported = await write(
      fixture,
      '/api/vision',
      'PUT',
      { provider: 'agent', model: 'agent-model', thinking_level: 'medium' },
      await revisionOf(fixture),
    );
    expect(unsupported.status).toBe(422);
    expect(await readJson(unsupported)).toMatchObject({
      error: 'unsupported_thinking_level',
      message: 'agent/agent-model does not accept thinking level medium (supported: off, low, high, max)',
    });
    expect(await readFile(fixture.configPath, 'utf8')).toBe(before);

    const high = await write(
      fixture,
      '/api/vision',
      'PUT',
      { provider: 'agent', model: 'agent-model', thinking_level: 'high' },
      await revisionOf(fixture),
    );
    expect(high.status).toBe(200);
    expect(await readJson(high)).toMatchObject({
      vision: { provider: 'agent', model: 'agent-model', thinking_level: 'high' },
      apply: { applied: ['vision.model', 'vision.provider', 'vision.thinking_level'], restart_required: [] },
    });
    expect(fixture.file().vision?.thinking_level).toBe('high');
    // Hot: the next analysis already runs at the new level.
    expect(fixture.configStore.current().config.vision.thinking_level).toBe('high');

    // A switch without a level keeps the stored one only while the model takes
    // it; this model has no `high`, so the stored level goes and the view shows
    // the default derived from the model (no `low`, so its weakest effort).
    const switched = await write(
      fixture,
      '/api/vision',
      'PUT',
      { provider: 'agent', model: 'vision-medium' },
      await revisionOf(fixture),
    );
    expect(switched.status).toBe(200);
    expect(await readJson(switched)).toMatchObject({
      vision: { provider: 'agent', model: 'vision-medium', thinking_level: 'medium' },
      apply: { applied: ['vision.model', 'vision.thinking_level'], restart_required: [] },
    });
    expect(fixture.file().vision).not.toHaveProperty('thinking_level');
    expect(fixture.configStore.current().config.vision).not.toHaveProperty('thinking_level');
  } finally {
    fixture.store.close();
  }
});

test('refuses to load a vision thinking level its model does not accept', async () => {
  await expect(
    adminFixture({
      transform: (config) => {
        config.vision = { ...config.vision, thinking_level: 'high' };
      },
    }),
  ).rejects.toThrow('vision.thinking_level high is not supported by vision/vision-model (supported: off)');
});

test('sets the agent thinking level only to a level the agent model accepts', async () => {
  const fixture = await adminFixture({
    transform: (config) => {
      const model = config.providers.agent?.models[0];
      if (model === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      model.thinking_levels = ['off', 'low', 'high', 'max'];
    },
  });
  try {
    const view = await readJson(await call(fixture, '/api/providers'));
    expect(view).toMatchObject({ agent: { provider: 'agent', model: 'agent-model', thinking_level: 'low' } });
    const revision = await revisionOf(fixture);

    const unknown = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'turbo' }, revision);
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ error: 'invalid_body' });

    const unsupported = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'medium' }, revision);
    expect(unsupported.status).toBe(422);
    expect(await readJson(unsupported)).toMatchObject({
      error: 'unsupported_thinking_level',
      message: 'agent/agent-model does not accept thinking level medium (supported: off, low, high, max)',
    });
    expect(fixture.file().agent!.thinking_level).toBe('low');

    const missingRevision = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'max' });
    expect(missingRevision.status).toBe(400);
    expect(await readJson(missingRevision)).toMatchObject({ error: 'revision_required' });

    const ok = await write(fixture, '/api/thinking-level', 'PUT', { thinking_level: 'max' }, revision);
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({
      agent: { thinking_level: 'max' },
      apply: { applied: ['agent.thinking_level'], restart_required: [] },
    });
    expect(fixture.file().agent!.thinking_level).toBe('max');
    // A whitelisted field: the next invocation already runs with it.
    expect(fixture.configStore.current().config.agent!.thinking_level).toBe('max');

    // Editing the agent model so that it loses the level in use is refused
    // before anything is written; the level has to move first.
    const before = await readFile(fixture.configPath, 'utf8');
    const narrowed = await write(
      fixture,
      '/api/providers/agent/models/agent-model',
      'PUT',
      { ...fixture.file().providers.agent?.models[0], thinking_levels: ['off', 'high'] },
      await revisionOf(fixture),
    );
    expect(narrowed.status).toBe(422);
    const refusal = (await readJson(narrowed)) as { error: string; message: string };
    expect(refusal.error).toBe('config_invalid');
    expect(refusal.message).toContain(
      'agent.thinking_level max is not supported by agent/agent-model (supported: off, high)',
    );
    expect(await readFile(fixture.configPath, 'utf8')).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('restarts only when the deployment declares a supervisor and the file loads', async () => {
  let restarts = 0;
  const fixture = await adminFixture({ onRestart: () => (restarts += 1) });
  try {
    const unsupervised = await call(fixture, '/api/restart', { method: 'POST' });
    expect(unsupervised.status).toBe(409);
    expect(await readJson(unsupervised)).toMatchObject({ error: 'restart_unsupported' });
    expect(restarts).toBe(0);

    process.env.PLASTICWAN_SUPERVISED = '1';
    await writeFile(fixture.configPath, '{ "version": 1 }');
    const invalid = await call(fixture, '/api/restart', { method: 'POST' });
    expect(invalid.status).toBe(422);
    expect(await readJson(invalid)).toMatchObject({ error: 'config_invalid' });
    expect(restarts).toBe(0);

    await writeFile(fixture.configPath, await readFile(join(fixture.directory, 'original.jsonc'), 'utf8'));
    const restarted = await call(fixture, '/api/restart', { method: 'POST' });
    expect(restarted.status).toBe(202);
    expect(await readJson(restarted)).toEqual({ status: 'restarting' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restarts).toBe(1);
  } finally {
    fixture.store.close();
  }
});
