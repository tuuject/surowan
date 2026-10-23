import type { FlagName } from './types.ts';

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REPLAY_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;

export const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;
export const MIN_SIGNED_64 = -9_223_372_036_854_775_808n;
export const DECIMAL_PATTERN = /^\d{1,19}$/;
export const SIGNED_DECIMAL_PATTERN = /^-?\d{1,19}$/;
export const STATE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const TIMEOUT_PATTERN = /^\d{1,8}$/;

/** `YYYY-MM-DD[ |T]HH:mm[:ss[.1-3f]][Z|±HH:mm]`; the offset is optional. */
export const TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export const MAX_SEARCH_LENGTH = 100;

export const OPTIONS = {
  endpoint: { type: 'string' },
  'api-key': { type: 'string' },
  'api-key-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  state: { type: 'string' },
  chat: { type: 'string' },
  search: { type: 'string' },
  at: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  source: { type: 'string' },
  variant: { type: 'string' },
  'global-prompt': { type: 'string' },
  'group-prompt': { type: 'string' },
  'before-send': { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  'thinking-level': { type: 'string' },
  'confirm-paid': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

// Telegram chat ids are negative; parseArgs would read a separate `-123` token
// as a dangling option, so a negative numeric value is folded into `--opt=-123`.
export const NEGATIVE_NUMBER_PATTERN = /^-\d+$/;
export const NEGATIVE_VALUE_OPTIONS = new Set(['--chat', '--cursor', '--limit', '--timeout-ms', '--before-send']);

export const MODEL_FLAGS: readonly FlagName[] = ['provider', 'model', 'thinking-level'];
export const INSPECTION_FLAGS: readonly FlagName[] = [
  ...MODEL_FLAGS,
  'limit',
  'cursor',
  'state',
  'chat',
  'source',
  'variant',
  'global-prompt',
  'group-prompt',
  'search',
  'at',
  'from',
  'to',
  'before-send',
];
export const PROMPT_PART_FLAGS: readonly FlagName[] = ['global-prompt', 'group-prompt'];
/** `invocation list` time filters; every other subcommand rejects them. */
export const TIME_FILTER_FLAGS: readonly FlagName[] = ['search', 'at', 'from', 'to'];
/** Only `invocation preflight` and `invocation replay` accept `--before-send`. */
export const PREFLIGHT_REJECTED_FLAGS: readonly FlagName[] = INSPECTION_FLAGS.filter(
  (flag) => flag !== 'before-send' && !MODEL_FLAGS.includes(flag),
);
/**
 * Only `invocation replay` accepts `--confirm-paid`: a sliced replay
 * (`--before-send`) is a real, billed model call, so the acknowledgement is
 * meaningful nowhere else — every read-only subcommand rejects it, and the
 * replay itself refuses a slice without it before any prompt read or request.
 */
export const CONFIRM_PAID_FLAGS: readonly FlagName[] = ['confirm-paid'];
