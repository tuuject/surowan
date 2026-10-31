import type { TSchema } from 'typebox';
import Compile from 'typebox/compile';
import type { ConfigEdit } from '../../platform/config/write.ts';
import type { FileConfig, RawConfig } from '../../platform/config/index.ts';
import { PROACTIVE_REPLY_DEFAULTS } from '../../platform/proactive-reply.ts';
import { AdminQueryError } from './audit/shared.ts';
import { AGENT_DEFAULTS } from '../../platform/config/resolve.ts';
import { AgentSectionSchema, ProactiveReplySchema } from '../../platform/config/schema-sections.ts';

export type HarnessValue = number | boolean | null;

/** The configuration section a field lives in. */
type HarnessSection = 'agent' | 'telegram';

interface HarnessField {
  /** Dotted path below `section`, also the key the API uses. */
  readonly key: string;
  readonly section: HarnessSection;
  readonly validator: ReturnType<typeof Compile>;
  /** Present only for optional fields: what an absent field means, and `null` in a write removes it. */
  readonly absent?: HarnessValue;
}

const agent = AgentSectionSchema.properties;
const proactive = ProactiveReplySchema.properties;

function field(key: string, schema: TSchema, absent?: HarnessValue, section: HarnessSection = 'agent'): HarnessField {
  return { key, section, validator: Compile(schema), ...(absent === undefined ? {} : { absent }) };
}

/**
 * Every field the Harness page edits: the `agent` section, plus the global
 * proactive reply defaults under `telegram`. The model selection
 * (`provider`/`model`/`thinking_level`) lives on the Models page and the system
 * prompt on the Prompts page, so they are not repeated here. Each field reuses
 * its configuration schema, and the write is still validated as a whole file.
 * Every field is optional in the file: `null` in a write removes it, and the
 * absent value is the default the runtime resolves to.
 */
const HARNESS_FIELDS: readonly HarnessField[] = [
  field('daily_budget.max_tokens', agent.daily_budget.properties.max_tokens, AGENT_DEFAULTS.daily_budget.max_tokens),
  field('max_concurrency', agent.max_concurrency, AGENT_DEFAULTS.max_concurrency),
  field('context_stop_ratio', agent.context_stop_ratio, AGENT_DEFAULTS.context_stop_ratio),
  field('history_messages', agent.history_messages, AGENT_DEFAULTS.history_messages),
  field('send_max_text_length', agent.send_max_text_length, null),
  field('send_disallow_blank_lines', agent.send_disallow_blank_lines, false),
  field('send_nudge_enabled', agent.send_nudge_enabled, false),
  field('send_barrier_enabled', agent.send_barrier_enabled, false),
  field('allow_reply_message_multiple_times', agent.allow_reply_message_multiple_times, false),
  field('send_duplicate_guard_enabled', agent.send_duplicate_guard_enabled, true),
  field(
    'context.retained_sends_target',
    agent.context.properties.retained_sends_target,
    AGENT_DEFAULTS.context.retained_sends_target,
  ),
  field(
    'context.retained_sends_max',
    agent.context.properties.retained_sends_max,
    AGENT_DEFAULTS.context.retained_sends_max,
  ),
  field('context.hard_token_ratio', agent.context.properties.hard_token_ratio, AGENT_DEFAULTS.context.hard_token_ratio),
  field('context.ref_ttl_hours', agent.context.properties.ref_ttl_hours, AGENT_DEFAULTS.context.ref_ttl_hours),
  field(
    'context.idle_grace_seconds',
    agent.context.properties.idle_grace_seconds,
    AGENT_DEFAULTS.context.idle_grace_seconds,
  ),
  field(
    'context.max_wall_clock_seconds',
    agent.context.properties.max_wall_clock_seconds,
    AGENT_DEFAULTS.context.max_wall_clock_seconds,
  ),
  field('context.agent_cache_size', agent.context.properties.agent_cache_size, AGENT_DEFAULTS.context.agent_cache_size),
  field(
    'rate_limits.sends_per_window',
    agent.rate_limits.properties.sends_per_window,
    AGENT_DEFAULTS.rate_limits.sends_per_window,
  ),
  field(
    'rate_limits.window_seconds',
    agent.rate_limits.properties.window_seconds,
    AGENT_DEFAULTS.rate_limits.window_seconds,
  ),
  field(
    'rate_limits.turns_per_injection',
    agent.rate_limits.properties.turns_per_injection,
    AGENT_DEFAULTS.rate_limits.turns_per_injection,
  ),
  // Per-Chat overrides stay on the Chats page; these are the global defaults.
  field('proactive_reply.enabled', proactive.enabled, PROACTIVE_REPLY_DEFAULTS.enabled, 'telegram'),
  field(
    'proactive_reply.base_probability',
    proactive.base_probability,
    PROACTIVE_REPLY_DEFAULTS.base_probability,
    'telegram',
  ),
  field('proactive_reply.increment', proactive.increment, PROACTIVE_REPLY_DEFAULTS.increment, 'telegram'),
  field('proactive_reply.hard_pity', proactive.hard_pity, PROACTIVE_REPLY_DEFAULTS.hard_pity, 'telegram'),
];

