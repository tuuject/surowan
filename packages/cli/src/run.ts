import process from 'node:process';
import { parseCli, parseTimeout, resolveCli } from './args/index.ts';
import type { Command, FirstClassCommand, ParsedCli } from './args/types.ts';
import { AdminClient, isRecord, parseEndpoint } from './client.ts';
import { type CliIo, executeCommand, listWindow } from './commands.ts';
import { credentialsPath, readCredentials, writeCredentials } from './credentials.ts';
import { CliError, usageError } from './errors.ts';
import { readLoginKey } from './login.ts';
import { runPanelCommand } from './panel/run.ts';
import { PANEL_SPECS } from './panel/specs/index.ts';
import { USAGE } from './usage.ts';

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly io?: CliIo;
  readonly homeDir?: string;
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const secrets: Array<string | undefined> = [env.SUROWAN_API_KEY, ...argumentKeys(argv)];
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const path = credentialsPath(options.homeDir);
    if (parsed.command?.kind === 'login') {
      return await login(parsed, env, io, path, secrets);
    }
    if (parsed.command?.kind === 'commands-list') {
      io.stdout(renderCommands(parsed.json));
      return 0;
    }
    const explicitEndpoint = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT;
    const explicitCredential = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY;
    // With both an endpoint and a credential supplied, the file is never
    // consulted, so a damaged or foreign file cannot block the command.
    const saved =
      explicitEndpoint !== undefined && explicitCredential !== undefined ? undefined : await readCredentials(path);
    secrets.push(saved?.apiKey);
    const resolved = resolveCli(parsed, env, saved);
    secrets.push(resolved.apiKey);
    const client = new AdminClient({
      baseUrl: resolved.endpoint,
      ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
      defaultTimeoutMs: resolved.timeoutMs,
    });
    // JSON-aware redaction decodes each string token, so it only fits a body
    // that is JSON: a panel text export (CSV/JSONL) is raw bytes, and rewriting
    // its quoted cells as JSON fails on any cell holding a backslash.
    const output = redactingIo(io, secrets, emitsJsonDocument(resolved.command, resolved.json));
    if (resolved.command.kind === 'doctor') {
      const identity = await client.get('api/key');
      if (!isRecord(identity) || typeof identity.mode !== 'string' || !isRecord(identity.permissions)) {
        throw new CliError('invalid_response', 'doctor expected an API key permission response');
      }
      const raw = await client.get('api/invocations', new URLSearchParams({ limit: '1' }));
      if (!isRecord(raw) || !Array.isArray(raw.items) || listWindow(raw) === null) {
        throw new CliError('invalid_response', 'doctor expected an invocation list response from the Admin API');
      }
      const result = {
        status: 'ok',
        endpoint: resolved.endpoint.href,
        credential: client.credentialKind,
        mode: identity.mode,
        permissions: identity.permissions,
        credential_sources: resolved.credentialSources,
      };
      output.stdout(
        resolved.json
          ? `${JSON.stringify(result)}\n`
          : `Login is valid; Admin API connection and authentication succeeded (${resolved.endpoint.href}).\n`,
      );
      return 0;
    }
    if (resolved.command.kind === 'login') {
      throw usageError('invalid_command', 'login cannot execute an invocation request');
    }
    if (resolved.command.kind === 'panel') {
      return await runPanelCommand(
        resolved.command,
        {
          json: resolved.json,
          io: output,
          timeoutMs: resolved.timeoutMs,
          redact: (text) => redactSecrets(text, secrets),
        },
        client,
      );
    }
    return await executeCommand(
      assertFirstClass(resolved.command),
      {
        json: resolved.json,
        io: output,
        timeoutMs: resolved.timeoutMs,
        redact: (text) => redactSecrets(text, secrets),
      },
      client,
    );
  } catch (error) {
    return reportError(error, io, secrets);
  }
}

