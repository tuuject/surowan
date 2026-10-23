import { usageError } from '../errors.ts';
import {
  CONFIRM_PAID_FLAGS,
  INSPECTION_FLAGS,
  MODEL_FLAGS,
  PREFLIGHT_REJECTED_FLAGS,
  PROMPT_PART_FLAGS,
  TIME_FILTER_FLAGS,
} from './spec.ts';
import type {
  Command,
  ConfigShowCommand,
  FlagName,
  GetCommand,
  InvocationCommand,
  ListCommand,
  MediaCommand,
  PreflightCommand,
  PromptGetCommand,
  PromptsCommand,
  ReplayCommand,
  ReplayModelSelection,
  StringFlags,
} from './types.ts';
import {
  parseBeforeSend,
  parseDecimalId,
  parseLimit,
  parseSearch,
  parseSource,
  parseState,
  parseTimeFilter,
  parseVariant,
  validateTimeRange,
} from './values.ts';

/** Node's parse error can quote an `=value`; that value is never echoed back. */
export function sanitizeArgumentMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'invalid arguments';
  const sanitized = message.replace(/=([^\s'"]*)/g, '').trim();
  return sanitized.length > 0 ? sanitized : 'invalid arguments';
}

export function parseCommand(positionals: readonly string[], flags: StringFlags): Command {
  const [group, subcommand, ...rest] = positionals;
  if (group === undefined) {
    throw usageError('missing_command', 'usage: surowan-utils login|doctor|models|config|prompt|invocation');
  }
  if (group === 'login' || group === 'doctor') {
    if (positionals.length !== 1) {
      throw usageError('unexpected_argument', `${group} takes no positional arguments`);
    }
    rejectUnsupportedFlags(flags, [...INSPECTION_FLAGS, ...CONFIRM_PAID_FLAGS]);
    if (group === 'doctor') {
      rejectUnsupportedFlags(flags, ['api-key-stdin']);
      return { kind: 'doctor' };
    }
    return { kind: 'login', apiKeyStdin: flags['api-key-stdin'] === true };
  }
  rejectUnsupportedFlags(flags, ['api-key-stdin']);
  switch (group) {
    case 'models':
      if (subcommand === undefined) {
        throw usageError('missing_subcommand', 'usage: surowan-utils models list');
      }
      if (subcommand !== 'list') {
        throw usageError('unknown_subcommand', 'models subcommand must be list');
      }
      if (rest.length > 0) {
        throw usageError('unexpected_argument', 'models list takes no positional arguments');
      }
      rejectUnsupportedFlags(flags, [...INSPECTION_FLAGS, ...CONFIRM_PAID_FLAGS]);
      return { kind: 'models-list' };
    case 'config':
      return parseConfigShow(subcommand, rest, flags);
    case 'prompt':
      return parsePromptGet(subcommand, rest, flags);
    case 'invocation':
      return parseInvocation(subcommand, rest, flags);
    default:
      throw usageError('unknown_command', 'command must be login, doctor, models, config, prompt, or invocation');
  }
}

function parseConfigShow(
  subcommand: string | undefined,
  rest: readonly string[],
  flags: StringFlags,
): ConfigShowCommand {
  if (subcommand === undefined) {
    throw usageError('missing_subcommand', 'usage: surowan-utils config show');
  }
  if (subcommand !== 'show') {
    throw usageError('unknown_subcommand', 'config subcommand must be show');
  }
  if (rest.length > 0) {
    throw usageError('unexpected_argument', 'config show takes no positional arguments');
  }
  rejectUnsupportedFlags(flags, [
    ...MODEL_FLAGS,
    'limit',
    'cursor',
    'state',
    'chat',
    'variant',
    ...PROMPT_PART_FLAGS,
    ...TIME_FILTER_FLAGS,
    'before-send',
    ...CONFIRM_PAID_FLAGS,
  ]);
  return { kind: 'config-show', source: parseSource(flags.source) };
}

function parsePromptGet(subcommand: string | undefined, rest: readonly string[], flags: StringFlags): PromptGetCommand {
  if (subcommand === undefined) {
    throw usageError('missing_subcommand', 'usage: surowan-utils prompt get global|group');
  }
  if (subcommand !== 'get') {
    throw usageError('unknown_subcommand', 'prompt subcommand must be get');
  }
  const [scope, ...extra] = rest;
  if (scope !== 'global' && scope !== 'group') {
    throw usageError('unknown_subcommand', 'prompt get scope must be global or group');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'prompt get takes exactly one scope');
  }
  rejectUnsupportedFlags(flags, [
    ...MODEL_FLAGS,
    'limit',
    'cursor',
    'state',
    'variant',
    ...PROMPT_PART_FLAGS,
    ...TIME_FILTER_FLAGS,
    'before-send',
    ...CONFIRM_PAID_FLAGS,
  ]);
  const source = parseSource(flags.source);
  if (scope === 'global') {
    if (flags.chat !== undefined) {
      throw usageError('unexpected_option', '--chat is only valid for prompt get group');
    }
    return { kind: 'prompt-get', scope, chat: undefined, source };
  }
  if (flags.chat === undefined) {
    throw usageError('missing_argument', 'prompt get group requires --chat <telegram chat id>');
  }
  return { kind: 'prompt-get', scope, chat: parseDecimalId(flags.chat, 'chat', true), source };
}

function parseInvocation(
  subcommand: string | undefined,
  rest: readonly string[],
  flags: StringFlags,
): InvocationCommand {
  switch (subcommand) {
    case 'list':
      return parseList(rest, flags);
    case 'get':
      return parseGet(rest, flags);
    case 'prompts':
      return parseIdOnly('prompts', rest, flags);
    case 'preflight':
      return parseIdOnly('preflight', rest, flags);
    case 'media':
      return parseMedia(rest, flags);
    case 'replay':
      return parseReplay(rest, flags);
    case undefined:
      throw usageError('missing_subcommand', 'usage: surowan-utils invocation list|get|prompts|preflight|media|replay');
    default:
      throw usageError(
        'unknown_subcommand',
        'invocation subcommand must be list, get, prompts, preflight, media, or replay',
      );
  }
}

function parseList(rest: readonly string[], flags: StringFlags): ListCommand {
  if (rest.length > 0) {
    throw usageError('unexpected_argument', 'invocation list takes no positional arguments');
  }
  rejectUnsupportedFlags(flags, [
    ...MODEL_FLAGS,
    'source',
    'variant',
    ...PROMPT_PART_FLAGS,
    'before-send',
    ...CONFIRM_PAID_FLAGS,
  ]);
  const at = parseTimeFilter(flags.at, 'at');
  const from = parseTimeFilter(flags.from, 'from');
  const to = parseTimeFilter(flags.to, 'to');
  if (at !== undefined && (from !== undefined || to !== undefined)) {
    throw usageError('invalid_time_range', '--at cannot be combined with --from or --to');
  }
  validateTimeRange(from, to);
  return {
    kind: 'list',
    limit: flags.limit === undefined ? undefined : parseLimit(flags.limit),
    cursor: flags.cursor === undefined ? undefined : parseDecimalId(flags.cursor, 'cursor', false),
    state: flags.state === undefined ? undefined : parseState(flags.state),
    chat: flags.chat === undefined ? undefined : parseDecimalId(flags.chat, 'chat', true),
    search: parseSearch(flags.search),
    at,
    from,
    to,
  };
}

function parseGet(rest: readonly string[], flags: StringFlags): GetCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation get requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation get takes exactly one id');
  }
  rejectUnsupportedFlags(flags, [...INSPECTION_FLAGS, ...CONFIRM_PAID_FLAGS]);
  return { kind: 'get', id: parseDecimalId(id, 'id', false) };
}

