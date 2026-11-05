import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import type { AdminClient } from '../client.ts';
import { isRecord } from '../client.ts';
import type { CommandContext } from '../commands.ts';
import { CliError, usageError } from '../errors.ts';
import type { EndpointSpec, PanelCommand, RevisionKind } from './types.ts';

/**
 * An export or an image is bounded so a wrong route cannot fill memory. The
 * panel's own image uploads are capped at 30 MB, so this covers a download of
 * anything it produced.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Runs one panel command: resolves the optimistic-concurrency value the route
 * requires, fills the path, sends the request and renders the response.
 *
 * The CLI never caches a revision across commands. Each write reads the current
 * one immediately before writing, so an operator who edited `config.jsonc` in
 * the last minute gets a `config_conflict` instead of silently overwriting it.
 * `--if-match` pins a value explicitly, which is what a caller with a stale
 * snapshot wants when it deliberately retries.
 */
export async function runPanelCommand(
  command: PanelCommand,
  context: CommandContext,
  client: AdminClient,
): Promise<number> {
  const { spec } = command;
  const path = fillPath(spec, command.positionals);
  const query = new URLSearchParams(command.query);

  if (command.dryRun) {
    // A dry run issues no request at all, so it does not discover the revision
    // either; the preview reports where the value would come from instead.
    const preview = {
      method: spec.method,
      path: `/api/${path}${query.size === 0 ? '' : `?${query.toString()}`}`,
      if_match: command.ifMatch ?? null,
      if_match_source: command.ifMatch === undefined ? (spec.revision ?? null) : 'argument',
      body: command.body === undefined ? null : command.body,
    };
    context.io.stdout(context.json ? `${JSON.stringify(preview)}\n` : `${JSON.stringify(preview, null, 2)}\n`);
    return 0;
  }

  const ifMatch = await resolveRevision(spec, command, client);

  const options = {
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(spec.origin === true ? { sendOrigin: true } : {}),
  };
  const raw =
    spec.response === 'binary' || spec.response === 'text'
      ? await rawResponse(client, `api/${path}`, query, options, spec)
      : await client.request(spec.method, `api/${path}`, query, command.body, options);
  await writeOutput(raw, spec, command, context);
  return 0;
}

/** A file or image response: bounded, and decoded only when the type is text. */
async function rawResponse(
  client: AdminClient,
  path: string,
  query: URLSearchParams,
  options: { readonly ifMatch?: string },
  spec: EndpointSpec,
): Promise<unknown> {
  const content = await client.getRaw(path, query, { ...options, maxBytes: MAX_RESPONSE_BYTES });
  if (spec.response === 'binary') {
    return content.bytes;
  }
  if (!content.isText) {
    throw new CliError(
      'invalid_response',
      `${spec.command} expected a text body but received ${content.contentType ?? 'an unknown content type'}`,
    );
  }
  return content.bytes.toString('utf8');
}

function fillPath(spec: EndpointSpec, positionals: Readonly<Record<string, string>>): string {
  return spec.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = positionals[name];
    if (value === undefined) {
      throw usageError('missing_argument', `${spec.command} requires <${name}>`);
    }
    // Provider aliases and model ids may contain `/`, so each segment is encoded.
    return encodeURIComponent(value);
  });
}

/**
 * The revision a write must carry. `entry` revisions belong to a row the caller
 * read itself, so they cannot be discovered and must be supplied.
 */
async function resolveRevision(
  spec: EndpointSpec,
  command: PanelCommand,
  client: AdminClient,
): Promise<string | undefined> {
  const kind: RevisionKind | undefined = spec.revision;
  if (kind === undefined) {
    if (command.ifMatch !== undefined) {
      throw usageError('unexpected_option', `${spec.command} does not use --if-match`);
    }
    return undefined;
  }
  if (command.ifMatch !== undefined) {
    return command.ifMatch;
  }
  if (kind === 'entry') {
    throw usageError(
      'if_match_required',
      `${spec.command} needs --if-match <revision> from the entry you read; the CLI cannot guess a row revision`,
    );
  }
  if (kind === 'config') {
    return await configRevision(client);
  }
  return await promptRevision(client, spec, command);
}

