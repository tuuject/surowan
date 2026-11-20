/**
 * The MCP servers page's writes: add a streamable HTTP server, edit the fields
 * the panel may own, and delete any server once no Chat binds it.
 *
 * Every write reuses the configuration's own schemas and semantics: a submitted
 * server is assembled into the exact file shape, validated against a candidate
 * configuration with `validateSemantics`, and only then handed to the reloader's
 * write-and-apply path. The panel never writes stdio connections — a `command`
 * or `env` is an arbitrary program on the host, which belongs in `config.jsonc`
 * under the operator's hands, not behind a panel form.
 */
import Type from 'typebox';
import Compile from 'typebox/compile';
import type { FileConfig, McpServerConfig, SecretRef } from '../../../platform/config/index.ts';
import { validateSemantics } from '../../../platform/config/semantics.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import type { ConfigEdit, KeychainReplacement } from '../../../platform/config/write.ts';
import { AdminQueryError } from '../audit/shared.ts';
import { redactedUrl } from './read.ts';
import type { CallerClass, KeychainUsageForInput } from '../secret-input.ts';
import { SecretAllocator } from '../secret-input.ts';
import { readHeaderInputs, resolveHeaders } from './headers.ts';
import {
  AliasBodySchema,
  DefaultToolPolicySchema,
  HEADER_NAME_MAX_LENGTH,
  invalid,
  McpExposureSchema,
  McpServerDescriptionSchema,
  McpToolsBodySchema,
  ToolPolicySchema,
  URL_MAX_LENGTH,
} from './shared.ts';

/** What one submitted server write turns into. */
export interface ParsedMcpServerWrite {
  /** Empty when nothing changed: no file write, no keychain change. */
  readonly edits: readonly ConfigEdit[];
  /** New keychain entries the edit references. */
  readonly keys: Readonly<Record<string, string>>;
  /** Dangling references the submitted values repair. */
  readonly repairs: Readonly<Record<string, string>>;
  /** In-place rotations with the file path that justifies each. */
  readonly replacements: readonly KeychainReplacement[];
}

/** `tool_policies: null` removes the field; omitted keeps what the file has. */
const PoliciesField = Type.Optional(Type.Union([Type.Array(ToolPolicySchema), Type.Null()]));
const DefaultPolicyField = Type.Optional(Type.Union([DefaultToolPolicySchema, Type.Null()]));
/**
 * `description: null`, `""` or blank removes it; omitted keeps what the file
 * has. The empty string is accepted here (the file never stores one) so every
 * spelling of "no description" means the same thing.
 */
const DescriptionField = Type.Optional(Type.Union([McpServerDescriptionSchema, Type.Literal(''), Type.Null()]));

const CreateBodySchema = Type.Object(
  {
    alias: AliasBodySchema,
    // Accepted only so a stdio submission gets the clear refusal below instead
    // of a generic unknown-field error.
    transport: Type.Optional(Type.Union([Type.Literal('stdio'), Type.Literal('streamable_http')])),
    url: Type.String({ minLength: 1, maxLength: URL_MAX_LENGTH }),
    headers: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: HEADER_NAME_MAX_LENGTH }), Type.Unknown()),
    ),
    tools: McpToolsBodySchema,
    payload_max_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    result_max_bytes: Type.Integer({ minimum: 1, maximum: 32_768 }),
    tool_policies: PoliciesField,
    default_tool_policy: DefaultPolicyField,
    exposure: Type.Optional(McpExposureSchema),
    description: DescriptionField,
    skills: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const createValidator = Compile(CreateBodySchema);

const EditBodySchema = Type.Object(
  {
    transport: Type.Optional(Type.Union([Type.Literal('stdio'), Type.Literal('streamable_http')])),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: URL_MAX_LENGTH })),
    headers: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: HEADER_NAME_MAX_LENGTH }), Type.Unknown()),
    ),
    // Omitted keeps what the file has, so a description or exposure change can
    // travel alone (`mcp-server update <alias> --set exposure=progressive`).
    tools: Type.Optional(McpToolsBodySchema),
    payload_max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_048_576 })),
    result_max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_768 })),
    tool_policies: PoliciesField,
    default_tool_policy: DefaultPolicyField,
    exposure: Type.Optional(McpExposureSchema),
    description: DescriptionField,
    skills: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const editValidator = Compile(EditBodySchema);

function fileServers(file: FileConfig): readonly McpServerConfig[] {
  return file.mcp?.servers ?? [];
}

