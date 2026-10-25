import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test } from 'vitest';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';

import { testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';
import { AGENT_DEFAULTS } from '../../src/platform/config/resolve.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function loadWithoutAgent(agent: unknown): Promise<LoadedConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-optional-agent-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    (config as unknown as Record<string, unknown>).agent = agent;
  });
  await writeTestConfig(directory, configPath, jsonc);
  return loadConfig(configPath);
}

describe('optional agent section', () => {
  test('agent: {} is legal and resolves runtime defaults', async () => {
    const loaded = await loadWithoutAgent({});
    const agent = loaded.config.agent;
    expect(agent.provider).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.thinking_level).toBeUndefined();
    expect(agent.system_prompt).toBe('');
    expect(agent.max_concurrency).toBe(AGENT_DEFAULTS.max_concurrency);
    expect(agent.context).toEqual(AGENT_DEFAULTS.context);
    expect(agent.rate_limits).toEqual(AGENT_DEFAULTS.rate_limits);
    expect(loaded.warnings.some((warning) => warning.includes('invocation'))).toBe(true);
  });

  test('an empty daily_budget object resolves the default budget', async () => {
    const loaded = await loadWithoutAgent({ daily_budget: {} });
    expect(loaded.config.agent.daily_budget.max_tokens).toBe(AGENT_DEFAULTS.daily_budget.max_tokens);
  });

  test('agent: null is legal', async () => {
    const loaded = await loadWithoutAgent(null);
    expect(loaded.config.agent.provider).toBeUndefined();
    expect(loaded.config.agent.max_concurrency).toBe(AGENT_DEFAULTS.max_concurrency);
  });

  test('a missing agent key is legal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-optional-agent-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    const jsonc = testConfigJsonc(directory, (config) => {
      delete (config as unknown as Record<string, unknown>).agent;
    });
    await writeTestConfig(directory, configPath, jsonc);
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.provider).toBeUndefined();
    expect(loaded.warnings.some((warning) => warning.includes('invocation'))).toBe(true);
  });

  test('a partial identity stays legal and skips model validation', async () => {
    const loaded = await loadWithoutAgent({ provider: 'agent' });
    expect(loaded.config.agent.provider).toBe('agent');
    expect(loaded.config.agent.model).toBeUndefined();
  });

  test('an incomplete identity never opens an invocation', async () => {
    const loaded = await loadWithoutAgent({});
    const configStore = await testConfigStore(loaded);
    const store = await SqliteStore.open(loaded.config);
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
    const start = new Date('2024-01-01T00:00:00Z');
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(start.getTime() / 1000),
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hi',
      },
    };
    ingestion.ingest(update, start);
    const due = scheduler.processDue(new Date(start.getTime() + 15_000));
    expect(due).toHaveLength(0);
    const bucket = store.db.prepare('SELECT state, error_code FROM buckets ORDER BY id DESC LIMIT 1').get() as {
      state: string;
      error_code: string | null;
    };
    expect(bucket).toEqual({ state: 'skipped_budget', error_code: 'agent_unconfigured' });
  });

  test('a chat override completing the triple still starts an invocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-optional-agent-'));
    directories.push(directory);
    const configPath = join(directory, 'config.jsonc');
    const jsonc = testConfigJsonc(directory, (config) => {
      (config as unknown as Record<string, unknown>).agent = {};
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
      config.telegram.chats[0]!.thinking_level = 'low';
    });
    await writeTestConfig(directory, configPath, jsonc);
    await writeFile(join(directory, 'agent-system-prompt.md'), 'test prompt');
    const loaded = await loadConfig(configPath);
    const configStore = await testConfigStore(loaded);
    const store = await SqliteStore.open(loaded.config);
    const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
    const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
    const start = new Date('2024-01-01T00:00:00Z');
    ingestion.ingest(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(start.getTime() / 1000),
          chat: { id: 123456789, type: 'private', first_name: 'Owner' },
          from: { id: 42, is_bot: false, first_name: 'Alice' },
          text: 'hi',
        },
      },
      start,
    );
    const due = scheduler.processDue(new Date(start.getTime() + 15_000));
    expect(due).toHaveLength(1);
  });
});
