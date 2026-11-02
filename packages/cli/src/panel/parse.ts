import { readFileSync } from 'node:fs';
import { isRecord } from '../client.ts';
import { usageError } from '../errors.ts';
import { findPanelSpec, panelCommandsStartingWith } from './specs/index.ts';
import type { EndpointSpec, PanelCommand, PositionalArg } from './types.ts';

/** A whole-document body is bounded so a stray large file cannot be sent by accident. */
export const MAX_BODY_BYTES = 1_048_576;

const DECIMAL_PATTERN = /^-?\d{1,19}$/;
const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;
const MIN_SIGNED_64 = -9_223_372_036_854_775_808n;

/** Raw flag values collected by the argument parser for a panel command. */
export interface PanelFlags {
  readonly sets: readonly string[];
  readonly setJson: readonly string[];
  readonly file: string | undefined;
  readonly body: string | undefined;
  readonly ifMatch: string | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly output: string | undefined;
  /** Every remaining `--flag value` pair, by name, for query forwarding. */
  readonly values: Readonly<Record<string, string | undefined>>;
  /** Names of every flag the caller set, including booleans, for rejection. */
  readonly present: readonly string[];
}

/**
 * Resolves the command words against the spec table, then the positionals and
 * flags against that row. Anything the row does not declare is rejected, so a
 * typo can never silently become a no-op request.
 */
export function parsePanelCommand(words: readonly string[], flags: PanelFlags): PanelCommand {
  const found = findPanelSpec(words);
  if (found === undefined) {
    const suggestions = panelCommandsStartingWith(words[0] ?? '');
    throw usageError(
      'unknown_command',
      suggestions.length === 0
        ? `unknown command: ${words.join(' ') || '(empty)'}; run surowan-utils commands`
        : `unknown command: ${words.join(' ')}; did you mean ${suggestions.join(', ')}?`,
    );
  }
  const { spec } = found;
  const positionals = parsePositionals(spec, found.rest);
  const query = parseQuery(spec, flags.values, flags.present);
  const body =
    spec.fixedBody !== undefined ? spec.fixedBody : spec.body === undefined ? undefined : buildBody(spec, flags);
  if (
    spec.body === undefined &&
    (flags.sets.length > 0 || flags.setJson.length > 0 || flags.body !== undefined || flags.file !== undefined)
  ) {
    throw usageError('unexpected_option', `${spec.command} takes no body; --set, --body and --file are invalid`);
  }
  for (const [field, clearCommand] of Object.entries(spec.nullClearedBy ?? {})) {
    if (isRecord(body) && body[field] === null) {
      throw usageError(
        'invalid_body',
        `${spec.command} cannot set ${field} to null; run ${clearCommand} (it requires --yes)`,
      );
    }
  }
  // Checked here, not after the response: a write that returns JSON would
  // otherwise take effect (or be billed) and then exit with a usage error.
  if (flags.output !== undefined && spec.response !== 'binary' && spec.response !== 'text') {
    throw usageError('unexpected_option', `${spec.command} returns JSON; --output is only valid for files and images`);
  }
  if (spec.confirm !== undefined && !flags.yes && !flags.dryRun) {
    throw usageError(
      'confirmation_required',
      `${spec.command} is ${spec.confirm === 'paid' ? 'billed' : 'destructive'}; re-run with --yes to proceed (or --dry-run to inspect the request)`,
    );
  }
  return {
    kind: 'panel',
    spec,
    positionals,
    query,
    body,
    ifMatch: flags.ifMatch,
    yes: flags.yes,
    dryRun: flags.dryRun,
    output: flags.output,
  };
}

function parsePositionals(spec: EndpointSpec, rest: readonly string[]): Readonly<Record<string, string>> {
  const declared = spec.positional ?? [];
  if (rest.length > declared.length) {
    throw usageError(
      'unexpected_argument',
      `${spec.command} takes ${declared.length} positional argument(s), got ${rest.length}`,
    );
  }
  const values: Record<string, string> = {};
  declared.forEach((arg: PositionalArg, index: number) => {
    const raw = rest[index];
    if (raw === undefined) {
      if (arg.optional === true) {
        return;
      }
      throw usageError('missing_argument', `${spec.command} requires <${arg.name}>`);
    }
    values[arg.name] = positionalValue(arg, raw);
  });
  return values;
}

function positionalValue(arg: PositionalArg, raw: string): string {
  if (arg.kind === 'decimal') {
    return parseDecimal(raw, arg.name);
  }
  if (arg.kind === 'enum') {
    const allowed = arg.values ?? [];
    if (!allowed.includes(raw)) {
      throw usageError(`invalid_${arg.name}`, `${arg.name} must be one of ${allowed.join(', ')}`);
    }
  }
  return raw;
}

