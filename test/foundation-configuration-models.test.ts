import { afterEach, describe, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { configuredToolSchemaKeywords } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { buildModelRegistry, requireModel } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { testConfigJsonc } from './helpers.ts';
import { cleanupFixtureDirectories, fixture } from './foundation-fixtures.ts';

afterEach(cleanupFixtureDirectories);

describe('configuration', () => {
  test('accepts an agent model without image input', async () => {
    const { directory, configPath } = await fixture();
    const config = testConfigJsonc(directory, (fileConfig) => {
      const provider = fileConfig.providers.agent;
      if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
        throw new Error('Expected custom agent provider fixture');
      }
      provider.models[0].input = ['text'];
    });
    await writeFile(configPath, config);
    const loaded = await loadConfig(configPath);
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
    expect(requireModel(registry.models, 'agent', 'agent-model', ['text']).input).toEqual(['text']);
  });

  test('rejects a vision model without image input', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.vision;
        if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
          throw new Error('Expected custom vision provider fixture');
        }
        provider.models[0].input = ['text'];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('vision.model vision-model lacks image input capability');
  });

  test('rejects developer-role compatibility for an Anthropic adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'anthropic-messages';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      'cannot set supports_developer_role for api anthropic-messages',
    );
  });

  test('rejects compat values outside the selected set', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        // `baseten` needs kwargs, so it is not offered as a thinking format.
        model.compat = { thinking_format: 'baseten' } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a cache control format Pi cannot force off', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = { cache_control_format: 'openai' } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a vision model a builtin provider does not list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = {
          kind: 'builtin',
          provider: 'google',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'gemini-3.7-flash',
              reasoning: true,
              input: ['text', 'image'],
              context_window: 1_048_576,
              max_tokens: 65_536,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
        config.vision!.provider = 'builtin';
        config.vision!.model = 'gemini-3.7-pro';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('gemini-3.7-pro is absent from provider builtin');
  });

  test('rejects compat fields the model API does not honour', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        // Responses adapters only read `supports_developer_role`.
        provider.api = 'openai-responses';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = { thinking_format: 'deepseek' };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('cannot set thinking_format for api openai-responses');
  });

  test('accepts the selected compat fields for an OpenAI completions adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = {
          supports_developer_role: false,
          thinking_format: 'openrouter',
          max_tokens_field: 'max_tokens',
          requires_reasoning_content: true,
          cache_control_format: 'anthropic',
        };
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.fileConfig.providers.agent?.models[0]?.compat).toMatchObject({ thinking_format: 'openrouter' });
  });

  test('accepts the minimal tool-schema keyword profile on any adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.tool_schema_keywords = 'minimal';
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.fileConfig.providers.agent?.models[0]?.tool_schema_keywords).toBe('minimal');
    expect(configuredToolSchemaKeywords(loaded.config, 'agent', 'agent-model')).toBe('minimal');
  });

  test('rejects a tool-schema keyword profile the runtime does not implement', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.tool_schema_keywords = 'full' as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects thinking levels on a model that does not reason', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.vision?.models[0];
        if (model === undefined) {
          throw new Error('Expected a vision model fixture');
        }
        model.thinking_levels = ['off', 'low'];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('declares thinking_levels but is not a reasoning model');
  });

  test('rejects an agent thinking level the agent model does not accept', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.thinking_levels = ['off', 'high', 'max'];
        config.agent!.thinking_level = 'low';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      'agent.thinking_level low is not supported by agent/agent-model (supported: off, high, max)',
    );
  });

  test('offers xhigh and max only to a model that declares them', async () => {
    const { directory, configPath } = await fixture();
    // Undeclared, a reasoning model gets Pi's default, which stops at high.
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.agent!.thinking_level = 'max';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('(supported: off, minimal, low, medium, high)');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.thinking_levels = ['max', 'high'];
        config.agent!.thinking_level = 'max';
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent!.thinking_level).toBe('max');
  });
});
