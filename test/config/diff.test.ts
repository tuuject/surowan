import { expect, test } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { testConfigJsonc, writeTestConfig } from '../helpers.ts';
import { createDirectory, loadBoth, paths } from './diff-fixtures.ts';

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
