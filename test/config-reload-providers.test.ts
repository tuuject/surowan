import { expect, test } from 'vitest';
import {
  AGENT_MODEL,
  customProvider,
  builtinProvider,
  model,
  CountingSecrets,
  setup,
} from './config-reload-fixtures.ts';

test('a new model on an existing builtin provider is hot, rebuilds the registry, and re-resolves no secret', async () => {
  const fixture = await setup({ secrets: (keyJar) => new CountingSecrets(keyJar) });
  const secrets = fixture.secrets as CountingSecrets;
  try {
    const resolvedAtStartup = secrets.resolutions;
    expect(resolvedAtStartup).toBeGreaterThan(0);
    // Pi's catalog knows this id, the file does not: it must stay unreachable.
    expect(fixture.configStore.current().models.getModel('faux', 'deepseek-reasoner')).toBeUndefined();

    await fixture.patch((config) => {
      builtinProvider(config.providers, 'faux').models.push(model('deepseek-reasoner'));
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.faux.models[deepseek-reasoner]']);
    expect(fixture.configStore.current().models.getModel('faux', 'deepseek-reasoner')).toBeDefined();
    expect(fixture.configStore.current().models.getModel('faux', AGENT_MODEL)).toBeDefined();
    // Rebuilding a builtin provider reuses the auth the registry already holds;
    // a `command` SecretRef must not run again on reload.
    expect(secrets.resolutions).toBe(resolvedAtStartup);
  } finally {
    fixture.store.close();
  }
});

test('editing a builtin model in use is hot and reaches the registry', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      const agentModel = builtinProvider(config.providers, 'faux').models[0];
      if (agentModel === undefined) {
        throw new Error('Expected the faux agent model');
      }
      agentModel.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([`providers.faux.models[${AGENT_MODEL}]`]);
    expect(result.restartRequired).toEqual([]);
    expect(builtinProvider(fixture.configStore.current().config.providers, 'faux').models[0]?.context_window).toBe(
      100_000,
    );
    expect(fixture.configStore.current().models.getModel('faux', AGENT_MODEL)?.contextWindow).toBe(100_000);
  } finally {
    fixture.store.close();
  }
});

test('a new model on an existing custom provider is hot and immediately selectable', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').models.push(model('agent-extra'));
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.agent.models[agent-extra]']);
    expect(fixture.modelSwitcher.list().map((option) => `${option.provider}/${option.model}`)).toContain(
      'agent/agent-extra',
    );

    const switched = await fixture.reloader.setAgentModel('agent', 'agent-extra');
    expect(switched.ok).toBe(true);
    // `agent-extra` does not reason, so `off` is the only level it has.
    expect(fixture.configStore.current().config.agent).toMatchObject({
      provider: 'agent',
      model: 'agent-extra',
      thinking_level: 'off',
    });

    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').base_url = 'https://other.test/v1';
    });
    const connection = await fixture.reloader.reloadFromFile();
    expect(connection.ok).toBe(true);
    if (!connection.ok) {
      throw new Error(connection.message);
    }
    expect(connection.applied).toContain('providers.agent.base_url');
    expect(connection.restartRequired).toEqual([]);
    expect(fixture.configStore.current().config.providers.agent).toMatchObject({
      base_url: 'https://other.test/v1',
    });
    expect(fixture.configStore.current().models.getProvider('agent')?.baseUrl).toBe('https://other.test/v1');
  } finally {
    fixture.store.close();
  }
});

test('editing the model in use is hot', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent!.provider = 'agent';
      config.agent!.model = 'agent-model';
    },
  });
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'agent').models[0]!.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.agent.models[agent-model]']);
    expect(result.restartRequired).toEqual([]);
    expect(customProvider(fixture.configStore.current().config.providers, 'agent').models[0]?.context_window).toBe(
      100_000,
    );
  } finally {
    fixture.store.close();
  }
});

