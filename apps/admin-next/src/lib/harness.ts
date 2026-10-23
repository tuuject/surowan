import type { HarnessValues } from './api/config.ts';

/**
 * Field metadata for the Harness page. The bounds mirror the configuration
 * schema so the form can flag a typo before the round trip; the server still
 * validates every value, and cross-field rules (such as the retained-sends
 * pair) only there, against the whole file.
 */
export interface HarnessField {
  /** Dotted path below `section`, the API key. */
  readonly key: string;
  /** The configuration section the field lives in; `agent` when absent. */
  readonly section?: 'telegram';
  readonly kind: 'integer' | 'ratio' | 'boolean';
  readonly min?: number;
  /** Ratios exclude their lower bound. */
  readonly exclusiveMin?: number;
  readonly max?: number;
  /** An empty input removes the field (`null`), meaning "no limit". */
  readonly nullable?: boolean;
}

export interface HarnessGroup {
  readonly id: 'budget' | 'send' | 'rateLimits' | 'context' | 'memory' | 'proactiveReply';
  readonly fields: readonly HarnessField[];
}

export const HARNESS_GROUPS: readonly HarnessGroup[] = [
  {
    id: 'budget',
    fields: [
      { key: 'daily_budget.max_tokens', kind: 'integer', min: 1 },
      { key: 'max_concurrency', kind: 'integer', min: 1 },
      { key: 'history_messages', kind: 'integer', min: 1 },
      { key: 'context_stop_ratio', kind: 'ratio', exclusiveMin: 0, max: 0.8 },
    ],
  },
  {
    id: 'send',
    fields: [
      { key: 'send_max_text_length', kind: 'integer', min: 1, max: 4096, nullable: true },
      { key: 'send_disallow_blank_lines', kind: 'boolean' },
      { key: 'send_nudge_enabled', kind: 'boolean' },
      { key: 'send_barrier_enabled', kind: 'boolean' },
      { key: 'allow_reply_message_multiple_times', kind: 'boolean' },
      { key: 'send_duplicate_guard_enabled', kind: 'boolean' },
    ],
  },
  {
    id: 'rateLimits',
    fields: [
      { key: 'rate_limits.sends_per_window', kind: 'integer', min: 1, max: 100 },
      { key: 'rate_limits.window_seconds', kind: 'integer', min: 1, max: 86_400 },
      { key: 'rate_limits.turns_per_injection', kind: 'integer', min: 1, max: 100 },
    ],
  },
  {
    id: 'context',
    fields: [
      { key: 'context.retained_sends_target', kind: 'integer', min: 1 },
      { key: 'context.retained_sends_max', kind: 'integer', min: 2 },
      { key: 'context.hard_token_ratio', kind: 'ratio', exclusiveMin: 0, max: 0.8 },
      { key: 'context.ref_ttl_hours', kind: 'integer', min: 1, max: 720 },
      { key: 'context.idle_grace_seconds', kind: 'integer', min: 0, max: 3_600 },
      { key: 'context.max_wall_clock_seconds', kind: 'integer', min: 1, max: 86_400 },
      { key: 'context.agent_cache_size', kind: 'integer', min: 1, max: 1_024 },
    ],
  },
  {
    id: 'memory',
    fields: [{ key: 'memory_ttl_warning_days', kind: 'integer', min: 1 }],
  },
  {
    id: 'proactiveReply',
    fields: [
      { key: 'proactive_reply.enabled', section: 'telegram', kind: 'boolean' },
      { key: 'proactive_reply.base_probability', section: 'telegram', kind: 'ratio', min: 0, max: 1 },
      { key: 'proactive_reply.increment', section: 'telegram', kind: 'ratio', min: 0, max: 1 },
      { key: 'proactive_reply.hard_pity', section: 'telegram', kind: 'integer', min: 1, max: 100 },
    ],
  },
];

const FIELDS = HARNESS_GROUPS.flatMap((group) => group.fields);

/** Numbers are edited as text so a half-typed value is not coerced away. */
export type DraftValue = string | boolean;

export interface DraftError {
  /** Key below `harness.errors`. */
  readonly key: 'integer' | 'number' | 'min' | 'max' | 'greaterThan';
  readonly limit?: number;
}

export function draftOf(saved: HarnessValues): Record<string, DraftValue> {
  const draft: Record<string, DraftValue> = {};
  for (const field of FIELDS) {
    const value = saved[field.key];
    draft[field.key] =
      field.kind === 'boolean' ? value === true : value === null || value === undefined ? '' : String(value);
  }
  return draft;
}

function parseNumber(field: HarnessField, text: string): number | null | DraftError {
  const trimmed = text.trim();
  if (trimmed === '') {
    return field.nullable === true ? null : { key: 'number' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { key: 'number' };
  }
  if (field.kind === 'integer' && !Number.isInteger(value)) {
    return { key: 'integer' };
  }
  if (field.min !== undefined && value < field.min) {
    return { key: 'min', limit: field.min };
  }
  if (field.exclusiveMin !== undefined && value <= field.exclusiveMin) {
    return { key: 'greaterThan', limit: field.exclusiveMin };
  }
  if (field.max !== undefined && value > field.max) {
    return { key: 'max', limit: field.max };
  }
  return value;
}

/** Splits a draft into the values that differ from the saved file and the fields that do not parse. */
export function parseDraft(
  draft: Readonly<Record<string, DraftValue>>,
  saved: HarnessValues,
): { readonly changes: Record<string, number | boolean | null>; readonly errors: Record<string, DraftError> } {
  const changes: Record<string, number | boolean | null> = {};
  const errors: Record<string, DraftError> = {};
  for (const field of FIELDS) {
    const raw = draft[field.key];
    if (raw === undefined) {
      continue;
    }
    const value = typeof raw === 'boolean' ? raw : parseNumber(field, raw);
    if (typeof value === 'object' && value !== null) {
      errors[field.key] = value;
      continue;
    }
    if (value !== (saved[field.key] ?? null)) {
      changes[field.key] = value;
    }
  }
  return { changes, errors };
}
