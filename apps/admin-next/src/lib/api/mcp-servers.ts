import { call, writeHeaders } from './core.ts';
import type { ChatWriteResponse } from './chats.ts';
import type { ModelApplySummary } from './models.ts';
import type { SecretInput, SecretSource } from './keychain.ts';

/**
 * The outbound MCP servers surface (`mcp.servers[]` in `config.jsonc`): what
 * the bot itself connects to. Values never travel back — HTTP servers show
 * header names with their source, stdio servers the program's basename and an
 * argument count. Advertised descriptions and input schemas are untrusted
 * server data the page renders as plain text only.
 */

export type McpLiveState = 'ready' | 'connecting' | 'degraded';

export interface McpServerStateView {
  readonly state: McpLiveState;
  readonly error_code: string | null;
  readonly next_reconnect_at: string | null;
  readonly retrying: boolean;
}

export interface McpSecretRow {
  readonly name: string;
  /** Panel sessions only: where the secret comes from. */
  readonly source?: SecretSource;
}

export type McpConnectionView =
  | {
      readonly kind: 'stdio';
      readonly program: string;
      readonly argument_count: number;
      readonly env: readonly McpSecretRow[];
    }
  | {
      readonly kind: 'streamable_http';
      readonly url: string;
      /** Programmatic callers only: the URL was withheld down to its origin. */
      readonly url_redacted?: boolean;
      readonly headers: readonly McpSecretRow[];
    };

export interface McpToolPolicyView {
  readonly name: string;
  readonly read_only: boolean;
  readonly timeout_seconds: number;
}

export interface McpDefaultPolicyView {
  readonly read_only: boolean;
  readonly timeout_seconds: number;
}

export interface McpAdvertisedToolView {
  readonly name: string;
  readonly description: string | null;
  readonly input_schema: Record<string, unknown> | null;
  readonly exposed: boolean;
  readonly policy: McpDefaultPolicyView | null;
}

export interface McpBoundChatView {
  readonly chat_id: string;
  readonly tools: '*' | readonly string[];
  readonly tool_policies: readonly McpToolPolicyView[] | null;
}

export interface McpServerView {
  readonly alias: string;
  readonly transport: 'stdio' | 'streamable_http';
  readonly state: McpServerStateView | null;
  readonly connection: McpConnectionView;
  readonly tools: '*' | readonly string[];
  readonly payload_max_bytes: number;
  readonly result_max_bytes: number;
  readonly tool_policies: readonly McpToolPolicyView[] | null;
  readonly default_tool_policy: McpDefaultPolicyView | null;
  readonly advertised_tools: readonly McpAdvertisedToolView[];
  readonly bound_chats: readonly McpBoundChatView[];
}

export interface McpServersView {
  readonly revision: string;
  readonly live: boolean;
  readonly servers: readonly McpServerView[];
  /** Chats without an `mcp` field: they inherit every configured server. */
  readonly unbound_chat_ids: readonly string[];
}

export interface McpToolPolicyInput {
  readonly name: string;
  readonly read_only: boolean;
  readonly timeout_seconds: number;
}

export interface McpDefaultPolicyInput {
  readonly read_only: boolean;
  readonly timeout_seconds: number;
}

export interface McpServerInput {
  readonly url?: string;
  /** Header name → a new secret, or `null` to delete; omitted keeps the stored one. */
  readonly headers?: Readonly<Record<string, SecretInput | null>>;
  readonly tools: '*' | readonly string[];
  readonly payload_max_bytes: number;
  readonly result_max_bytes: number;
  readonly tool_policies?: readonly McpToolPolicyInput[] | null;
  readonly default_tool_policy?: McpDefaultPolicyInput | null;
}

export interface McpServerCreateInput {
  readonly alias: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, SecretInput>>;
  readonly tools: '*' | readonly string[];
  readonly payload_max_bytes: number;
  readonly result_max_bytes: number;
  readonly tool_policies?: readonly McpToolPolicyInput[] | null;
  readonly default_tool_policy?: McpDefaultPolicyInput | null;
}

export interface McpServersWriteResult extends McpServersView {
  readonly apply: ModelApplySummary;
}

export function getMcpServers(): Promise<McpServersView> {
  return call<McpServersView>('/mcp-servers');
}

export function createMcpServer(body: McpServerCreateInput, revision: string): Promise<McpServersWriteResult> {
  return call<McpServersWriteResult>('/mcp-servers', {
    method: 'POST',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function updateMcpServer(alias: string, body: McpServerInput, revision: string): Promise<McpServersWriteResult> {
  return call<McpServersWriteResult>(`/mcp-servers/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}

export function deleteMcpServer(alias: string, revision: string): Promise<McpServersWriteResult> {
  return call<McpServersWriteResult>(`/mcp-servers/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: writeHeaders(revision),
  });
}

export type ChatMcpWrite =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'none' }
  | {
      readonly mode: 'explicit';
      readonly bindings: readonly {
        readonly server: string;
        readonly tools?: '*' | readonly string[];
        readonly tool_policies?: readonly McpToolPolicyView[];
      }[];
    };

/** Sets one Chat's MCP bindings; the response is the refreshed Chats view. */
export function updateMcpChatBinding(chatId: string, body: ChatMcpWrite, revision: string): Promise<ChatWriteResponse> {
  return call<ChatWriteResponse>(`/chats/${encodeURIComponent(chatId)}/mcp`, {
    method: 'PUT',
    headers: writeHeaders(revision),
    body: JSON.stringify(body),
  });
}