test('editing a model the agent just left is hot', async () => {
  const fixture = await setup({
    transform: (config) => {
      config.agent!.provider = 'agent';
      config.agent!.model = 'agent-model';
    },
  });
  try {
    await fixture.patch((config) => {
      config.agent!.provider = 'vision';
      config.agent!.model = 'vision-model';
      // The vision model does not reason, so `off` is the only level it takes.
      config.agent!.thinking_level = 'off';
      customProvider(config.providers, 'agent').models[0]!.context_window = 100_000;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual([
      'agent.model',
      'agent.provider',
      'agent.thinking_level',
      'providers.agent.models[agent-model]',
    ]);
    expect(result.restartRequired).toEqual([]);
    expect(customProvider(fixture.configStore.current().config.providers, 'agent').models[0]?.context_window).toBe(
      100_000,
    );
  } finally {
    fixture.store.close();
  }
});

test('editing the vision model is hot and republishes the vision model', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      customProvider(config.providers, 'vision').models[0]!.max_tokens = 4_096;
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.vision.models[vision-model]']);
    expect(result.restartRequired).toEqual([]);
    expect(customProvider(fixture.configStore.current().config.providers, 'vision').models[0]?.max_tokens).toBe(4_096);
    expect(fixture.configStore.current().visionModel?.maxTokens).toBe(4_096);
  } finally {
    fixture.store.close();
  }
});

test('switching the vision model is hot and refuses a model over the output limit', async () => {
  const fixture = await setup({
    transform: (config) => {
      const vision = config.providers.vision;
      if (vision?.kind !== 'custom') {
        throw new Error('Expected the custom vision provider fixture');
      }
      vision.models.push(model('vision-alt', { input: ['text', 'image'] }));
    },
  });
  try {
    await fixture.patch((config) => {
      config.vision!.model = 'vision-alt';
      config.vision!.max_output_tokens = 4_096;
    });
    const switched = await fixture.reloader.reloadFromFile();
    expect(switched.ok).toBe(true);
    if (!switched.ok) {
      throw new Error(switched.message);
    }
    expect(switched.applied).toEqual(['vision.max_output_tokens', 'vision.model']);
    expect(switched.restartRequired).toEqual([]);
    expect(fixture.configStore.current().visionModel?.id).toBe('vision-alt');

    // The check that used to guard the next startup now guards the publication:
    // a limit the new model cannot honour leaves the running configuration alone.
    const before = fixture.configStore.current();
    await fixture.patch((config) => {
      config.vision!.max_output_tokens = 65_536;
    });
    const refused = await fixture.reloader.reloadFromFile();
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      throw new Error('Expected the output limit to be refused');
    }
    expect(refused.code).toBe('model_unusable');
    expect(refused.message).toContain('Vision max_output_tokens');
    expect(fixture.configStore.current()).toBe(before);
  } finally {
    fixture.store.close();
  }
});

test('an agent pointing at a brand new provider switches in the same reload', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      config.providers.extra = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'extra' },
        models: [model('extra-model', { reasoning: true })],
      };
      config.agent!.provider = 'extra';
      config.agent!.model = 'extra-model';
      config.agent!.thinking_level = 'high';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['agent.model', 'agent.provider', 'agent.thinking_level', 'providers.extra']);
    expect(result.restartRequired).toEqual([]);
    expect(fixture.configStore.current().config.agent).toMatchObject({ provider: 'extra', model: 'extra-model' });
    expect(fixture.configStore.current().models.getModel('extra', 'extra-model')).toBeDefined();
  } finally {
    fixture.store.close();
  }
});

test('removing a provider is hot and unregisters it', async () => {
  const fixture = await setup();
  try {
    await fixture.patch((config) => {
      delete config.providers.vision;
      config.vision!.provider = 'agent';
      config.vision!.model = 'agent-model';
      config.agent!.provider = 'faux';
    });
    const result = await fixture.reloader.reloadFromFile();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.applied).toEqual(['providers.vision', 'vision.model', 'vision.provider']);
    expect(result.restartRequired).toEqual([]);
    expect(fixture.configStore.current().models.getProvider('vision')).toBeUndefined();
    expect(fixture.configStore.current().visionModel?.provider).toBe('agent');
  } finally {
    fixture.store.close();
  }
});
