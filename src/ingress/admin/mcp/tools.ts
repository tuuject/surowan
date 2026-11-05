import { Buffer } from 'node:buffer';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { EndpointSpec } from '@surowan/admin-surface';
import { ADMIN_SURFACE_SPECS, specAccess, specIsMcpExposed } from '@surowan/admin-surface';
import type { ApiKeyPermissions } from '../api-keys.ts';
import { accessAllowed } from '../api-keys.ts';

const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const TOOL_NAME_MAX = 64;

export interface ToolContext {
  readonly permissions: ApiKeyPermissions;
  readonly mode: string;
  /** Sends one request back through the Admin API with the caller's key. */
  readonly callAdmin: (request: Request) => Promise<Response>;
  readonly token: string;
  /** The MCP caller's cancellation; billed routes stop when the client goes away. */
  readonly signal: AbortSignal;
}

interface CatalogEntry {
  readonly tool: Tool;
  readonly spec: EndpointSpec;
}

export interface ToolCatalog {
  readonly tools: readonly Tool[];
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ToolContext,
  ) => Promise<CallToolResult>;
}

function toolName(command: string): string {
  const base = `surowan_${command
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()}`;
  return base.length <= TOOL_NAME_MAX ? base : base.slice(0, TOOL_NAME_MAX).replace(/_+$/g, '');
}

function queryMappings(spec: EndpointSpec): Readonly<Record<string, string>> {
  const mappings: Record<string, string> = {};
  for (const entry of spec.params ?? []) {
    const [flag, key] = entry.split('=');
    if (flag !== undefined) {
      mappings[key ?? flag] = flag;
    }
  }
  return mappings;
}

function inputSchema(spec: EndpointSpec): Tool['inputSchema'] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const arg of spec.positional ?? []) {
    properties[arg.name] = {
      type: 'string',
      description: `${arg.kind === 'decimal' ? 'Decimal integer' : 'Path'} parameter ${arg.name}`,
      ...(arg.kind === 'enum' && arg.values !== undefined ? { enum: arg.values } : {}),
    };
    if (arg.optional !== true) {
      required.push(arg.name);
    }
  }
  for (const key of Object.keys(queryMappings(spec))) {
    properties[key] = { type: 'string', description: `Query parameter ${key}` };
  }
  if (spec.body === true || spec.body === 'optional') {
    properties.body = {
      type: 'object',
      description: 'JSON request body; fields are validated by the Admin API',
      additionalProperties: true,
    };
    if (spec.body === true) {
      required.push('body');
    }
  }
  if (spec.revision !== undefined) {
    properties.if_match = {
      type: 'string',
      description:
        spec.revision === 'config'
          ? 'Configuration revision. Omit to read the current revision before writing.'
          : 'Revision from the entry or prompt you read; required for this route.',
    };
    if (spec.revision !== 'config') {
      required.push('if_match');
    }
  }
  if (spec.confirm !== undefined) {
    properties.confirm = {
      type: 'boolean',
      description: 'Set true only after the user explicitly approved this destructive or billed operation.',
    };
    required.push('confirm');
  }
  properties.dry_run = {
    type: 'boolean',
    description: 'Return the request that would be sent without sending it.',
  };
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function annotations(spec: EndpointSpec): Tool['annotations'] {
  const access = specAccess(spec);
  return {
    readOnlyHint: access === 'read',
    destructiveHint: spec.confirm === 'destructive',
    idempotentHint: spec.method === 'GET',
    openWorldHint: access === 'paid' || access === 'write+paid',
  };
}

function buildCatalog(): ToolCatalog {
  const used = new Set<string>();
  const entries = new Map<string, CatalogEntry>();
  for (const spec of ADMIN_SURFACE_SPECS) {
    if (!specIsMcpExposed(spec)) {
      continue;
    }
    let name = toolName(spec.command);
    let suffix = 2;
    while (used.has(name)) {
      name = `${toolName(spec.command).slice(0, TOOL_NAME_MAX - 3)}_${suffix}`;
      suffix += 1;
    }
    used.add(name);
    entries.set(name, {
      spec,
      tool: {
        name,
        description: `${spec.summary} (${spec.method} /api/${spec.path}; ${specAccess(spec)} permission)`,
        inputSchema: inputSchema(spec),
        annotations: annotations(spec),
      },
    });
  }
  return {
    tools: [...entries.values()].map((entry) => entry.tool),
    async call(name, args, context) {
      const entry = entries.get(name);
      if (entry === undefined) {
        return toolError(`Unknown tool: ${name}`);
      }
      return await callTool(entry.spec, args, context);
    },
  };
}

export const TOOL_CATALOG = buildCatalog();

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function stringArg(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function fillPath(spec: EndpointSpec, args: Readonly<Record<string, unknown>>): string | null {
  let path = spec.path;
  for (const arg of spec.positional ?? []) {
    const value = stringArg(args, arg.name);
    if (value === undefined) {
      if (arg.optional === true) {
        continue;
      }
      return null;
    }
    if (arg.kind === 'decimal' && !/^-?\d{1,19}$/.test(value)) {
      return null;
    }
    path = path.replace(`:${arg.name}`, encodeURIComponent(value));
  }
  return path;
}

function fillQuery(spec: EndpointSpec, args: Readonly<Record<string, unknown>>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, flag] of Object.entries(queryMappings(spec))) {
    const value = stringArg(args, key) ?? stringArg(args, flag);
    if (value !== undefined && value.length > 0) {
      query.set(key, value);
    }
  }
  return query;
}

