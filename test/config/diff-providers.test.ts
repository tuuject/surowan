import { expect, test } from 'vitest';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { customModels, loadBoth, paths, spareModel } from './diff-fixtures.ts';

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
