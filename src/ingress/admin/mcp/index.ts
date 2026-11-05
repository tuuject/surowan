import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Orm } from '../../../store/store.ts';
import type { SecretStore } from '../../../platform/secrets.ts';
import { authenticateApiKey } from '../api-keys.ts';
import { json } from '../http.ts';
import { TOOL_CATALOG, type ToolContext } from './tools.ts';
import { type SkillCatalog, directoryResources, loadSkillCatalog, skillEntry, skillFile } from './skills.ts';

const SERVER_NAME = 'surowan';
const SERVER_VERSION = '0.1.0';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const SKILL_EXTENSION = 'io.modelcontextprotocol/skills';
const CACHE_TTL_MS = 300_000;
const SKILL_ROOT = join(import.meta.dirname, '../../../../skills/surowan-mcp');

const skillsListSchema = z.object({
  method: z.literal('skills/list'),
  params: z
    .object({
      cursor: z.string().optional(),
      _meta: z.unknown().optional(),
    })
    .optional(),
});

const skillsGetSchema = z.object({
  method: z.literal('skills/get'),
  params: z.object({
    uri: z.string(),
    _meta: z.unknown().optional(),
  }),
});

const directoryReadSchema = z.object({
  method: z.literal('resources/directory/read'),
  params: z.object({
    uri: z.string(),
    cursor: z.string().optional(),
    _meta: z.unknown().optional(),
  }),
});

const discoverSchema = z.object({
  method: z.literal('server/discover'),
  params: z.object({ _meta: z.unknown().optional() }).optional(),
});

export interface McpEndpointDeps {
  readonly orm: Orm;
  readonly secrets: SecretStore | undefined;
  /** Sends one `/api` request back through AdminServer with the caller's key. */
  readonly callAdmin: (request: Request) => Promise<Response>;
  /** Override for tests; defaults to the repository's `skills/surowan-mcp`. */
  readonly skillRoot?: string;
}

interface Caller {
  readonly token: string;
  readonly context: ToolContext;
}

/**
 * Streamable HTTP MCP endpoint. It is dual-era: modern requests carry the
 * protocol version in `MCP-Protocol-Version`/`_meta` and are handled
 * statelessly here, while legacy `initialize` clients are delegated to the
 * SDK transport. Both share the same tool catalog and skill manifest.
 */
export class McpEndpoint {
  readonly #deps: McpEndpointDeps;
  #catalog: Promise<SkillCatalog> | undefined;