function parseIdOnly(
  kind: 'prompts' | 'preflight',
  rest: readonly string[],
  flags: StringFlags,
): PromptsCommand | PreflightCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', `invocation ${kind} requires an invocation id`);
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', `invocation ${kind} takes exactly one id`);
  }
  if (kind === 'preflight') {
    rejectUnsupportedFlags(flags, [...PREFLIGHT_REJECTED_FLAGS, ...CONFIRM_PAID_FLAGS]);
    return {
      kind,
      id: parseDecimalId(id, 'id', false),
      beforeSendId: parseBeforeSend(flags['before-send']),
      ...parseReplayModel(flags),
    };
  }
  rejectUnsupportedFlags(flags, [...INSPECTION_FLAGS, ...CONFIRM_PAID_FLAGS]);
  return { kind, id: parseDecimalId(id, 'id', false) };
}

function parseMedia(rest: readonly string[], flags: StringFlags): MediaCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation media requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation media takes exactly one id');
  }
  rejectUnsupportedFlags(flags, [
    ...MODEL_FLAGS,
    'limit',
    'cursor',
    'state',
    'chat',
    'source',
    ...PROMPT_PART_FLAGS,
    ...TIME_FILTER_FLAGS,
    'before-send',
    ...CONFIRM_PAID_FLAGS,
  ]);
  return {
    kind: 'media',
    id: parseDecimalId(id, 'id', false),
    variant: parseVariant(flags.variant),
  };
}

