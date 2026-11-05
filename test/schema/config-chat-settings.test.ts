import { afterAll, expect, test } from 'vitest';
import { join } from 'node:path';

import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import type { FileChat, FileConfig } from '../../src/platform/config/index.ts';
import { resolveAgentSettings } from '../../src/platform/config/resolve.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { cleanupSchemaDirectories, makeSchemaDirectory } from './fixtures.ts';

afterAll(cleanupSchemaDirectories);

// --- Config validation: chat-level provider/model/thinking_level overrides ---

test('rejects a chat with provider but no model', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('rejects a chat with model but no provider', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'Chat 123456789: provider and model must both be set when overriding agent settings',
  );
});

test('rejects a chat referencing a non-existent provider', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'ghost';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.provider references unknown alias ghost');
});

test('rejects a chat referencing a non-existent model', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'no-such-model';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    'chat 123456789.model no-such-model is absent from provider agent',
  );
});

test('rejects a chat model that lacks text input capability', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    provider.models = [{ ...provider.models[0]!, id: 'image-only', input: ['image'] }];
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'image-only';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow('chat 123456789.model image-only lacks text input capability');
});

test('rejects an inherited thinking_level incompatible with the Chat model', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      Object.assign(config.telegram.chats[0] ?? {}, { provider: 'vision', model: 'vision-model' });
    }),
  );
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level low is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level incompatible with the resolved model (non-reasoning)', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    // The vision provider has a non-reasoning model
    config.telegram.chats[0]!.provider = 'vision';
    config.telegram.chats[0]!.model = 'vision-model';
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level high is not supported by vision\/vision-model/,
  );
});

test('rejects a thinking_level above what the model declares', async () => {
  const directory = await makeSchemaDirectory();
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Bad fixture');
    }
    // Narrow the reasoning model to only declare off + minimal
    const model = provider.models[0]!;
    model.thinking_levels = ['off', 'minimal'];
    config.telegram.chats[0]!.thinking_level = 'xhigh';
  });
  await writeTestConfig(directory, configPath, jsonc);
  await expect(loadConfig(configPath)).rejects.toThrow(
    /chat 123456789\.thinking_level xhigh is not supported by agent\/agent-model/,
  );
});

test('resolveAgentSettings inherits thinking_level while overriding provider/model', () => {
  const config = {
    agent: { provider: 'agent', model: 'agent-model', thinking_level: 'medium' },
  } as Pick<FileConfig, 'agent'>;
  const chat = { provider: 'other', model: 'other-model' } as Pick<FileChat, 'provider' | 'model' | 'thinking_level'>;
  const result = resolveAgentSettings(config, chat);
  expect(result).toEqual({ provider: 'other', model: 'other-model', thinking_level: 'medium' });
});
