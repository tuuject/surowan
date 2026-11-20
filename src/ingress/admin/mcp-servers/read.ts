/**
 * The MCP servers page's read view: every configured outbound server with its
 * connection summary, live availability and the tools it advertised.
 *
 * Secrets never travel back. HTTP shows the URL and header *names* (with their
 * source for panel sessions); stdio shows the program's basename, an argument
 * count and env var names — never the argv, which can carry tokens. Advertised
 * descriptions and input schemas are untrusted server data: they are data in
 * this view and the panel renders them as plain text, never as markup.
 */
import { basename } from 'node:path';
import { mcpExposure, mcpSkillsEnabled } from '../../../capabilities/mcp/bindings.ts';
import type { McpServerToolListing, McpSkillListing } from '../../../capabilities/mcp/support.ts';
import type { FileConfig, McpServerConfig, SecretRef } from '../../../platform/config/index.ts';
import type { McpServerAvailability } from '../../../platform/warning-catalog.ts';
import type { SecretSourceView } from '../secret-input.ts';
import { secretSourceOf } from '../secret-input.ts';

/** The live availability one server reports right now; `null` outside `serve`. */
export interface McpServerStateView {
  /** `starting` from the manager reads as `connecting` here. */
  readonly state: 'ready' | 'connecting' | 'degraded';
  readonly error_code: string | null;
  readonly next_reconnect_at: string | null;
  readonly retrying: boolean;
}

export type McpSecretSourceRow = { readonly name: string; readonly source?: SecretSourceView };

export type McpConnectionView =
  | {
      readonly kind: 'stdio';
      /** Basename of `command[0]`; the argv itself never leaves the server. */
      readonly program: string;
      readonly argument_count: number;
      readonly env: readonly McpSecretSourceRow[];
    }
  | {
      readonly kind: 'streamable_http';
      readonly url: string;
      /** Programmatic callers only: the URL was withheld down to its origin. */
      readonly url_redacted?: true;
      readonly headers: readonly McpSecretSourceRow[];
    };

/** One tool the server advertised, with how this configuration treats it. */
export interface McpAdvertisedToolView {
  readonly name: string;
  readonly description: string | null;
  /** Raw `inputSchema` JSON as the server sent it; untrusted data. */
  readonly input_schema: Record<string, unknown> | null;
  /** Whether the server's `tools` setting exposes this tool to the model. */
  readonly exposed: boolean;
  /** The server-level policy this tool would run under, if it resolves one. */
  readonly policy: { readonly read_only: boolean; readonly timeout_seconds: number } | null;
}

/** One Chat that explicitly binds this server. */
export interface McpBoundChatView {
  readonly chat_id: string;
  readonly tools: '*' | readonly string[];
  readonly tool_policies:
    | readonly { readonly name: string; readonly read_only: boolean; readonly timeout_seconds: number }[]
    | null;
}

export interface McpServerView {
  readonly alias: string;
  readonly transport: McpServerConfig['transport'];
  /** `direct` lists each tool in the registry; `progressive` puts them behind the `mcp` gateway. */
  readonly exposure: 'direct' | 'progressive';
  /** The operator-reviewed description the gateway shows the model; `null` when unset. */
  readonly description: string | null;
  /** Whether the model may read this server's skills; the panel lists them either way. */
  readonly skills_enabled: boolean;
  /** Verified skills of the last connect; metadata only, never file contents. Untrusted server data. */
  readonly skills: readonly McpSkillListing[];
  /** Short code of the last skill discovery problem, if any. */
  readonly skills_error: string | null;
  readonly state: McpServerStateView | null;
  readonly connection: McpConnectionView;
  readonly tools: '*' | readonly string[];
  readonly payload_max_bytes: number;
  readonly result_max_bytes: number;
  readonly tool_policies:
    | readonly { readonly name: string; readonly read_only: boolean; readonly timeout_seconds: number }[]
    | null;
  readonly default_tool_policy: { readonly read_only: boolean; readonly timeout_seconds: number } | null;
  readonly advertised_tools: readonly McpAdvertisedToolView[];
  readonly bound_chats: readonly McpBoundChatView[];
}

export interface McpServersView {
  readonly revision: string;
  /** Whether live per-alias availability is wired (false in standalone panels). */
  readonly live: boolean;
  readonly servers: readonly McpServerView[];
  /** Chats without an `mcp` field: they inherit every configured server. */
  readonly unbound_chat_ids: readonly string[];
}

function namedPolicyView(policy: {
  readonly name: string;
  readonly read_only: boolean;
  readonly timeout_seconds: number;
}) {
  return { name: policy.name, read_only: policy.read_only, timeout_seconds: policy.timeout_seconds };
}

function policyView(policy: { readonly read_only: boolean; readonly timeout_seconds: number }) {
  return { read_only: policy.read_only, timeout_seconds: policy.timeout_seconds };
}

