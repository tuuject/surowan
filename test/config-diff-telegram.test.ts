import { expect, test } from 'vitest';
import { diffConfig } from '../src/platform/config-diff.ts';
import { loadBoth, paths } from './config-diff-fixtures.ts';

// --- Chat provider/model/thinking_level overrides are hot ---

test('adding a chat provider + model override is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram?.chats[0]?.provider).toBe('agent');
  expect(diff.candidate.file.telegram?.chats[0]?.model).toBe('agent-model');
});

test('modifying a chat provider override is hot and takes the file value', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      config.telegram.chats[0]!.provider = 'vision';
      config.telegram.chats[0]!.model = 'vision-model';
      config.telegram.chats[0]!.thinking_level = 'off';
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'telegram.chats[123456789].model',
    'telegram.chats[123456789].provider',
    'telegram.chats[123456789].thinking_level',
  ]);
  expect(diff.candidate.file.telegram?.chats[0]?.provider).toBe('vision');
  expect(diff.candidate.file.telegram?.chats[0]?.model).toBe('vision-model');
});

test('removing a chat provider override is hot and drops it from the candidate', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      delete (config.telegram.chats[0] as Record<string, unknown>).provider;
      delete (config.telegram.chats[0] as Record<string, unknown>).model;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram?.chats[0]?.provider).toBeUndefined();
  expect(diff.candidate.file.telegram?.chats[0]?.model).toBeUndefined();
});

test('setting a chat thinking_level override is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].thinking_level']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram?.chats[0]?.thinking_level).toBe('high');
});

test('removing a chat thinking_level override is hot', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.thinking_level = 'high';
    },
    (config) => {
      delete (config.telegram.chats[0] as Record<string, unknown>).thinking_level;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].thinking_level']);
  expect(diff.candidate.file.telegram?.chats[0]?.thinking_level).toBeUndefined();
});

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

test('chat override persists after an unrelated chat is removed (ID-based merge)', async () => {
  // Active has two chats, one with an override
  // File removes the chat without override; the override chat survives
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats.push({ id: -987654321 });
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      // File only has the override chat (the non-override chat is removed)
      config.telegram.chats = [{ id: 123456789, provider: 'agent', model: 'agent-model' }];
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[-987654321]']);
  // The override chat should still be present with its override
  const chat = diff.candidate.file.telegram?.chats.find((c) => c.id === 123456789);
  expect(chat?.provider).toBe('agent');
  expect(chat?.model).toBe('agent-model');
  // New chat in file
  expect(diff.candidate.file.telegram?.chats.map((c) => c.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
    -987654321, 123456789,
  ]);
});

test('participation schedules at both levels are hot, including their sub-fields', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats.push({ id: -100100, instructions_file: 'chat-instructions.md' });
      config.telegram.participation = { active_windows: [{ start: '09:00', end: '18:00' }] };
    },
    (config) => {
      config.telegram.participation = {
        active_windows: [{ start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5] }],
        trigger_keywords: ['ping'],
      };
      config.telegram.chats[1]!.participation = { active_windows: [] };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'telegram.chats[-100100].participation',
    'telegram.participation.active_windows',
    'telegram.participation.trigger_keywords',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram?.chats[1]?.participation).toEqual({ active_windows: [] });
});

test('proactive reply settings at both levels are hot, including their sub-fields', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats.push({ id: -100100, instructions_file: 'chat-instructions.md' });
      config.telegram.proactive_reply = { enabled: true, base_probability: 0.2 };
      config.telegram.chats[1]!.proactive_reply = { enabled: false };
    },
    (config) => {
      config.telegram.proactive_reply = { enabled: true, base_probability: 0.35, increment: 0.05 };
      config.telegram.chats[1]!.proactive_reply = { hard_pity: 4 };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'telegram.chats[-100100].proactive_reply.enabled',
    'telegram.chats[-100100].proactive_reply.hard_pity',
    'telegram.proactive_reply.base_probability',
    'telegram.proactive_reply.increment',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram?.chats[1]?.proactive_reply).toEqual({ hard_pity: 4 });
});