async function login(
  parsed: ParsedCli,
  env: Record<string, string | undefined>,
  io: CliIo,
  path: string,
  secrets: Array<string | undefined>,
): Promise<number> {
  if (parsed.command?.kind !== 'login') {
    throw usageError('invalid_command', 'expected login');
  }
  const timeoutMs = parseTimeout(parsed.timeoutRaw, false);
  const endpointRaw = parsed.endpointRaw ?? env.SUROWAN_ENDPOINT;
  if (endpointRaw === undefined) {
    throw usageError('missing_endpoint', 'login requires --endpoint <url> or SUROWAN_ENDPOINT');
  }
  const endpoint = parseEndpoint(endpointRaw).href;
  let apiKey = parsed.apiKeyRaw ?? env.SUROWAN_API_KEY;
  if (parsed.command.apiKeyStdin && apiKey !== undefined) {
    throw usageError('conflicting_key_input', '--api-key-stdin cannot be combined with --api-key or SUROWAN_API_KEY');
  }
  if (parsed.command.apiKeyStdin) {
    apiKey = await readLoginKey(timeoutMs);
  }
  if (apiKey === undefined) {
    throw usageError('missing_argument', 'login requires --api-key, --api-key-stdin or SUROWAN_API_KEY');
  }
  secrets.push(apiKey);
  await writeCredentials(path, { endpoint, apiKey });
  const output = redactingIo(io, secrets, parsed.json);
  output.stdout(
    parsed.json
      ? `${JSON.stringify({ status: 'saved', endpoint, credential: 'api_key', credentials_file: path })}\n`
      : 'API key saved. Run surowan-utils doctor to verify connection and authentication.\n',
  );
  return 0;
}

/**
 * Whether stdout carries a JSON document, which is what lets the redactor
 * rewrite string tokens in place. A panel text export without `--json` prints
 * raw bytes instead, so it needs the plain whole-text redaction.
 */
function emitsJsonDocument(command: Command, json: boolean): boolean {
  if (command.kind === 'panel' && command.spec.response === 'text' && command.output === undefined && !json) {
    return false;
  }
  return json || command.kind !== 'list';
}

function renderCommands(json: boolean): string {
  if (json) {
    return `${JSON.stringify(
      PANEL_SPECS.map((spec) => ({
        command: spec.command,
        method: spec.method,
        path: `/api/${spec.path}`,
        revision: spec.revision ?? null,
        confirm: spec.confirm ?? null,
        summary: spec.summary,
      })),
    )}\n`;
  }
  const width = Math.max(...PANEL_SPECS.map((spec) => spec.command.length));
  return `${PANEL_SPECS.map((spec) => `${spec.command.padEnd(width)}  ${spec.method.padEnd(6)} ${spec.summary}`).join(
    '\n',
  )}\n`;
}

/**
 * `runCli` handles `login`, `commands` and every panel route before reaching
 * this point; the assertion keeps the compiler honest about the remainder.
 */
function assertFirstClass(command: Command): FirstClassCommand {
  if (
    command.kind === 'panel' ||
    command.kind === 'commands-list' ||
    command.kind === 'login' ||
    command.kind === 'doctor'
  ) {
    throw usageError('invalid_command', `${command.kind} is not an Admin API command`);
  }
  return command;
}

/** parseArgs can fail before ParsedCli exists; retain even raw key flags for redaction. */
function argumentKeys(argv: readonly string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith('--api-key=')) {
      keys.push(token.slice('--api-key='.length));
    } else if (token === '--api-key' && argv[index + 1] !== undefined) {
      keys.push(argv[index + 1] ?? '');
    }
  }
  return keys;
}

/** Redact JSON string tokens without touching structural quotes, braces or numbers. */
function redactingIo(io: CliIo, secrets: readonly (string | undefined)[], jsonOutput: boolean): CliIo {
  return {
    stdout: (text) =>
      io.stdout(
        jsonOutput
          ? text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
              JSON.stringify(redactSecrets(JSON.parse(token) as string, secrets)),
            )
          : redactSecrets(text, secrets),
      ),
    stderr: (text) => io.stderr(redactSecrets(text, secrets)),
  };
}

function reportError(error: unknown, io: CliIo, secrets: readonly (string | undefined)[]): number {
  const cli = error instanceof CliError ? error : undefined;
  // A server-provided error string becomes the CliError code; it is just as
  // capable of echoing the key as the message is.
  const code = redactSecrets(cli?.code ?? 'internal_error', secrets);
  const rawMessage = cli?.message ?? (error instanceof Error ? error.message : 'unexpected failure');
  io.stderr(`${JSON.stringify({ error: code, message: redactSecrets(rawMessage, secrets) })}\n`);
  return cli?.exitCode ?? 1;
}

/**
 * The API key must never appear in output, even if a server echoes it back.
 * Also used for files the CLI persists (the media manifest), so both stdout and
 * on-disk metadata share one redaction contract.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    // Replace the JSON-escaped form first: inside a JSON document that is the
    // form actually written, and an escaped match cannot cut through a
    // structural quote (a raw match on a key ending in `\` can).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) {
      redacted = redacted.split(escaped).join('[redacted]');
    }
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
