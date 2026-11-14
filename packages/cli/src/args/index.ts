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
import type {
  CredentialSource,
  CredentialSources,
  ParsedCli,
  ResolvedCli,
  ResolvedCredential,
  StringFlags,
} from './types.ts';
import { parseEndpoint } from '../client.ts';
import { type Credentials, hasApiKey, validateApiKey } from '../credentials.ts';
import { usageError } from '../errors.ts';

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgsStrict(argv);
  const values = {
    endpoint: parsed.values.endpoint,
    apiKey: parsed.values['api-key'],
    timeout: parsed.values['timeout-ms'],
    json: parsed.values.json === true,
    help: parsed.values.help === true,
    flags: {
      'api-key-stdin': parsed.values['api-key-stdin'],
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
      days: parsed.values.days,
      q: parsed.values.q,
      unread: parsed.values.unread,
      enabled: parsed.values.enabled,
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
      'as-of': parsed.values['as-of'],
      state: parsed.values.state,
      chat: parsed.values.chat,
      search: parsed.values.search,
      at: parsed.values.at,
      from: parsed.values.from,
      to: parsed.values.to,
      'before-send': parsed.values['before-send'],
      'confirm-paid': parsed.values['confirm-paid'],
      code: parsed.values.code,
      force: parsed.values.force,
    } satisfies StringFlags,
  };
  return {
    help: values.help,
    json: values.json,
    command: values.help ? undefined : parseCommand(parsed.positionals, values.flags),
    endpointRaw: values.endpoint,
    apiKeyRaw: values.apiKey,
    timeoutRaw: values.timeout,
  };
}

export interface ResolvedConnection {
  readonly endpoint: URL;
  readonly credential: ResolvedCredential;
  readonly credentialSources: CredentialSources;
}

/**
 * Endpoint and credential resolution without a command, so `auth status` and
 * `auth permissions` apply exactly the same precedence and endpoint binding as
 * every other command.
 */
export function resolveConnection(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  saved?: Credentials,
): ResolvedConnection {
  const endpointRaw = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT ?? saved?.endpoint;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'run surowan-utils login or auth pair, or set --endpoint / SUROWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw);
  const explicitKey = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY;
  const endpointSource: CredentialSource =
    parsed.endpointRaw !== undefined ? 'argument' : env.SUROWAN_ENDPOINT !== undefined ? 'environment' : 'file';
  // A saved credential belongs to its saved endpoint. An endpoint override
  // alone must never send it to another service, even if both URLs use HTTPS.
  const savedMatches =
    saved !== undefined && explicitKey === undefined && parseEndpoint(saved.endpoint).href === endpoint.href;
  if (explicitKey !== undefined && explicitKey.length > 0) {
    return {
      endpoint,
      credential: { kind: 'api_key', apiKey: validateApiKey(explicitKey) },
      credentialSources: {
        endpoint: endpointSource,
        credential: parsed.apiKeyRaw !== undefined ? 'argument' : 'environment',
      },
    };
  }
  if (savedMatches && saved !== undefined) {
    return {
      endpoint,
      credential: hasApiKey(saved)
        ? { kind: 'api_key', apiKey: validateApiKey(saved.apiKey) }
        : { kind: 'client_signature', clientId: saved.client_id, instanceId: saved.instance_id },
      credentialSources: hasApiKey(saved)
        ? { endpoint: endpointSource, credential: 'file' }
        : { endpoint: endpointSource, credential: 'file', client_key: 'file' },
    };
  }
  throw usageError(
    'missing_credential',
    'run surowan-utils login or auth pair to store a credential, or set --api-key / SUROWAN_API_KEY',
  );
}

export function resolveCli(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  saved?: Credentials,
): ResolvedCli {
  const command = parsed.command;
  if (command === undefined) {
    throw usageError(
      'missing_command',
      'usage: surowan-utils login|auth|doctor|commands|models|config|prompt|invocation',
    );
  }
  if (command.kind === 'auth') {
    throw usageError('invalid_command', 'auth commands resolve their own credentials');
  }
  const connection = resolveConnection(parsed, env, saved);
  return {
    command,
    endpoint: connection.endpoint,
    credential: connection.credential,
    json: parsed.json,
    timeoutMs: parseTimeout(parsed.timeoutRaw, command.kind === 'replay'),
    credentialSources: connection.credentialSources,
  };
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
