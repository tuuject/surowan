import { describe, expect, test } from 'vitest';
import { draftOf, HARNESS_GROUPS, parseDraft } from './harness.ts';

const saved = {
  'daily_budget.max_tokens': 300_000,
  max_concurrency: 4,
  history_messages: 20,
  context_stop_ratio: 0.7,
  send_max_text_length: null,
  send_disallow_blank_lines: false,
  send_nudge_enabled: false,
  send_barrier_enabled: false,
  allow_reply_message_multiple_times: false,
  send_duplicate_guard_enabled: true,
  'rate_limits.sends_per_window': 6,
  'rate_limits.window_seconds': 300,
  'rate_limits.turns_per_injection': 8,
  'context.retained_sends_target': 2,
  'context.retained_sends_max': 3,
  'context.hard_token_ratio': 0.6,
  'context.ref_ttl_hours': 72,
  'context.idle_grace_seconds': 30,
  'context.max_wall_clock_seconds': 900,
  'context.agent_cache_size': 8,
  memory_ttl_warning_days: 30,
  'proactive_reply.enabled': false,
  'proactive_reply.base_probability': 0.2,
  'proactive_reply.increment': 0.1,
  'proactive_reply.hard_pity': 8,
};

describe('harness draft', () => {
  test('covers every field the API returns', () => {
    const keys = HARNESS_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
    expect(keys.toSorted()).toEqual(Object.keys(saved).toSorted());
  });

  test('an untouched draft has no changes and no errors', () => {
    expect(parseDraft(draftOf(saved), saved)).toEqual({ changes: {}, errors: {} });
  });

  test('reports only the values that differ, and an empty nullable field as null', () => {
    const draft = {
      ...draftOf({ ...saved, send_max_text_length: 2000 }),
      'context.ref_ttl_hours': ' 24 ',
      send_nudge_enabled: true,
      send_max_text_length: '',
    };
    expect(parseDraft(draft, { ...saved, send_max_text_length: 2000 })).toEqual({
      changes: { 'context.ref_ttl_hours': 24, send_nudge_enabled: true, send_max_text_length: null },
      errors: {},
    });
  });

  test('flags values outside the schema bounds', () => {
    const draft = {
      ...draftOf(saved),
      history_messages: '',
      max_concurrency: '1.5',
      context_stop_ratio: '0',
      'context.ref_ttl_hours': '721',
      'context.idle_grace_seconds': '-1',
      'rate_limits.window_seconds': 'abc',
      'proactive_reply.base_probability': '1.5',
      'proactive_reply.hard_pity': '0',
    };
    expect(parseDraft(draft, saved)).toEqual({
      changes: {},
      errors: {
        history_messages: { key: 'number' },
        max_concurrency: { key: 'integer' },
        context_stop_ratio: { key: 'greaterThan', limit: 0 },
        'context.ref_ttl_hours': { key: 'max', limit: 720 },
        'context.idle_grace_seconds': { key: 'min', limit: 0 },
        'rate_limits.window_seconds': { key: 'number' },
        'proactive_reply.base_probability': { key: 'max', limit: 1 },
        'proactive_reply.hard_pity': { key: 'min', limit: 1 },
      },
    });
  });
});