  constructor(deps: McpEndpointDeps) {
    this.#deps = deps;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json(
        { jsonrpc: '2.0', error: { code: ErrorCode.InvalidRequest, message: 'Use POST for MCP requests' }, id: null },
        405,
      );
    }
    const caller = this.#authenticate(request);
    if (caller === null) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: ErrorCode.InvalidRequest, message: 'A valid API key is required' },
          id: null,
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'www-authenticate': 'Bearer realm="surowan"',
            'cache-control': 'no-store',
          },
        },
      );
    }
    const payload = (await request
      .clone()
      .json()
      .catch(() => null)) as unknown;
    if (payload === null || typeof payload !== 'object') {
      return json({ jsonrpc: '2.0', error: { code: ErrorCode.ParseError, message: 'Invalid JSON' }, id: null }, 400);
    }
    const headerVersion = request.headers.get('mcp-protocol-version');
    const modern =
      headerVersion === MODERN_PROTOCOL_VERSION ||
      (headerVersion === null && metaProtocolVersion(payload) === MODERN_PROTOCOL_VERSION);
    if (modern) {
      return await this.#handleModern(payload, caller);
    }
    return await this.#handleLegacy(request, caller);
  }

  #authenticate(request: Request): Caller | null {
    const authorization = request.headers.get('authorization');
    if (authorization === null) {
      return null;
    }
    const scheme = 'Bearer ';
    if (authorization.slice(0, scheme.length).toLowerCase() !== scheme.toLowerCase()) {
      return null;
    }
    const token = authorization.slice(scheme.length).trim();
    const key = token.length === 0 ? null : authenticateApiKey(this.#deps.orm, token);
    if (key === null) {
      return null;
    }
    this.#deps.secrets?.remember(token);
    return {
      token,
      context: {
        permissions: key.permissions,
        mode: key.mode,
        token,
        callAdmin: this.#deps.callAdmin,
      },
    };
  }

  #skills(): Promise<SkillCatalog> {
    this.#catalog ??= loadSkillCatalog(this.#deps.skillRoot ?? SKILL_ROOT);
    return this.#catalog;
  }

  async #handleLegacy(request: Request, caller: Caller): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const server = await this.#createServer(caller);
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close().catch(() => undefined);
    }
  }

  async #createServer(caller: Caller): Promise<Server> {
    const catalog = await this.#skills();
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: {},
          resources: {},
          extensions: { [SKILL_EXTENSION]: { directoryRead: true } },
        },
        instructions: instructions(),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_CATALOG.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args =
        typeof request.params.arguments === 'object' && request.params.arguments !== null
          ? request.params.arguments
          : {};
      return await TOOL_CATALOG.call(request.params.name, args, caller.context);
    });
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: catalog.files.map((file) => ({
        uri: file.uri,
        name: file.relativePath,
        mimeType: file.mimeType,
      })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      const file = skillFile(catalog, request.params.uri);
      return { contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] };
    });
    server.setRequestHandler(skillsListSchema, () => ({
      resultType: 'complete',
      skills: catalog.entries,
      ttlMs: CACHE_TTL_MS,
      cacheScope: 'public',
    }));
    server.setRequestHandler(skillsGetSchema, (request) => ({
      resultType: 'complete',
      skill: skillEntry(catalog, request.params.uri),
      ttlMs: CACHE_TTL_MS,
      cacheScope: 'public',
    }));
    server.setRequestHandler(directoryReadSchema, (request) => ({
      resultType: 'complete',
      resources: directoryResources(catalog, request.params.uri),
      ttlMs: CACHE_TTL_MS,
      cacheScope: 'public',
    }));
    server.setRequestHandler(discoverSchema, () => discoverResult(catalog));
    return server;
  }

  async #handleModern(payload: object, caller: Caller): Promise<Response> {
    const request: {
      readonly jsonrpc?: unknown;
      readonly id?: unknown;
      readonly method?: unknown;
      readonly params?: unknown;
    } = payload;
    const id = request.id ?? null;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return jsonRpcError(id, ErrorCode.InvalidRequest, 'Invalid JSON-RPC request');
    }
    const catalog = await this.#skills();
    const params = typeof request.params === 'object' && request.params !== null ? request.params : {};
    try {
      switch (request.method) {
        case 'server/discover':
          return jsonRpcResult(id, discoverResult(catalog));
        case 'tools/list':
          return jsonRpcResult(id, {
            resultType: 'complete',
            tools: TOOL_CATALOG.tools,
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'private',
          });
        case 'tools/call': {
          const name = field(params, 'name');
          const args = field(params, 'arguments');
          if (typeof name !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'tools/call requires a tool name');
          }
          const result = await TOOL_CATALOG.call(
            name,
            typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
            caller.context,
          );
          return jsonRpcResult(id, { resultType: 'complete', ...result });
        }
        case 'resources/list':
          return jsonRpcResult(id, {
            resultType: 'complete',
            resources: catalog.files.map((file) => ({
              uri: file.uri,
              name: file.relativePath,
              mimeType: file.mimeType,
            })),
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'public',
          });
        case 'resources/read': {
          const uri = field(params, 'uri');
          if (typeof uri !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'resources/read requires a URI');
          }
          const file = skillFile(catalog, uri);
          return jsonRpcResult(id, {
            resultType: 'complete',
            contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }],
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'public',
          });
        }
        case 'resources/directory/read': {
          const uri = field(params, 'uri');
          if (typeof uri !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'resources/directory/read requires a URI');
          }
          return jsonRpcResult(id, {
            resultType: 'complete',
            resources: directoryResources(catalog, uri),
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'public',
          });
        }
        case 'skills/list':
          return jsonRpcResult(id, {
            resultType: 'complete',
            skills: catalog.entries,
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'public',
          });
        case 'skills/get': {
          const uri = field(params, 'uri');
          if (typeof uri !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'skills/get requires a URI');
          }
          return jsonRpcResult(id, {
            resultType: 'complete',
            skill: skillEntry(catalog, uri),
            ttlMs: CACHE_TTL_MS,
            cacheScope: 'public',
          });
        }
        case 'ping':
          return jsonRpcResult(id, { resultType: 'complete' });
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown method: ${request.method}`);
      }
    } catch (error) {
      if (error instanceof McpError) {
        return jsonRpcError(id, error.code, error.message);
      }
      return jsonRpcError(id, ErrorCode.InternalError, error instanceof Error ? error.message : 'MCP request failed');
    }
  }
}

function field(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function metaProtocolVersion(payload: object): string | null {
  if (!('params' in payload)) {
    return null;
  }
  const params = payload.params;
  if (typeof params !== 'object' || params === null || !('_meta' in params)) {
    return null;
  }
  const meta = params._meta;
  if (typeof meta !== 'object' || meta === null) {
    return null;
  }
  const key = 'io.modelcontextprotocol/protocolVersion';
  if (!(key in meta)) {
    return null;
  }
  const version = meta[key];
  return typeof version === 'string' ? version : null;
}

function discoverResult(catalog: SkillCatalog): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
    capabilities: {
      tools: {},
      resources: {},
      extensions: { [SKILL_EXTENSION]: { directoryRead: true } },
    },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    instructions: instructions(),
    ...(catalog.entries.length === 0 ? {} : { skills: catalog.entries.map((entry) => entry.uri) }),
    ttlMs: CACHE_TTL_MS,
    cacheScope: 'public',
  };
}

function instructions(): string {
  return [
    'Surowan Admin API over MCP. Tools are prefixed surowan_ and mirror Admin Panel endpoints; read the surowan-mcp skill at skill://surowan-mcp/SKILL.md before using them.',
    "Call surowan_key_show first to learn this key's mode. read routes are always available; write and paid routes require write_all and execute_paid_operations respectively, and write+paid routes need both.",
    'When a tool returns a permission error, stop and ask the user to enable the permission in Admin Panel → API keys. Never look for a bypass.',
    'Destructive and billed tools require confirm:true after explicit user approval. Use dry_run:true to inspect a request first.',
  ].join('\n');
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}
