import { expect, test } from 'vitest';
import { diffConfig } from '../../src/platform/config/diff.ts';
import { loadBoth, paths } from './diff-fixtures.ts';

// --- Chat provider/model/thinking_level overrides are hot ---

test('chat override is hot even when a restart-only field changes in the same chat', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
    config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  // Override fields are hot; timezone is restart-only
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789].timezone']);
  expect(diff.candidate.file.telegram?.chats[0]?.provider).toBe('agent');
  expect(diff.candidate.file.telegram?.chats[0]?.model).toBe('agent-model');
  // Restart-only field keeps the active value
  expect(diff.candidate.file.telegram?.chats[0]?.timezone).toBeUndefined();
});