function parseDecimal(raw: string, name: string): string {
  if (!DECIMAL_PATTERN.test(raw)) {
    throw usageError(`invalid_${name}`, `${name} must be a signed 64-bit decimal integer`);
  }
  const value = BigInt(raw);
  if (value > MAX_SIGNED_64 || value < MIN_SIGNED_64) {
    throw usageError(`invalid_${name}`, `${name} is out of signed 64-bit range`);
  }
  return value.toString();
}

function parseQuery(
  spec: EndpointSpec,
  values: Readonly<Record<string, string | undefined>>,
  present: readonly string[],
): Readonly<Record<string, string>> {
  const declared = new Map<string, string>();
  for (const entry of spec.params ?? []) {
    const [flag, queryKey] = entry.split('=');
    if (flag !== undefined) {
      declared.set(flag, queryKey ?? flag);
    }
  }
  const query: Record<string, string> = {};
  for (const key of present) {
    // Body and control flags are consumed by the parser, not forwarded.
    if (CONSUMED_FLAGS[key] === true) {
      continue;
    }
    const queryKey = declared.get(key);
    if (queryKey === undefined) {
      throw usageError('unexpected_option', `--${key} is not valid for ${spec.command}`);
    }
    const value = values[key];
    if (value !== undefined) {
      query[queryKey] = value;
    }
  }
  return query;
}

/** Flags every panel command understands, so they are never "unexpected". */
const CONSUMED_FLAGS: Readonly<Record<string, true>> = {
  set: true,
  'set-json': true,
  file: true,
  body: true,
  'if-match': true,
  yes: true,
  'dry-run': true,
  output: true,
};

/**
 * Bodies are assembled from `--set key=value` (string), `--set-json key=json`
 * (any JSON value), a whole `--body <json>` document, or `--file <path>`.
 * `--file` is read here so a missing or oversized file fails before any request.
 */
function buildBody(spec: EndpointSpec, flags: PanelFlags): unknown {
  if (flags.body !== undefined && flags.file !== undefined) {
    throw usageError('conflicting_body', '--body and --file cannot be combined');
  }
  const hasFields = flags.sets.length > 0 || flags.setJson.length > 0;
  if ((flags.body !== undefined || (flags.file !== undefined && spec.fileField === undefined)) && hasFields) {
    throw usageError('conflicting_body', '--set/--set-json cannot be combined with --body or --file');
  }
  if (flags.body !== undefined) {
    return parseJsonDocument(flags.body, '--body');
  }
  if (flags.file !== undefined && spec.fileField === undefined) {
    return readBodyFileSync(flags.file);
  }
  if (flags.file === undefined && !hasFields) {
    if (spec.body === 'optional') {
      return {};
    }
    throw usageError(
      'missing_body',
      `${spec.command} requires a body: use --set key=value, --set-json key=<json>, --body <json> or --file <path>`,
    );
  }
  const body: Record<string, unknown> = {};
  if (flags.file !== undefined && spec.fileField !== undefined) {
    // A prompt document is raw text, not JSON; it fills exactly one body field.
    body[spec.fileField] = readBodyText(flags.file);
  }
  for (const pair of flags.sets) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw usageError('invalid_set', `--set expects key=value, got "${pair}"`);
    }
    assign(body, pair.slice(0, separator), pair.slice(separator + 1), '--set');
  }
  for (const pair of flags.setJson) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw usageError('invalid_set', `--set-json expects key=<json>, got "${pair}"`);
    }
    assign(body, pair.slice(0, separator), parseJsonDocument(pair.slice(separator + 1), '--set-json'), '--set-json');
  }
  return body;
}

function assign(body: Record<string, unknown>, path: string, value: unknown, flag: string): void {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw usageError('invalid_set', `${flag} requires a non-empty key`);
  }
  let target: Record<string, unknown> = body;
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      target[segment] = created;
      target = created;
      continue;
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw usageError('invalid_set', `${flag} cannot nest ${path}: "${segment}" is already a value`);
    }
    target = next as Record<string, unknown>;
  }
  const leaf = segments.at(-1) ?? '';
  if (Object.hasOwn(target, leaf)) {
    throw usageError('invalid_set', `${flag} sets ${path} twice`);
  }
  target[leaf] = value;
}

/** Reads a raw text body (`--file <path|->`), bounded like a JSON body. */
function readBodyText(path: string): string {
  if (path === '-' && process.stdin.isTTY === true) {
    throw usageError('stdin_required', '--file - requires a piped document, not a terminal');
  }
  let text: string;
  try {
    text = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch {
    throw usageError('body_file_unreadable', `--file ${path} could not be read`);
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw usageError('body_too_large', `--file ${path} exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return text;
}

function parseJsonDocument(text: string, flag: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw usageError('invalid_json', `${flag} must be valid JSON`);
  }
  return parsed;
}

/**
 * A whole-document body from a file (or `-` for stdin) is parsed as JSON.
 * A secret supplied this way never appears in the process arguments.
 */
function readBodyFileSync(path: string): unknown {
  return parseJsonDocument(readBodyText(path), '--file');
}