function parseReplay(rest: readonly string[], flags: StringFlags): ReplayCommand {
  const [id, ...extra] = rest;
  if (id === undefined) {
    throw usageError('missing_argument', 'invocation replay requires an invocation id');
  }
  if (extra.length > 0) {
    throw usageError('unexpected_argument', 'invocation replay takes exactly one id');
  }
  rejectUnsupportedFlags(flags, ['limit', 'cursor', 'state', 'chat', 'source', 'variant', ...TIME_FILTER_FLAGS]);
  if (flags['global-prompt'] === '-' && flags['group-prompt'] === '-') {
    throw usageError('conflicting_prompt_input', 'only one of --global-prompt and --group-prompt can read from stdin');
  }
  const beforeSendId = parseBeforeSend(flags['before-send']);
  // A slice rebuilds a real window and replays it against the current model,
  // so it is billed; refuse it here — before any prompt read or HTTP request —
  // unless the operator explicitly acknowledged the cost. An unsliced replay
  // keeps its pre-existing behavior and never requires the flag.
  if (beforeSendId !== undefined && flags['confirm-paid'] !== true) {
    throw usageError(
      'confirm_paid_required',
      'invocation replay --before-send requires --confirm-paid to confirm the billed model call',
    );
  }
  return {
    kind: 'replay',
    id: parseDecimalId(id, 'id', false),
    globalPromptSource: flags['global-prompt'],
    groupPromptSource: flags['group-prompt'],
    beforeSendId,
    ...parseReplayModel(flags),
  };
}

function parseReplayModel(flags: StringFlags): ReplayModelSelection {
  if ((flags.provider === undefined) !== (flags.model === undefined)) {
    throw usageError('invalid_model_override', '--provider and --model must be supplied together');
  }
  for (const key of ['provider', 'model'] as const) {
    const value = flags[key];
    if (value !== undefined && (value.trim().length === 0 || value.length > 256 || /\p{Cc}/u.test(value))) {
      throw usageError('invalid_model_override', `${key} must be 1 to 256 characters without control characters`);
    }
  }
  const thinkingLevel = flags['thinking-level'];
  if (
    thinkingLevel !== undefined &&
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)
  ) {
    throw usageError('invalid_thinking_level', 'thinking-level must be off, minimal, low, medium, high, xhigh, or max');
  }
  return { provider: flags.provider, model: flags.model, thinkingLevel };
}

function rejectUnsupportedFlags(flags: StringFlags, unsupported: readonly FlagName[]): void {
  for (const key of unsupported) {
    if (flags[key] !== undefined) {
      throw usageError('unexpected_option', `--${key} is not valid for this subcommand`);
    }
  }
}
