import { expect, test } from 'vitest';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { customModels, loadBoth, paths, spareModel } from './diff-fixtures.ts';

test('adds, removes and edits provider models as hot changes in file order', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [
          { ...spareModel(), id: 'spare-a' },
          { ...spareModel(), id: 'spare-b' },
        ],
      };
    },
    (config) => {
      const provider = config.providers.spare;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [
        { ...spareModel(), id: 'spare-b', context_window: 100_000 },
        { ...spareModel(), id: 'spare-c' },
      ];
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'providers.spare.models[spare-a]',
    'providers.spare.models[spare-b]',
    'providers.spare.models[spare-c]',
  ]);
  expect(customModels(diff.candidate.file, 'spare').map((model) => [model.id, model.context_window])).toEqual([
    ['spare-b', 100_000],
    ['spare-c', 64_000],
  ]);
});

test('takes the file definition of a model the candidate still uses', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models[0]!.context_window = 100_000;
    // The vision model is in use too, and its definition is as hot as any other.
    const vision = config.providers.vision;
    if (vision?.kind !== 'custom') {
      throw new Error('Expected a custom vision provider fixture');
    }
    vision.models[0]!.max_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'providers.agent.models[agent-model]',
    'providers.vision.models[vision-model]',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => model.context_window)).toEqual([100_000]);
  expect(customModels(diff.candidate.file, 'vision').map((model) => model.max_tokens)).toEqual([4096]);
});

test('a model is hot once the agent points at another one', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models = [
      { ...provider.models[0]!, context_window: 100_000 },
      { ...provider.models[0]!, id: 'agent-model-2' },
    ];
    config.agent!.model = 'agent-model-2';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.model',
    'providers.agent.models[agent-model-2]',
    'providers.agent.models[agent-model]',
  ]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 100_000],
    ['agent-model-2', 200_000],
  ]);
});

test('editing the model the agent switches to in the same change is hot', async () => {
  // The target is not in use yet, so its new definition applies together with
  // the switch instead of waiting for a restart.
  const { active, file } = await loadBoth(
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [provider.models[0]!, { ...provider.models[0]!, id: 'agent-model-2' }];
    },
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models[1]!.context_window = 100_000;
      config.agent!.model = 'agent-model-2';
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.model', 'providers.agent.models[agent-model-2]']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 200_000],
    ['agent-model-2', 100_000],
  ]);
});

test('an agent pointing at a new provider is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.providers.extra = {
      kind: 'custom',
      base_url: 'https://example.test/v1',
      api: 'openai-responses',
      api_key: { jar: 'extra' },
      models: [
        {
          id: 'extra-model',
          reasoning: true,
          input: ['text'],
          context_window: 64_000,
          max_tokens: 4_096,
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        },
      ],
    };
    config.agent!.provider = 'extra';
    config.agent!.model = 'extra-model';
    config.agent!.thinking_level = 'high';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.model',
    'agent.provider',
    'agent.thinking_level',
    'providers.extra',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.agent).toMatchObject({ provider: 'extra', model: 'extra-model' });
  expect(diff.candidate.file.providers.extra).toMatchObject({ kind: 'custom', base_url: 'https://example.test/v1' });
});

test('removes a provider as a hot change', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
    (config) => {
      delete config.providers.spare;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.spare']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.spare).toBeUndefined();
});

test('re-kinding a provider is hot and takes the file definition', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
    (config) => {
      config.providers.spare = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.spare']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.spare).toMatchObject({ kind: 'builtin', provider: 'deepseek' });
});

test('a provider connection change is hot and takes the file provider', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.base_url = 'https://other.test/v1';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.agent.base_url']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.agent).toMatchObject({ base_url: 'https://other.test/v1' });
});

// --- Chat provider/model/thinking_level overrides are hot ---
