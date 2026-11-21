import { expect, test } from 'vitest';
import { diffConfig } from '../../src/platform/config/diff.ts';
import type { FixtureConfig } from '../helpers.ts';
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

// --- The Decisions entry gate is hot as a whole, on both levels ---

test('every connection and behavior field of the global decision_gate section is hot', async () => {
  const base = (config: FixtureConfig) => {
    config.telegram.decision_gate = {
      enabled: true,
      mode: 'shadow',
      threshold: 0.57,
      history_messages: 10,
      pending_messages: 10,
      model: 'typesafe/jev-1.14',
      base_url: 'https://openrouter.ai/api/alpha',
      api_key: { jar: 'telegram' },
      timeout_ms: 3000,
    };
  };
  const { active, file } = await loadBoth(base, (config) => {
    config.telegram.decision_gate = {
      enabled: false,
      mode: 'enforce',
      threshold: 0.7,
      history_messages: 4,
      pending_messages: 20,
      instructions: 'Should {{ bot.name }} answer this batch?',
      model: 'perplexity/pplx-decider-flash-v1.2',
      base_url: 'https://gateway.test/api',
      api_key: { jar: 'agent' },
      timeout_ms: 8000,
    };
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  // A credential reference change is reported at its `jar`/`env`/`command` leaf,
  // because the ref merges field by field like every other object.
  expect(paths(diff.changes, 'hot')).toEqual([
    'telegram.decision_gate.api_key.jar',
    'telegram.decision_gate.base_url',
    'telegram.decision_gate.enabled',
    'telegram.decision_gate.history_messages',
    'telegram.decision_gate.instructions',
    'telegram.decision_gate.mode',
    'telegram.decision_gate.model',
    'telegram.decision_gate.pending_messages',
    'telegram.decision_gate.threshold',
    'telegram.decision_gate.timeout_ms',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  // The candidate keeps the new values: a hot field is published, not deferred.
  expect(diff.candidate.file.telegram?.decision_gate?.model).toBe('perplexity/pplx-decider-flash-v1.2');
});

test('adding the whole section is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.decision_gate = { enabled: true, api_key: { jar: 'telegram' } };
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.decision_gate']);
});

test('a supergroup Chat decision_gate override is hot, including on a negative id', async () => {
  const chatId = -1_001_234_567_890;
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats = [
        {
          id: chatId,
          instructions_file: 'chat-instructions.md',
          decision_gate: { mode: 'shadow', threshold: 0.57, history_messages: 10 },
        },
      ];
    },
    (config) => {
      config.telegram.chats[0]!.decision_gate = {
        mode: 'enforce',
        threshold: 0.7,
        history_messages: 4,
        pending_messages: 5,
        instructions: 'Should {{ bot.name }} answer this batch?',
      };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    `telegram.chats[${chatId}].decision_gate.history_messages`,
    `telegram.chats[${chatId}].decision_gate.instructions`,
    `telegram.chats[${chatId}].decision_gate.mode`,
    `telegram.chats[${chatId}].decision_gate.pending_messages`,
    `telegram.chats[${chatId}].decision_gate.threshold`,
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
});
