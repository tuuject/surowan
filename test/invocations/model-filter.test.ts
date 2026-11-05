import { expect, test } from 'vitest';
import { listInvocations } from '../../src/ingress/admin/audit/invocations.ts';
import { current, codeOf, ids, useInvocationSearchFixture } from './search-fixtures.ts';

/**
 * `listInvocations` model filter: it matches the model recorded on the
 * invocation's agent model calls, not the vision/auxiliary calls, and it is an
 * exact, case-sensitive comparison against the stored provider model id.
 */

useInvocationSearchFixture();

function insertModelCall(invocationId: bigint, role: string, model: string): void {
  current()
    .store.db.prepare(
      "INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, created_at) VALUES (?, ?, 'openrouter', ?, 1, 'success', ?)",
    )
    .run(invocationId, role, model, '2025-01-01T00:00:00.000Z');
}

test('vision and auxiliary calls never make an invocation match', () => {
  insertModelCall(401n, 'agent', 'deepseek/deepseek-v4-flash');
  insertModelCall(402n, 'vision_chat', 'openai/gpt-4.1-mini');
  insertModelCall(403n, 'vision_sticker', 'openai/gpt-4.1-mini');

  expect(ids({ model: 'openai/gpt-4.1-mini' })).toEqual([]);
  // An invocation without any agent call is invisible to the filter.
  expect(ids({ model: 'deepseek/deepseek-v4-flash' })).toEqual(['401']);
});

test('the filter is exact and case-sensitive, and composes with chat and state', () => {
  insertModelCall(401n, 'agent', 'openai/gpt-4.1-mini');
  insertModelCall(402n, 'agent', 'openai/gpt-4.1-mini');
  insertModelCall(403n, 'agent', 'openai/gpt-4.1-mini');

  expect(ids({ model: 'gpt-4.1-mini' })).toEqual([]);
  expect(ids({ model: 'openai/gpt-4.1' })).toEqual([]);
  expect(ids({ model: 'OpenAI/GPT-4.1-mini' })).toEqual([]);
  expect(ids({ model: 'openai/gpt-4.1-mini', chat: '-100222' })).toEqual(['403']);
  expect(ids({ model: 'openai/gpt-4.1-mini', chat: '-100222', state: 'failed' })).toEqual([]);
  expect(ids({ model: 'openai/gpt-4.1-mini', state: 'completed' })).toEqual(['403', '402', '401']);
});

test('an empty model parameter means no filter, and an oversized or control-character value is rejected', () => {
  insertModelCall(401n, 'agent', 'openai/gpt-4.1-mini');
  expect(ids({ model: '' })).toEqual(['405', '404', '403', '402', '401']);
  expect(ids({ model: null })).toEqual(['405', '404', '403', '402', '401']);

  expect(codeOf(() => listInvocations(current().store.orm, { model: 'a'.repeat(257) }))).toBe('invalid_model');
  expect(codeOf(() => listInvocations(current().store.orm, { model: '   ' }))).toBe('invalid_model');
  expect(codeOf(() => listInvocations(current().store.orm, { model: 'gpt\n4.1' }))).toBe('invalid_model');
});
