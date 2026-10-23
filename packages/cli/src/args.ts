import { parseArgs } from 'node:util';
import { parseCommand, sanitizeArgumentMessage } from './args/commands.ts';
import {
  DEFAULT_REPLAY_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  NEGATIVE_NUMBER_PATTERN,
  NEGATIVE_VALUE_OPTIONS,
  OPTIONS,
  TIMEOUT_PATTERN,
} from './args/spec.ts';
import type { ParsedCli, ResolvedCli, StringFlags } from './args/types.ts';
import { parseEndpoint } from './client.ts';
import { type Credentials, validateApiKey } from './credentials.ts';
import { usageError } from './errors.ts';

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
    throw usageError('missing_command', 'usage: surowan-utils login|doctor|models|config|prompt|invocation');
  }
  const endpointRaw = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT ?? saved?.endpoint;
  if (endpointRaw === undefined || endpointRaw.trim().length === 0) {
    throw usageError('missing_endpoint', 'run surowan-utils login or set --endpoint / SUROWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw);
  const explicitKey = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY;
  // A saved key belongs to its saved endpoint. An endpoint override alone must
  // never send that key to another service, even if both URLs use HTTPS.
  const savedKey =
    saved !== undefined && parseEndpoint(saved.endpoint).href === endpoint.href ? saved.apiKey : undefined;
  const apiKey = explicitKey ?? savedKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw usageError('missing_api_key', 'run surowan-utils login or supply an API key for this endpoint');
  }
  return {
    command,
    endpoint,
    apiKey: validateApiKey(apiKey),
    json: parsed.json,
    timeoutMs: parseTimeout(parsed.timeoutRaw, command.kind === 'replay'),
    credentialSources: {
      endpoint:
        parsed.endpointRaw !== undefined ? 'argument' : env.SUROWAN_ENDPOINT !== undefined ? 'environment' : 'file',
      api_key: parsed.apiKeyRaw !== undefined ? 'argument' : env.SUROWAN_API_KEY !== undefined ? 'environment' : 'file',
    },
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
