import { GROUP_MEMORY_DEFAULT_IDLE_MINUTES } from '../../../src/context/group-memory/index.ts';
import {
  AGENT_DEFAULTS,
  BUCKET_TIMING_DEFAULTS,
  TELEGRAM_DEFAULTS,
  VISION_DEFAULTS,
} from '../../../src/platform/config/resolve.ts';
import { DECISION_GATE_DEFAULTS } from '../../../src/platform/decision-gate.ts';
import { MODELS_DEV_URL } from '../../../src/platform/models-dev.ts';
import { DEFAULT_ATTENTION_WINDOW_SECONDS } from '../../../src/platform/participation.ts';
import { PROACTIVE_REPLY_DEFAULTS } from '../../../src/platform/proactive-reply.ts';
import { WARNING_READ_RETENTION_DAYS } from '../../../src/platform/warning-catalog.ts';
import type { FieldsText } from './text.ts';

/**
 * One runtime default. A `value` is rendered as code (it is a JSON scalar an
 * operator could write), a `rule` as prose because the effective value depends on
 * another field or is a built-in text.
 */
export interface RuntimeDefault {
  readonly kind: 'value' | 'rule';
  readonly text: string;
  /**
   * Set when the default only exists while this whole section is absent. A
   * required field inside a present section has no default at all, so saying
   * "used when omitted" there would be wrong.
   */
  readonly absentSection?: string;
}

const value = (literal: unknown): RuntimeDefault => ({ kind: 'value', text: JSON.stringify(literal) });
const rule = (text: string): RuntimeDefault => ({ kind: 'rule', text });
/** For a field that is required inside its section: the value comes from a missing section. */
const valueWithoutSection = (section: string, literal: unknown): RuntimeDefault => ({
  kind: 'value',
  text: JSON.stringify(literal),
  absentSection: section,
});

/**
 * Values the running process uses when a field is absent, keyed by its plain
 * configuration path.
 *
 * Every number here is imported from the constant the runtime reads, never
 * copied: the reference and the behaviour then cannot disagree. A field whose
 * default is not one shared constant — a per-model rule, or a value each
 * consumer spells out itself — is deliberately absent, because a page claiming
 * a default is worse than a page that has none. The hand-written pages cover
 * those rules.
 */
export function runtimeDefaults(text: FieldsText): ReadonlyMap<string, RuntimeDefault> {
  return new Map<string, RuntimeDefault>([
    ['agent.daily_budget.max_tokens', value(AGENT_DEFAULTS.daily_budget.max_tokens)],
    ['agent.max_concurrency', value(AGENT_DEFAULTS.max_concurrency)],
    ['agent.context_stop_ratio', value(AGENT_DEFAULTS.context_stop_ratio)],
    ['agent.history_messages', value(AGENT_DEFAULTS.history_messages)],
    ['agent.send_empty_text_strategy', value(AGENT_DEFAULTS.send_empty_text_strategy)],
    ['agent.send_empty_text_fallback_texts', value(AGENT_DEFAULTS.send_empty_text_fallback_texts)],
    ['agent.context.retained_sends_target', value(AGENT_DEFAULTS.context.retained_sends_target)],
    ['agent.context.retained_sends_max', value(AGENT_DEFAULTS.context.retained_sends_max)],
    ['agent.context.hard_token_ratio', value(AGENT_DEFAULTS.context.hard_token_ratio)],
    ['agent.context.ref_ttl_hours', value(AGENT_DEFAULTS.context.ref_ttl_hours)],
    ['agent.context.idle_grace_seconds', value(AGENT_DEFAULTS.context.idle_grace_seconds)],
    ['agent.context.max_wall_clock_seconds', value(AGENT_DEFAULTS.context.max_wall_clock_seconds)],
    ['agent.context.agent_cache_size', value(AGENT_DEFAULTS.context.agent_cache_size)],
    ['agent.rate_limits.sends_per_window', value(AGENT_DEFAULTS.rate_limits.sends_per_window)],
    ['agent.rate_limits.window_seconds', value(AGENT_DEFAULTS.rate_limits.window_seconds)],
    ['agent.rate_limits.turns_per_injection', value(AGENT_DEFAULTS.rate_limits.turns_per_injection)],
    ['vision.max_output_tokens', value(VISION_DEFAULTS.max_output_tokens)],
    ['vision.max_concurrency', value(VISION_DEFAULTS.max_concurrency)],
    ['vision.prompt_version', value(VISION_DEFAULTS.prompt_version)],
    ['vision.daily_budget.max_tokens', value(VISION_DEFAULTS.daily_budget.max_tokens)],
    ['vision.daily_budget.max_images', value(VISION_DEFAULTS.daily_budget.max_images)],
    ['telegram.process_bot_messages', valueWithoutSection('telegram', TELEGRAM_DEFAULTS.process_bot_messages)],
    ['telegram.bucket_window_seconds', valueWithoutSection('telegram', TELEGRAM_DEFAULTS.bucket_window_seconds)],
    ['telegram.bucket_max_seconds', rule(text.bucketMaxDefault)],
    ['telegram.bucket_bump_seconds', value(BUCKET_TIMING_DEFAULTS.bucket_bump_seconds)],
    ['telegram.participation.attention_window_seconds', value(DEFAULT_ATTENTION_WINDOW_SECONDS)],
    ['telegram.proactive_reply.enabled', value(PROACTIVE_REPLY_DEFAULTS.enabled)],
    ['telegram.proactive_reply.base_probability', value(PROACTIVE_REPLY_DEFAULTS.base_probability)],
    ['telegram.proactive_reply.increment', value(PROACTIVE_REPLY_DEFAULTS.increment)],
    ['telegram.proactive_reply.hard_pity', value(PROACTIVE_REPLY_DEFAULTS.hard_pity)],
    ['telegram.decision_gate.enabled', value(DECISION_GATE_DEFAULTS.enabled)],
    ['telegram.decision_gate.mode', value(DECISION_GATE_DEFAULTS.mode)],
    ['telegram.decision_gate.threshold', value(DECISION_GATE_DEFAULTS.threshold)],
    ['telegram.decision_gate.history_messages', value(DECISION_GATE_DEFAULTS.history_messages)],
    ['telegram.decision_gate.pending_messages', value(DECISION_GATE_DEFAULTS.pending_messages)],
    ['telegram.decision_gate.instructions', rule(text.decisionInstructionsDefault)],
    ['telegram.decision_gate.model', value(DECISION_GATE_DEFAULTS.model)],
    ['telegram.decision_gate.base_url', value(DECISION_GATE_DEFAULTS.base_url)],
    ['telegram.decision_gate.timeout_ms', value(DECISION_GATE_DEFAULTS.timeout_ms)],
    ['telegram.chats[].group_memory.idle_minutes', value(GROUP_MEMORY_DEFAULT_IDLE_MINUTES)],
    ['retention.warning_read_days', value(WARNING_READ_RETENTION_DAYS)],
    ['models_dev.api_url', value(MODELS_DEV_URL)],
  ]);
}