const FIELDS_BY_KEY = new Map(HARNESS_FIELDS.map((entry) => [entry.key, entry]));

type HarnessValues = Record<string, HarnessValue>;

function rawValue(config: unknown, key: string): unknown {
  let value: unknown = config;
  for (const segment of key.split('.')) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[segment] : undefined;
  }
  return value;
}

/** The sections Harness reads; the file layer may leave `agent` absent or null. */
type HarnessSource = Pick<RawConfig, 'agent' | 'telegram'> | Pick<FileConfig, 'agent' | 'telegram'>;

/** Resolved values: an absent optional field reports the value the runtime uses for it. */
export function harnessValues(config: HarnessSource): HarnessValues {
  const values: HarnessValues = {};
  for (const entry of HARNESS_FIELDS) {
    const value = rawValue(config[entry.section], entry.key);
    values[entry.key] = value === undefined ? (entry.absent ?? null) : (value as HarnessValue);
  }
  return values;
}

export function harnessView(saved: HarnessSource, active: HarnessSource, revision: string) {
  return { revision, saved: harnessValues(saved), active: harnessValues(active) };
}

/** Parses `{ values: { <key>: value } }`; ranges come from the configuration schema. */
export function parseHarnessBody(body: Record<string, unknown>): ReadonlyMap<string, HarnessValue> {
  const values = body.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values) || Object.keys(body).length !== 1) {
    throw new AdminQueryError('invalid_body', 'Expected { values: { <field>: value } }');
  }
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length === 0) {
    throw new AdminQueryError('invalid_body', 'Provide at least one Harness field');
  }
  const parsed = new Map<string, HarnessValue>();
  for (const [key, value] of entries) {
    const entry = FIELDS_BY_KEY.get(key);
    if (entry === undefined) {
      throw new AdminQueryError('invalid_body', `Unknown Harness field: ${key}`);
    }
    if (value === null ? entry.absent === undefined : !entry.validator.Check(value)) {
      throw new AdminQueryError('invalid_harness_value', `Invalid value for ${entry.section}.${key}`);
    }
    parsed.set(key, value as HarnessValue);
  }
  return parsed;
}

/**
 * Turns requested values into file edits, skipping any that would not change
 * the file: a write with no change fails, and an optional field set to the value
 * it already means when absent stays absent. `null` removes an optional field.
 * `file` is the file layer, whose `agent` section may be absent or null entirely.
 */
export function harnessEdits(
  file: Pick<FileConfig, 'agent' | 'telegram'>,
  values: ReadonlyMap<string, HarnessValue>,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const [key, value] of values) {
    const entry = FIELDS_BY_KEY.get(key);
    if (entry === undefined) {
      continue;
    }
    const current = rawValue(file[entry.section], key);
    if (current === undefined ? value === null || value === entry.absent : current === value) {
      continue;
    }
    edits.push({ path: [entry.section, ...key.split('.')], value: value === null ? undefined : value });
  }
  return edits;
}
