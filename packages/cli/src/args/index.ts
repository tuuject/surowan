import { parseArgs } from 'node:util';
import { parseCommand, sanitizeArgumentMessage } from './commands.ts';
import {
  DEFAULT_REPLAY_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  NEGATIVE_NUMBER_PATTERN,
  NEGATIVE_VALUE_OPTIONS,
  OPTIONS,
  TIMEOUT_PATTERN,
} from './spec.ts';
import type { Command, ParsedCli, ResolvedCli, StringFlags } from './types.ts';
import { parseEndpoint } from '../client.ts';
import { type Credentials, validateApiKey, validateSessionToken } from '../credentials.ts';
import { usageError } from '../errors.ts';

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgsStrict(argv);
  const values = {
    endpoint: parsed.values.endpoint,
    apiKey: parsed.values['api-key'],
    session: parsed.values.session,
    timeout: parsed.values['timeout-ms'],
    json: parsed.values.json === true,
    help: parsed.values.help === true,
    flags: {
      'api-key-stdin': parsed.values['api-key-stdin'],
      'password-stdin': parsed.values['password-stdin'],
      username: parsed.values.username,
      password: parsed.values.password,
      session: parsed.values.session,
      'if-match': parsed.values['if-match'],
      'dry-run': parsed.values['dry-run'],
      yes: parsed.values.yes,
      file: parsed.values.file,
      body: parsed.values.body,
      set: parsed.values.set,
      'set-json': parsed.values['set-json'],
      format: parsed.values.format,
      output: parsed.values.output,
      offset: parsed.values.offset,
      q: parsed.values.q,
      unread: parsed.values.unread,
      host: parsed.values.host,
      target: parsed.values.target,
      day: parsed.values.day,
      before: parsed.values.before,
      scope: parsed.values.scope,
      'sticker-set': parsed.values['sticker-set'],
      provider: parsed.values.provider,
      model: parsed.values.model,
      'thinking-level': parsed.values['thinking-level'],
      source: parsed.values.source,
      variant: parsed.values.variant,
      'global-prompt': parsed.values['global-prompt'],
      'group-prompt': parsed.values['group-prompt'],
      limit: parsed.values.limit,
      cursor: parsed.values.cursor,
      state: parsed.values.state,
      chat: parsed.values.chat,
      search: parsed.values.search,
      at: parsed.values.at,
      from: parsed.values.from,
      to: parsed.values.to,
      'before-send': parsed.values['before-send'],
      'confirm-paid': parsed.values['confirm-paid'],
    } satisfies StringFlags,
  };
  return {
    help: values.help,
    json: values.json,
    command: values.help ? undefined : parseCommand(parsed.positionals, values.flags),
    endpointRaw: values.endpoint,
    apiKeyRaw: values.apiKey,
    sessionRaw: values.session,
    timeoutRaw: values.timeout,
  };
}

export function resolveCli(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  saved?: Credentials,
): ResolvedCli {
  const command = parsed.command;
  if (command === undefined) {
    throw usageError('missing_command', 'usage: surowan-utils login|doctor|commands|models|config|prompt|invocation');
  }
  const endpointRaw = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT ?? saved?.endpoint;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'run surowan-utils login or set --endpoint / SUROWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw);
  const argumentKey = parsed.apiKeyRaw;
  const argumentSession = parsed.sessionRaw;
  const explicitKey = argumentKey ?? env.SUROWAN_API_KEY;
  const explicitSession = argumentSession ?? env.SUROWAN_SESSION;
  if (explicitKey !== undefined && explicitSession !== undefined) {
    throw usageError(
      'conflicting_credentials',
      'supply either an API key or a session token, not both; they authorize different surfaces',
    );
  }
  // A saved credential belongs to its saved endpoint. An endpoint override
  // alone must never send it to another service, even if both URLs use HTTPS.
  const savedMatches = saved !== undefined && parseEndpoint(saved.endpoint).href === endpoint.href;
  const savedKey = savedMatches ? saved.apiKey : undefined;
  const savedSession = savedMatches ? saved.session : undefined;
  const apiKey = explicitKey ?? (explicitSession === undefined ? savedKey : undefined);
  const session = explicitSession ?? (explicitKey === undefined ? savedSession : undefined);
  const withoutCredential =
    (apiKey === undefined || apiKey.length === 0) && (session === undefined || session.length === 0);
  if (withoutCredential && !isPreSessionCommand(command)) {
    throw usageError(
      'missing_credential',
      'run surowan-utils login (panel login for the full surface, API key for inspection) or set --api-key / --session',
    );
  }
  return {
    command,
    endpoint,
    apiKey: apiKey === undefined || apiKey.length === 0 ? undefined : validateApiKey(apiKey),
    session: session === undefined || session.length === 0 ? undefined : validateSessionToken(session),
    json: parsed.json,
    timeoutMs: parseTimeout(parsed.timeoutRaw, command.kind === 'replay'),
    credentialSources: {
      endpoint:
        parsed.endpointRaw !== undefined ? 'argument' : env.SUROWAN_ENDPOINT !== undefined ? 'environment' : 'file',
      credential:
        argumentKey !== undefined || argumentSession !== undefined
          ? 'argument'
          : env.SUROWAN_API_KEY !== undefined || env.SUROWAN_SESSION !== undefined
            ? 'environment'
            : 'file',
    },
  };
}

/**
 * `setup` and `session show` are the two panel routes that answer before any
 * credential exists: setup creates the first account, and the session view
 * reports whether setup is still required.
 */
function isPreSessionCommand(command: Command): boolean {
  if (command.kind !== 'panel') {
    return false;
  }
  return command.spec.path === 'auth/setup' || command.spec.path === 'auth/session';
}

function parseArgsStrict(argv: readonly string[]) {
  try {
    return parseArgs({ args: normalizeArgv(argv), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError('invalid_arguments', sanitizeArgumentMessage(error));
  }
}

function normalizeArgv(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    const next = argv[index + 1];
    if (NEGATIVE_VALUE_OPTIONS.has(token) && next !== undefined && NEGATIVE_NUMBER_PATTERN.test(next)) {
      normalized.push(`${token}=${next}`);
      index += 1;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

export function parseTimeout(text: string | undefined, replay: boolean): number {
  if (text === undefined) {
    return replay ? DEFAULT_REPLAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  }
  if (!TIMEOUT_PATTERN.test(text)) {
    throw usageError('invalid_timeout', `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  const timeout = Number(text);
  if (timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw usageError('invalid_timeout', `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  return timeout;
}