/** The server-level policy one advertised tool runs under, in the file's units. */
function configuredPolicy(server: McpServerConfig, tool: string) {
  const configured = server.tool_policies?.find((policy) => policy.name === tool) ?? server.default_tool_policy;
  return configured === undefined ? null : policyView(configured);
}

function secretRows(
  record: Readonly<Record<string, SecretRef>> | undefined,
  withSources: boolean,
): readonly McpSecretSourceRow[] {
  const sources = record ?? {};
  return Object.keys(sources).map((name) => ({
    name,
    // Panel sessions see where each secret comes from; programmatic callers
    // get names only, so an injected prompt cannot learn the key layout.
    ...(withSources ? { source: secretSourceOf(sources[name]) } : {}),
  }));
}

/**
 * The URL as a programmatic caller may see it: only the origin. Hosted MCP
 * endpoints put tokens in the path (Zapier-style `/mcp/<secret>/sse`) and in
 * the query — as values and as bare parameter names (`?sk-123`) — so anything
 * beyond `scheme://host[:port]` is withheld. The panel session keeps the
 * verbatim URL its edit form needs, and a write that echoes the origin back
 * is treated as "unchanged" (see `updateMcpServer`).
 */
export function redactedUrl(url: string): string {
  return new URL(url).origin;
}

export function mcpServersView(
  file: FileConfig,
  revision: string,
  options: {
    readonly serverStates?: readonly McpServerAvailability[] | undefined;
    readonly toolListings?: readonly McpServerToolListing[] | undefined;
    /** Panel sessions only: each secret's origin. */
    readonly withSources: boolean;
    /** Programmatic callers only: HTTP URLs shrink to their origin. */
    readonly redactUrls: boolean;
  },
): McpServersView {
  const servers = file.mcp?.servers ?? [];
  const states = new Map((options.serverStates ?? []).map((state) => [state.alias, state]));
  const listings = new Map((options.toolListings ?? []).map((listing) => [listing.alias, listing]));
  const chats = file.telegram?.chats ?? [];
  return {
    revision,
    live: options.serverStates !== undefined,
    servers: servers.map((server): McpServerView => {
      const availability = states.get(server.alias);
      const state: McpServerStateView | null =
        availability === undefined
          ? null
          : {
              // `starting` reads as `connecting`; a published alias never stays
              // `stopped`, but it would still be an outage from the panel's view.
              state:
                availability.state === 'starting'
                  ? 'connecting'
                  : availability.state === 'ready'
                    ? 'ready'
                    : 'degraded',
              error_code: availability.error_code,
              next_reconnect_at: availability.next_reconnect_at,
              retrying: availability.retrying,
            };
      const connection: McpConnectionView =
        server.transport === 'stdio'
          ? {
              kind: 'stdio',
              program: basename(server.command[0] ?? ''),
              argument_count: Math.max(server.command.length - 1, 0),
              env: secretRows(server.env, options.withSources),
            }
          : options.redactUrls
            ? {
                kind: 'streamable_http',
                url: redactedUrl(server.url),
                url_redacted: true,
                headers: secretRows(server.headers, options.withSources),
              }
            : {
                kind: 'streamable_http',
                url: server.url,
                headers: secretRows(server.headers, options.withSources),
              };
      const listing = listings.get(server.alias);
      const advertised = listing?.tools ?? [];
      return {
        alias: server.alias,
        transport: server.transport,
        exposure: mcpExposure(server),
        description: server.description ?? null,
        skills_enabled: mcpSkillsEnabled(server),
        skills: listing?.skills ?? [],
        skills_error: listing?.skills_error ?? null,
        state,
        connection,
        tools: server.tools,
        payload_max_bytes: server.payload_max_bytes,
        result_max_bytes: server.result_max_bytes,
        tool_policies: server.tool_policies === undefined ? null : server.tool_policies.map(namedPolicyView),
        default_tool_policy: server.default_tool_policy === undefined ? null : policyView(server.default_tool_policy),
        advertised_tools: advertised.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          exposed: server.tools === '*' || server.tools.includes(tool.name),
          policy: configuredPolicy(server, tool.name),
        })),
        bound_chats: chats.flatMap((chat) => {
          const binding = (chat.mcp ?? []).find((entry) => entry.server === server.alias);
          return binding === undefined
            ? []
            : [
                {
                  chat_id: String(chat.id),
                  tools: binding.tools ?? server.tools,
                  tool_policies:
                    binding.tool_policies === undefined ? null : binding.tool_policies.map(namedPolicyView),
                },
              ];
        }),
      };
    }),
    unbound_chat_ids: chats.filter((chat) => chat.mcp === undefined).map((chat) => String(chat.id)),
  };
}
