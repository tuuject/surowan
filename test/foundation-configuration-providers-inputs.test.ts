import { afterEach, describe, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';
import { cleanupFixtureDirectories, fixture } from './foundation-fixtures.ts';

afterEach(cleanupFixtureDirectories);

describe('configuration', () => {
  test('rejects a provider alias that cannot survive a URL path or restart string', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers['bad alias'] = {
          kind: 'custom',
          base_url: 'https://example.test/v1',
          api: 'openai-completions',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'model',
              reasoning: false,
              input: ['text'],
              context_window: 1_000,
              max_tokens: 100,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('must match');
  });

  test('rejects a builtin provider without a model list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = { kind: 'builtin', provider: 'openrouter', api_key: { jar: 'agent' } } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a builtin provider whose catalog is not supported', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.unsupported = {
          kind: 'builtin',
          provider: 'mistral',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'mistral-large-latest',
              reasoning: false,
              input: ['text'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('cannot be driven from a configured API key');
  });

  test('rejects an agent model a builtin provider does not list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = {
          kind: 'builtin',
          provider: 'deepseek',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'deepseek-chat',
              reasoning: false,
              input: ['text'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
        config.agent!.provider = 'builtin';
        config.agent!.model = 'deepseek-reasoner';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('deepseek-reasoner is absent from provider builtin');
  });

  test('rejects a leftover max_output_tokens in the agent section', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config.agent, { max_output_tokens: 4096 })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.chats[0]?.ignored_user_ids).toEqual([42, 99]);
  });

  test('rejects invalid chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid ignored Telegram user ID in chat 123456789');
  });

  test('accepts configured telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.admins).toEqual([42, 99]);
  });

  test('rejects invalid telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid Telegram admin user ID');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts JSONC comments and trailing commas', async () => {
    const { directory, configPath } = await fixture();
    const source = testConfigJsonc(directory)
      .replace('{', '{\n  // Operator-managed configuration')
      .replace('"version": 1,', '"version": 1, /* schema version */');
    await writeFile(configPath, source.replace(/\n}\n$/, ',\n}\n'));
    expect((await loadConfig(configPath)).config.version).toBe(1);
  });

  test('rejects invalid JSONC syntax', async () => {
    const { configPath } = await fixture();
    await writeFile(configPath, '{ "version": 1,, }');
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSONC');
  });

  test('strips HTML comments from prompt files', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      '# Persona\n<!-- Why this rule exists: operators read the file too -->\nStay kind.\n',
      'private<!-- and keep quiet -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent!.system_prompt).toBe('# Persona\nStay kind.\n');
    expect(loaded.config.telegram.chats[0]?.instructions).toBe('private');
  });

  test('ignores template expressions inside prompt annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      'You run as {{ agent.model }}.<!-- {{ agent.api_key }} is an annotation, not a template -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent!.system_prompt).toBe('You run as {{ agent.model }}.');
  });

  test('a comment-only prompt edit still changes the config hash', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\nStay kind.\n');
    const plain = await loadConfig(configPath);
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\n<!-- note -->\nStay kind.\n');
    const annotated = await loadConfig(configPath);
    expect(annotated.config.agent!.system_prompt).toBe(plain.config.agent!.system_prompt);
    expect(annotated.hash).not.toBe(plain.hash);
  });

  test('rejects a system prompt that holds nothing but annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '<!-- TODO: write the persona -->\n');
    await expect(loadConfig(configPath)).rejects.toThrow('is empty or contains only HTML comments');
  });

  test('rejects a prompt file containing a NUL character', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'Persona\u0000here');
    await expect(loadConfig(configPath)).rejects.toThrow('contains a NUL character');
  });
});
