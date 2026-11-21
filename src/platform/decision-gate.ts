import type { DecisionGateChatConfig, DecisionGateConfig, FileChat } from './config/index.ts';

/**
 * The Decisions entry gate's configuration: the defaults, the per-Chat
 * resolution and the placeholder rendering. The runtime object that sends
 * requests lives in `src/orchestration/`; this module only answers "what are
 * the effective settings for this Chat".
 */

/** The two modes of the gate; `shadow` records decisions without acting on them. */
export type DecisionGateMode = 'shadow' | 'enforce';

export interface DecisionGateSettings {
  readonly enabled: boolean;
  readonly mode: DecisionGateMode;
  /** The P(yes) at or above which the batch reaches the main model. */
  readonly threshold: number;
  readonly history_messages: number;
  readonly pending_messages: number;
  readonly instructions: string;
  readonly model: string;
  readonly base_url: string;
  /** The unresolved reference: every decision resolves it again, so a rotated entry applies immediately. */
  readonly api_key: DecisionGateConfig['api_key'];
  readonly timeout_ms: number;
}

/**
 * The question the evaluation used. It is a yes/no question on purpose: the
 * verdict is `P(yes) >= threshold`, so a replacement text must keep "yes"
 * meaning "hand this batch to the main model". `state` carries the messages;
 * the instruction text never does.
 */
export const DECISION_GATE_DEFAULT_INSTRUCTIONS =
  'A group chat has an AI member named {{ bot.name }} (@{{ bot.username }}), described in `bot` and shown as `{{ bot.name }} [bot]`. `pending` holds the new messages since the bot last looked; `history` holds earlier messages. Would the bot, behaving like a friendly regular member, send a reply after reading `pending`?';

/**
 * Defaults for a configuration that never mentions `decision_gate`. The gate
 * stays off so upgrading a running deployment cannot change how often the bot
 * speaks, and `shadow` keeps even an enabled gate from withholding a batch
 * until an operator opts into `enforce`.
 */
export const DECISION_GATE_DEFAULTS = {
  enabled: false,
  mode: 'shadow',
  threshold: 0.57,
  history_messages: 10,
  pending_messages: 10,
  instructions: DECISION_GATE_DEFAULT_INSTRUCTIONS,
  model: 'typesafe/jev-1.14',
  base_url: 'https://openrouter.ai/api/alpha',
  timeout_ms: 3_000,
} as const;

export interface DecisionGateScope {
  readonly decision_gate?: DecisionGateConfig | undefined;
}

/**
 * Merges the global section with one Chat's overrides field by field, the way
 * `resolveProactiveReply` does. The connection fields are global only: a Chat
 * cannot point the gate at another endpoint or credential, so they are read
 * from the global section alone.
 */
export function resolveDecisionGate(
  config: DecisionGateScope,
  chat?: Pick<FileChat, 'decision_gate'>,
): DecisionGateSettings {
  const global: DecisionGateConfig | undefined = config.decision_gate;
  const local: DecisionGateChatConfig | undefined = chat?.decision_gate;
  return {
    enabled: local?.enabled ?? global?.enabled ?? DECISION_GATE_DEFAULTS.enabled,
    mode: local?.mode ?? global?.mode ?? DECISION_GATE_DEFAULTS.mode,
    threshold: local?.threshold ?? global?.threshold ?? DECISION_GATE_DEFAULTS.threshold,
    history_messages: local?.history_messages ?? global?.history_messages ?? DECISION_GATE_DEFAULTS.history_messages,
    pending_messages: local?.pending_messages ?? global?.pending_messages ?? DECISION_GATE_DEFAULTS.pending_messages,
    instructions: local?.instructions ?? global?.instructions ?? DECISION_GATE_DEFAULT_INSTRUCTIONS,
    model: global?.model ?? DECISION_GATE_DEFAULTS.model,
    base_url: global?.base_url ?? DECISION_GATE_DEFAULTS.base_url,
    api_key: global?.api_key,
    timeout_ms: global?.timeout_ms ?? DECISION_GATE_DEFAULTS.timeout_ms,
  };
}

/** The bot identity the default question names; read fresh from the live connection before each render. */
export interface DecisionGateBotIdentity {
  readonly name: string;
  readonly username: string;
}

// `prompt-template.ts` is not reusable here: it validates against a closed set
// of `agent.*`, `vision.*` and `timezone` keys and throws on anything else,
// while this template has its own two names and must never fail at runtime.
const DECISION_GATE_PLACEHOLDER = /\{\{\s*bot\.(name|username)\s*\}\}/g;

/**
 * Replaces the two placeholders of an instruction text. An unknown placeholder
 * is left as written instead of throwing: a mistyped template must not turn
 * into a failed request, and the literal text makes the mistake visible in the
 * decision row's request-free audit trail.
 */
export function renderDecisionGateInstructions(template: string, bot: DecisionGateBotIdentity): string {
  return template.replace(DECISION_GATE_PLACEHOLDER, (_match, field: 'name' | 'username') =>
    field === 'name' ? bot.name : bot.username,
  );
}