async function configRevision(context: ToolContext): Promise<string | null> {
  const response = await context.callAdmin(
    new Request('http://surowan.local/api/providers', {
      headers: { authorization: `Bearer ${context.token}` },
      signal: context.signal,
    }),
  );
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (typeof body !== 'object' || body === null || !('revision' in body)) {
    return null;
  }
  const revision = body.revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

async function resolveIfMatch(
  spec: EndpointSpec,
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<string | null> {
  const supplied = stringArg(args, 'if_match');
  if (supplied !== undefined) {
    return supplied;
  }
  if (spec.revision === 'config') {
    return await configRevision(context);
  }
  return null;
}

async function callTool(
  spec: EndpointSpec,
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<CallToolResult> {
  const access = specAccess(spec);
  if (!accessAllowed(context.permissions, access)) {
    return toolError(
      `Permission denied: this API key has mode "${context.mode}" and lacks ${access} permission. Ask the user to open Admin Panel → API keys and enable it; do not retry or find another route.`,
    );
  }
  if (spec.confirm !== undefined && args.confirm !== true && args.dry_run !== true) {
    return toolError(
      `This operation is ${spec.confirm === 'paid' ? 'billed' : 'destructive'}. Explain the target and effect to the user, obtain explicit approval, then call again with confirm: true.`,
    );
  }
  const path = fillPath(spec, args);
  if (path === null) {
    return toolError('Missing or invalid path parameter.');
  }
  const query = fillQuery(spec, args);
  let body: unknown;
  if (spec.fixedBody !== undefined) {
    body = spec.fixedBody;
  } else if (spec.body !== undefined) {
    body = args.body;
    if (body === undefined && spec.body === true) {
      return toolError('This tool requires a JSON body.');
    }
  }
  // The same guard as the CLI: a `null` here would delete data behind the
  // confirmation that the dedicated clear tool demands.
  for (const [field, clearCommand] of Object.entries(spec.nullClearedBy ?? {})) {
    if (typeof body === 'object' && body !== null && Reflect.get(body, field) === null) {
      return toolError(
        `This tool cannot set ${field} to null. Use ${toolName(clearCommand)} with confirm: true after the user approves the deletion.`,
      );
    }
  }
  const target = `/api/${path}${query.size === 0 ? '' : `?${query.toString()}`}`;
  if (args.dry_run === true) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              method: spec.method,
              path: target,
              if_match: stringArg(args, 'if_match') ?? null,
              if_match_source: spec.revision ?? null,
              body: body ?? null,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const ifMatch = spec.revision === undefined ? null : await resolveIfMatch(spec, args, context);
  if (spec.revision !== undefined && ifMatch === null) {
    return toolError(
      spec.revision === 'config'
        ? 'Could not read the current configuration revision; retry after reading the configuration.'
        : 'This route requires if_match from the entry or prompt you read.',
    );
  }
  const headers: Record<string, string> = { authorization: `Bearer ${context.token}` };
  if (ifMatch !== null) {
    headers['if-match'] = ifMatch;
  }
  let requestBody: string | undefined;
  if (body !== undefined) {
    requestBody = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const response = await context.callAdmin(
    new Request(`http://surowan.local${target}`, {
      method: spec.method,
      headers,
      signal: context.signal,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    }),
  );
  return await toResult(response, spec, target);
}

async function toResult(response: Response, spec: EndpointSpec, target: string): Promise<CallToolResult> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const text = await response.text();
    return {
      isError: true,
      content: [{ type: 'text', text: `HTTP ${response.status}: ${text.slice(0, 32_768)}` }],
    };
  }
  const textual = contentType.startsWith('text/') || spec.response === 'text';
  if (!textual && (spec.response === 'binary' || !contentType.includes('json'))) {
    return await binaryResult(response, contentType, target);
  }
  const text = await response.text();
  if (textual) {
    return { content: [{ type: 'text', text }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { content: [{ type: 'text', text }] };
  }
  const pretty = JSON.stringify(parsed, null, 2);
  const structured =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: 'text', text: pretty }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

/** Media bytes are never decoded as text: images inline, everything else as a base64 blob. */
async function binaryResult(response: Response, contentType: string, target: string): Promise<CallToolResult> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_BINARY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return toolError(`The file is larger than ${MAX_BINARY_BYTES} bytes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BINARY_BYTES) {
    return toolError(`The file is larger than ${MAX_BINARY_BYTES} bytes.`);
  }
  const mimeType = contentType.split(';')[0]?.trim() || 'application/octet-stream';
  const data = bytes.toString('base64');
  if (mimeType.startsWith('image/')) {
    return {
      content: [
        { type: 'image', data, mimeType },
        { type: 'text', text: `Image returned by ${target}.` },
      ],
    };
  }
  return {
    content: [
      { type: 'resource', resource: { uri: `surowan://admin${target}`, mimeType, blob: data } },
      { type: 'text', text: `${mimeType} file (${bytes.byteLength} bytes) returned by ${target}.` },
    ],
  };
}