/** `GET /api/providers` reports the SHA-256 of the configuration file it read. */
export async function configRevision(client: AdminClient): Promise<string> {
  const raw = await client.get('api/providers');
  if (!isRecord(raw) || typeof raw.revision !== 'string' || raw.revision.length === 0) {
    throw new CliError('invalid_response', 'the providers view did not report a configuration revision');
  }
  return raw.revision;
}

/**
 * A prompt write is pinned by the prompt's own content hash. `prompt save`
 * names its scope positionally; `prompt restore` inherits the scope and, for a
 * group version, the Chat of the version it restores, which the CLI reads first.
 */
async function promptRevision(client: AdminClient, spec: EndpointSpec, command: PanelCommand): Promise<string> {
  if (spec.command === 'prompt restore') {
    const versionId = command.positionals.id;
    const version = await client.get(`api/prompts/versions/${encodeURIComponent(versionId ?? '')}`);
    if (!isRecord(version) || typeof version.scope !== 'string' || typeof version.content_hash !== 'string') {
      throw new CliError('invalid_response', 'the prompt version did not report its scope and content hash');
    }
    let chat: string | undefined;
    if (version.scope === 'group') {
      if (typeof version.chat_id !== 'string') {
        throw new CliError('invalid_response', 'the group prompt version did not report its chat');
      }
      chat = version.chat_id;
    }
    return await promptContentHash(client, version.scope, chat);
  }
  const scope = command.positionals.scope;
  if (scope !== 'global' && scope !== 'group') {
    throw usageError('unknown_subcommand', 'prompt scope must be global or group');
  }
  return await promptContentHash(client, scope, command.query.chat);
}

async function promptContentHash(client: AdminClient, scope: string, chat: string | undefined): Promise<string> {
  const query = new URLSearchParams({ source: 'file' });
  if (scope === 'group') {
    if (chat === undefined) {
      throw usageError('missing_argument', '--chat is required to write a group prompt');
    }
    query.set('chat', chat);
  }
  const raw = await client.get(`api/prompts/${scope}`, query);
  if (!isRecord(raw) || typeof raw.content_hash !== 'string' || raw.content_hash.length === 0) {
    throw new CliError('invalid_response', 'the prompt view did not report a content hash');
  }
  return raw.content_hash;
}

/**
 * Renders the response. `--output` writes binary bodies to a file instead of
 * stdout, and a text body is written verbatim so an export stays byte-exact.
 */
async function writeOutput(
  raw: unknown,
  spec: EndpointSpec,
  command: PanelCommand,
  context: CommandContext,
): Promise<void> {
  if (command.output !== undefined) {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
      throw usageError('unexpected_option', `${spec.command} has no bytes to write; --output is not valid`);
    }
    await writeFile(command.output, raw);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
    const report = { status: 'saved', path: command.output, bytes: bytes.byteLength };
    context.io.stdout(
      context.json ? `${JSON.stringify(report)}\n` : `Saved ${report.bytes} bytes to ${command.output}\n`,
    );
    return;
  }
  if (typeof raw === 'string') {
    // `--json` promises exactly one JSON document on stdout, so a text body is
    // encoded as a JSON string rather than emitting two formats in one stream.
    context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : raw.endsWith('\n') ? raw : `${raw}\n`);
    return;
  }
  if (Buffer.isBuffer(raw)) {
    throw usageError('output_required', `${spec.command} returns bytes; pass --output <path>`);
  }
  context.io.stdout(context.json ? `${JSON.stringify(raw)}\n` : `${JSON.stringify(raw, null, 2)}\n`);
}
