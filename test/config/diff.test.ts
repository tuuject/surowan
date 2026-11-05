import { expect, test } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { createDirectory, loadBoth, paths } from './diff-fixtures.ts';

test('classifies hot, restart and outside-serve fields', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.agent!.thinking_level = 'high';
    config.agent!.send_max_text_length = 100;
    config.agent!.rate_limits!.turns_per_injection = 3;
    config.agent!.context!.idle_grace_seconds = 40;
    config.agent!.daily_budget!.max_tokens = 400_000;
    config.agent!.max_concurrency = 8;
    config.agent!.history_messages = 5;
    config.agent!.memory_ttl_warning_days = 14;
    config.agent!.context!.retained_sends_target = 1;
    config.agent!.context!.hard_token_ratio = 0.5;
    config.agent!.context!.ref_ttl_hours = 24;
    config.agent!.context!.agent_cache_size = 2;
    config.retention.online_days = 7;
    config.paths.backups = config.paths.backups.replace('backups', 'backups2');
    config.telegram.bucket_window_seconds = 30;
    config.vision!.max_output_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.context.agent_cache_size',
    'agent.context.hard_token_ratio',
    'agent.context.idle_grace_seconds',
    'agent.context.ref_ttl_hours',
    'agent.context.retained_sends_target',
    'agent.daily_budget.max_tokens',
    'agent.history_messages',
    'agent.max_concurrency',
    'agent.memory_ttl_warning_days',
    'agent.rate_limits.turns_per_injection',
    'agent.send_max_text_length',
    'agent.thinking_level',
    'vision.max_output_tokens',
  ]);
  expect(paths(diff.changes, 'outside_serve')).toEqual(['paths.backups', 'retention.online_days']);
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.bucket_window_seconds']);
  // Hot and outside-serve values come from the file; restart-only values stay.
  expect(diff.candidate.file.agent!.thinking_level).toBe('high');
  expect(diff.candidate.file.agent!.history_messages).toBe(5);
  expect(diff.candidate.file.retention.online_days).toBe(7);
  expect(diff.candidate.file.telegram?.bucket_window_seconds).toBe(15);
  expect(diff.candidate.file.vision?.max_output_tokens).toBe(4096);
  expect(diff.candidate.raw.agent.thinking_level).toBe('high');
});

test('reports prompt content and path changes on the prompt field', async () => {
  const directory = await createDirectory('surowan-diff-prompt-');
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const active = await loadConfig(configPath);
  await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'A different prompt.');
  const file = await loadConfig(configPath);
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.system_prompt_file']);
  expect(diff.candidate.raw.agent.system_prompt).toBe('A different prompt.');
});

test('aligns chats by id: additions and removals are both hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats = [{ id: 111 }];
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[111]', 'telegram.chats[123456789]']);
  // The removed chat leaves the candidate; its stored data is untouched until
  // an Admin explicitly deletes it. The added chat is adopted immediately.
  expect(diff.candidate.file.telegram?.chats.map((chat) => chat.id)).toEqual([111]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.instructions)).toEqual(['']);
});