/** The deployment's registered search providers, as `validateSemantics` needs them. */
export type SearchProviders = readonly SearchProviderRule[];

/**
 * The candidate the write would publish, checked with the file's own semantics
 * so the panel answers 400 with the actual rule instead of a failed apply. The
 * deployment's own search providers take part: a `web_search` section that
 * references a plugin-registered provider is valid there and invalid under the
 * built-in catalog alone.
 */
function assertCandidate(file: FileConfig, servers: readonly McpServerConfig[], providers: SearchProviders): void {
  const candidate: FileConfig = { ...file, mcp: { servers: [...servers] } };
  try {
    validateSemantics(candidate, { searchProviders: providers });
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The policy fields the request states, resolved against the current entry:
 * omitted keeps, `null` removes, an array replaces. The caller spreads the
 * result onto a base that already had both fields stripped, so a removal
 * cannot be swallowed by the base's own value.
 */
function policyFields(
  body: {
    readonly tool_policies?:
      | { readonly name: string; readonly read_only: boolean; readonly timeout_seconds: number }[]
      | null;
    readonly default_tool_policy?: { readonly read_only: boolean; readonly timeout_seconds: number } | null;
  },
  current: McpServerConfig,
) {
  const policies =
    body.tool_policies === undefined
      ? current.tool_policies
      : body.tool_policies === null
        ? undefined
        : body.tool_policies;
  const defaultPolicy =
    body.default_tool_policy === undefined
      ? current.default_tool_policy
      : body.default_tool_policy === null
        ? undefined
        : body.default_tool_policy;
  return {
    ...(policies === undefined ? {} : { tool_policies: policies }),
    ...(defaultPolicy === undefined ? {} : { default_tool_policy: defaultPolicy }),
  };
}

/**
 * `exposure`, `description` and `skills` as the request states them: omitted
 * keeps the file's value, `direct` and `skills: true` drop the field (they are
 * the defaults), `null` or a blank description removes it. Spread onto a base
 * without any of the three fields.
 */
function presentationFields(
  body: {
    readonly exposure?: 'direct' | 'progressive';
    readonly description?: string | null;
    readonly skills?: boolean;
  },
  current: McpServerConfig | undefined,
) {
  const exposure = body.exposure === undefined ? current?.exposure : body.exposure;
  const description = body.description === undefined ? current?.description : (body.description?.trim() ?? undefined);
  const skills = body.skills === undefined ? current?.skills : body.skills;
  return {
    ...(exposure === undefined || (body.exposure === 'direct' && exposure === 'direct') ? {} : { exposure }),
    ...(description === undefined || description.length === 0 ? {} : { description }),
    ...(skills === undefined || (body.skills === true && skills) ? {} : { skills }),
  };
}

/** Whether the fields the panel owns actually moved. */
function settingsChanged(current: McpServerConfig, next: McpServerConfig): boolean {
  return (
    next.exposure !== current.exposure ||
    next.description !== current.description ||
    next.skills !== current.skills ||
    JSON.stringify(next.transport === 'stdio' ? undefined : next.url) !==
      JSON.stringify(current.transport === 'stdio' ? undefined : current.url) ||
    JSON.stringify(next.tools) !== JSON.stringify(current.tools) ||
    next.payload_max_bytes !== current.payload_max_bytes ||
    next.result_max_bytes !== current.result_max_bytes ||
    JSON.stringify(next.tool_policies) !== JSON.stringify(current.tool_policies) ||
    JSON.stringify(next.default_tool_policy) !== JSON.stringify(current.default_tool_policy) ||
    JSON.stringify(next.transport === 'stdio' ? undefined : next.headers) !==
      JSON.stringify(current.transport === 'stdio' ? undefined : current.headers)
  );
}

/**
 * `POST /api/mcp-servers` — a streamable HTTP server only. Stdio belongs in the
 * configuration file: its argv is an arbitrary host program, and the panel must
 * not become a place to write one.
 */
export function createMcpServer(
  file: FileConfig,
  body: Record<string, unknown>,
  caller: CallerClass,
  keychain: KeychainUsageForInput,
  providers: SearchProviders,
): ParsedMcpServerWrite {
  if (body.transport === 'stdio') {
    throw invalid('stdio servers run a command on the host; add them in config.jsonc on the server instead');
  }
  if (!createValidator.Check(body)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected alias, url, optional headers, tools, payload_max_bytes, result_max_bytes, tool_policies, default_tool_policy, exposure, description and skills',
    );
  }
  const servers = fileServers(file);
  if (servers.some((server) => server.alias === body.alias)) {
    throw new AdminQueryError('mcp_exists', `An MCP server named ${body.alias} is already configured`, 409);
  }
  const allocator = new SecretAllocator(new Set(keychain.entries), keychain.usage);
  const keys: Record<string, string> = Object.create(null);
  const repairs: Record<string, string> = Object.create(null);
  const replacements: KeychainReplacement[] = [];
  const submittedHeaders = readHeaderInputs(body.headers, 'headers');
  const headers = resolveHeaders(
    body.alias,
    servers.length,
    submittedHeaders,
    undefined,
    caller,
    allocator,
    keys,
    repairs,
    replacements,
  );
  const server: McpServerConfig = {
    alias: body.alias,
    transport: 'streamable_http',
    url: body.url,
    follow_redirects: false,
    tools: body.tools,
    payload_max_bytes: body.payload_max_bytes,
    result_max_bytes: body.result_max_bytes,
    ...(body.tool_policies === undefined || body.tool_policies === null ? {} : { tool_policies: body.tool_policies }),
    ...(body.default_tool_policy === undefined || body.default_tool_policy === null
      ? {}
      : { default_tool_policy: body.default_tool_policy }),
    ...presentationFields(body, undefined),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
  assertCandidate(file, [...servers, server], providers);
  const edits: ConfigEdit[] =
    file.mcp === undefined
      ? [{ path: ['mcp'], value: { servers: [server] }, keys }]
      : [{ path: ['mcp', 'servers', servers.length], value: server, keys }];
  return { edits, keys, repairs, replacements };
}

/**
 * `PUT /api/mcp-servers/:alias` — the alias is the identity. HTTP servers may
 * change their URL and headers; stdio servers only their tool selection, limits
 * and policies, because the panel cannot own a host command or environment.
 */
export function updateMcpServer(
  file: FileConfig,
  alias: string,
  body: Record<string, unknown>,
  caller: CallerClass,
  keychain: KeychainUsageForInput,
  providers: SearchProviders,
): ParsedMcpServerWrite {
  const servers = [...fileServers(file)];
  const index = servers.findIndex((server) => server.alias === alias);
  if (index < 0) {
    throw new AdminQueryError('not_found', `No MCP server named ${alias} is configured`, 404);
  }
  const current = servers[index] as McpServerConfig;
  for (const field of ['command', 'env'] as const) {
    if (body[field] !== undefined) {
      throw invalid(
        `the stdio ${field} cannot be edited from the panel; change ${alias} in config.jsonc on the server instead`,
      );
    }
  }
  if (body.transport !== undefined && body.transport !== current.transport) {
    throw invalid(`the transport of ${alias} cannot change; configure another server instead`);
  }
  if (!editValidator.Check(body)) {
    throw new AdminQueryError(
      'invalid_body',
      'Expected optional url, headers, tools, payload_max_bytes, result_max_bytes, tool_policies, default_tool_policy, exposure, description and skills',
    );
  }
  if (current.transport === 'stdio') {
    if (body.url !== undefined || body.headers !== undefined) {
      throw invalid(`stdio server ${alias} has no url or headers; edit its tools, limits and policies here`);
    }
    // The policy and presentation fields are stripped from the base: `null`
    // really removes, and an omission keeps what the file had.
    const {
      tool_policies: _keptPolicies,
      default_tool_policy: _keptDefault,
      exposure: _keptExposure,
      description: _keptDescription,
      skills: _keptSkills,
      ...base
    } = current;
    const server: McpServerConfig = {
      ...base,
      tools: body.tools ?? current.tools,
      payload_max_bytes: body.payload_max_bytes ?? current.payload_max_bytes,
      result_max_bytes: body.result_max_bytes ?? current.result_max_bytes,
      ...policyFields(body, current),
      ...presentationFields(body, current),
    };
    return finishUpdate(file, servers, index, current, server, providers, Object.create(null), Object.create(null), []);
  }
  const allocator = new SecretAllocator(new Set(keychain.entries), keychain.usage);
  const keys: Record<string, string> = Object.create(null);
  const repairs: Record<string, string> = Object.create(null);
  const replacements: KeychainReplacement[] = [];
  const submittedHeaders = readHeaderInputs(body.headers, 'headers', true);
  // A programmatic read-modify-write echoes the view it read: a `url` that is
  // exactly the redacted (origin-only) form of the stored URL means "leave the
  // URL alone", not "move the server" — it neither replaces the stored,
  // key-bearing URL nor demands the header secrets again. Anything else that
  // differs keeps the rules below.
  const echoedRedactedUrl =
    caller === 'programmatic' && body.url !== undefined && body.url === redactedUrl(current.url);
  const url = echoedRedactedUrl ? current.url : (body.url ?? current.url);
  if (caller === 'programmatic' && url !== current.url) {
    // Keeping a stored secret while moving its destination would let an
    // injected prompt send that credential to a server of its choosing.
    const kept = Object.keys(current.headers ?? {}).filter((name) => !Object.hasOwn(submittedHeaders, name));
    if (kept.length > 0) {
      throw invalid(`${alias} changed its url; re-enter its header secrets (${kept.join(', ')}) in the same request`);
    }
  }
  const resolved = resolveHeaders(
    alias,
    index,
    submittedHeaders,
    current.headers,
    caller,
    allocator,
    keys,
    repairs,
    replacements,
  );
  // Null prototype again: the merge must keep an awkward header name as an
  // own property instead of setting the accumulator's prototype.
  const merged: Record<string, SecretRef> = Object.assign(Object.create(null), current.headers ?? {}, resolved);
  for (const [name, input] of Object.entries(submittedHeaders)) {
    if (input === null) {
      delete merged[name];
    }
  }
  const {
    headers: _dropped,
    tool_policies: _keptPolicies,
    default_tool_policy: _keptDefault,
    exposure: _keptExposure,
    description: _keptDescription,
    skills: _keptSkills,
    ...base
  } = current;
  const server: McpServerConfig = {
    ...base,
    url,
    tools: body.tools ?? current.tools,
    payload_max_bytes: body.payload_max_bytes ?? current.payload_max_bytes,
    result_max_bytes: body.result_max_bytes ?? current.result_max_bytes,
    ...policyFields(body, current),
    ...presentationFields(body, current),
    // Untouched headers stay exactly as the file has them, an empty map
    // included: dropping it would read as a connection change and reconnect.
    ...(Object.keys(submittedHeaders).length === 0 && current.headers !== undefined
      ? { headers: current.headers }
      : Object.keys(merged).length === 0
        ? {}
        : { headers: merged }),
  };
  return finishUpdate(file, servers, index, current, server, providers, keys, repairs, replacements);
}

function finishUpdate(
  file: FileConfig,
  servers: readonly McpServerConfig[],
  index: number,
  current: McpServerConfig,
  server: McpServerConfig,
  providers: SearchProviders,
  keys: Readonly<Record<string, string>>,
  repairs: Readonly<Record<string, string>>,
  replacements: readonly KeychainReplacement[],
): ParsedMcpServerWrite {
  const changed =
    settingsChanged(current, server) ||
    Object.keys(keys).length > 0 ||
    Object.keys(repairs).length > 0 ||
    replacements.length > 0;
  if (!changed) {
    return { edits: [], keys: Object.create(null), repairs: Object.create(null), replacements: [] };
  }
  const next = [...servers];
  next[index] = server;
  assertCandidate(file, next, providers);
  const ownedKeys = keys as Record<string, string>;
  return {
    edits: [
      {
        path: ['mcp', 'servers', index],
        value: server,
        ...(Object.keys(ownedKeys).length === 0 ? {} : { keys: ownedKeys }),
      },
    ],
    keys: ownedKeys,
    repairs: repairs as Record<string, string>,
    replacements: [...replacements],
  };
}

/** `DELETE /api/mcp-servers/:alias` — refused while a Chat explicitly binds it. */
export function deleteMcpServer(file: FileConfig, alias: string): ConfigEdit[] {
  const servers = fileServers(file);
  const index = servers.findIndex((server) => server.alias === alias);
  if (index < 0) {
    throw new AdminQueryError('not_found', `No MCP server named ${alias} is configured`, 404);
  }
  const boundChats = (file.telegram?.chats ?? []).filter((chat) =>
    (chat.mcp ?? []).some((binding) => binding.server === alias),
  );
  if (boundChats.length > 0) {
    throw new AdminQueryError(
      'mcp_server_in_use',
      `Chats still bind MCP server ${alias}: unbind them first (chats: ${boundChats.map((chat) => chat.id).join(', ')})`,
      409,
    );
  }
  return [{ path: ['mcp', 'servers', index], value: undefined }];
}
