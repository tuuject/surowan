import { expect, test } from 'vitest';
import { join } from 'node:path';
import type { FileConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { diffConfig } from '../src/platform/config-diff.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';
import { createDirectory, loadBoth, paths, spareModel } from './config-diff-fixtures.ts';

test('edits inside existing dictionary and tool model sections are hot', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.dictionary = { injection_mode: 'on_demand' };
      config.tool_model = { provider: 'agent', model: 'agent-model', thinking_level: 'off' };
    },
    (config) => {
      config.dictionary = { injection_mode: 'aggressive' };
      config.providers.agent!.models.push(spareModel());
      config.tool_model = { provider: 'agent', model: 'spare', thinking_level: 'off' };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toContain('dictionary.injection_mode');
  expect(paths(diff.changes, 'hot')).toContain('tool_model.model');
  expect(diff.candidate.raw.dictionary?.injection_mode).toBe('aggressive');
  expect(diff.candidate.raw.tool_model?.model).toBe('spare');
});

test('adding a web_search section is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    Object.assign(config, {
      web_search: { enabled: false, vendor: 'deepseek', api_key: { env: 'DEEPSEEK_KEY' } },
    });
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toContain('web_search');
  expect(diff.candidate.raw.web_search).toMatchObject({ enabled: false, vendor: 'deepseek' });
});

test('edits inside an existing web_search section are hot', async () => {
  const webSearch = (enabled: boolean) => ({
    enabled,
    vendor: 'deepseek',
    api_key: { env: 'DEEPSEEK_KEY' },
  });
  const { active, file } = await loadBoth(
    (config) => {
      Object.assign(config, { web_search: webSearch(true) });
    },
    (config) => {
      Object.assign(config, { web_search: webSearch(false) });
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toContain('web_search.enabled');
  expect(diff.candidate.raw.web_search).toMatchObject({ enabled: false });
});

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
  expect(diff.candidate.file.telegram.bucket_window_seconds).toBe(15);
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

test('aligns chats by id: additions are hot while removals wait for a restart', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats = [{ id: 111 }];
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789]']);
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[111]']);
  // The removed chat waits for a restart and keeps the active instructions; the
  // added chat is adopted immediately with its file instructions ('' here).
  expect(diff.candidate.file.telegram.chats.map((chat) => chat.id)).toEqual([123456789, 111]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.instructions)).toEqual(['private', '']);
});

test('adding a chat is hot and the candidate adopts it in file order', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats.push({ id: -987654321 });
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[-987654321]']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats.map((chat) => chat.id)).toEqual([123456789, -987654321]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.id)).toEqual([123456789, -987654321]);
});

test.each([
  { before: undefined, after: [42] },
  { before: [42], after: [99] },
  { before: [42], after: [] },
  { before: [42], after: undefined },
])('hot-applies ignored_user_ids from $before to $after', async ({ before, after }) => {
  const setIds = (config: FileConfig, ids: number[] | undefined) => {
    if (ids === undefined) {
      delete config.telegram.chats[0]!.ignored_user_ids;
    } else {
      config.telegram.chats[0]!.ignored_user_ids = ids;
    }
  };
  const { active, file } = await loadBoth(
    (config) => setIds(config, before),
    (config) => setIds(config, after),
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].ignored_user_ids']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats[0]?.ignored_user_ids).toEqual(after);
  expect(diff.candidate.raw.telegram.chats[0]?.ignored_user_ids).toEqual(after);
});

test.each([
  { before: undefined, after: true },
  { before: true, after: false },
  { before: true, after: undefined },
])('hot-applies allow_reply_message_multiple_times from $before to $after', async ({ before, after }) => {
  const setField = (config: FileConfig, value: boolean | undefined) => {
    if (value === undefined) {
      delete config.agent!.allow_reply_message_multiple_times;
    } else {
      config.agent!.allow_reply_message_multiple_times = value;
    }
  };
  const { active, file } = await loadBoth(
    (config) => setField(config, before),
    (config) => setField(config, after),
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.allow_reply_message_multiple_times']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.agent!.allow_reply_message_multiple_times).toEqual(after);
  expect(diff.candidate.raw.agent.allow_reply_message_multiple_times).toEqual(after);
});

test('treats a chat field other than instructions as restart-only', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789].timezone']);
  expect(diff.candidate.file.telegram.chats[0]?.timezone).toBeUndefined();
});

test('adding or removing a whole optional agent object is hot', async () => {
  const withoutObjects = (config: FileConfig) => {
    delete config.agent!.daily_budget;
    delete config.agent!.context;
    delete config.agent!.rate_limits;
  };
  const withObjects = (config: FileConfig) => {
    config.agent!.daily_budget = { max_tokens: 1000 };
    config.agent!.context = { ref_ttl_hours: 24 };
    config.agent!.rate_limits = { window_seconds: 60 };
  };
  const added = await loadBoth(withoutObjects, withObjects);
  const addDiff = diffConfig(
    { file: added.active.fileConfig, raw: added.active.config },
    { file: added.file.fileConfig, raw: added.file.config },
  );
  expect(paths(addDiff.changes, 'hot')).toEqual(['agent.context', 'agent.daily_budget', 'agent.rate_limits']);
  expect(paths(addDiff.changes, 'restart')).toEqual([]);
  expect(addDiff.candidate.raw.agent.daily_budget.max_tokens).toBe(1000);
  expect(addDiff.candidate.raw.agent.context.ref_ttl_hours).toBe(24);
  expect(addDiff.candidate.raw.agent.rate_limits.window_seconds).toBe(60);

  const removed = await loadBoth(withObjects, withoutObjects);
  const removeDiff = diffConfig(
    { file: removed.active.fileConfig, raw: removed.active.config },
    { file: removed.file.fileConfig, raw: removed.file.config },
  );
  expect(paths(removeDiff.changes, 'hot')).toEqual(['agent.context', 'agent.daily_budget', 'agent.rate_limits']);
  expect(paths(removeDiff.changes, 'restart')).toEqual([]);
  expect(removeDiff.candidate.file.agent?.daily_budget).toBeUndefined();
});

test('dropping the whole agent section is hot and leaves no restart-only value behind', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    (config as unknown as Record<string, unknown>).agent = null;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(paths(diff.changes, 'hot')).toEqual(expect.arrayContaining(['agent.context', 'agent.daily_budget']));
  expect(diff.candidate.file.agent).toBeNull();
});
