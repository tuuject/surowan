/**
 * Pure draft logic for the MCP server editor: the form's tools/policy model and
 * its translation into a write request. Kept out of the component so the
 * boundary rules are unit-testable without React, like `header-rows.ts` —
 * including that it never talks to i18n: validation returns structured errors
 * and the component renders them.
 */
import type {
  McpDefaultPolicyInput,
  McpExposure,
  McpServerInput,
  McpServerView,
  McpToolPolicyInput,
} from '@/lib/api/mcp-servers.ts';

/**
 * One per-tool policy row. In "selected tools" mode the rows are the explicit
 * tool list with the policy each needs; in "all tools" mode they are the
 * wildcard server's per-tool overrides, kept editable next to the default
 * policy so an unrelated edit cannot silently drop them.
 */
export interface ToolPolicyDraft {
  readonly key: number;
  readonly name: string;
  readonly readOnly: boolean;
  readonly timeout: string;
}

export interface ServerDraft {
  readonly alias: string;
  /** `all` writes `tools: '*'` with a default policy; `selected` writes an explicit list with per-tool policies. */
  readonly toolsMode: 'all' | 'selected';
  readonly tools: readonly ToolPolicyDraft[];
  readonly defaultReadOnly: boolean;
  readonly defaultTimeout: string;
  readonly payloadMax: string;
  readonly resultMax: string;
  readonly url: string;
  readonly exposure: McpExposure;
  /** Free text; blank removes the description on save. */
  readonly description: string;
}

/** Why a draft cannot become a request body; the component translates each kind. */
export type ServerDraftError =
  | { readonly kind: 'toolNeedsName' }
  | { readonly kind: 'toolListedTwice'; readonly name: string }
  | { readonly kind: 'toolTimeout'; readonly name: string }
  | { readonly kind: 'defaultTimeout' }
  | { readonly kind: 'payloadRange' }
  | { readonly kind: 'resultRange' };

let draftKey = 0;

function rowsOf(policies: readonly McpToolPolicyInput[] | null): ToolPolicyDraft[] {
  return (policies ?? []).map((policy) => ({
    key: draftKey++,
    name: policy.name,
    readOnly: policy.read_only,
    timeout: String(policy.timeout_seconds),
  }));
}

export function draftOf(server: McpServerView | null): ServerDraft {
  const wildcard = server === null || server.tools === '*';
  return {
    alias: server?.alias ?? '',
    toolsMode: wildcard ? 'all' : 'selected',
    // Both modes keep the configured rows: an explicit list's policies, or a
    // wildcard server's per-tool overrides.
    tools: rowsOf(server?.tool_policies ?? null),
    defaultReadOnly: server?.default_tool_policy?.read_only ?? true,
    defaultTimeout: String(server?.default_tool_policy?.timeout_seconds ?? 30),
    payloadMax: String(server?.payload_max_bytes ?? 32_768),
    resultMax: String(server?.result_max_bytes ?? 32_768),
    url: server !== null && server.connection.kind === 'streamable_http' ? server.connection.url : '',
    exposure: server?.exposure ?? 'direct',
    description: server?.description ?? '',
  };
}

export function newToolRow(): ToolPolicyDraft {
  return { key: draftKey++, name: '', readOnly: true, timeout: '30' };
}

export interface ServerPayload {
  readonly body: ServerBody | null;
  readonly error: ServerDraftError | null;
}

/** A request body the form builds: every connection field is always present. */
export type ServerBody = Omit<McpServerInput, 'headers'> &
  Required<Pick<McpServerInput, 'tools' | 'payload_max_bytes' | 'result_max_bytes'>>;

/**
 * Whether `body` changes anything but the presentation fields of `server`.
 * The saved server is put through the same form translation, so a value the
 * form normalises (an empty override list becomes `null`) compares equal and
 * a description-only save does not rewrite — and reconnect — the server.
 */
export function connectionChanged(server: McpServerView, body: ServerBody): boolean {
  const saved = serverPayload(draftOf(server)).body;
  if (saved === null) {
    return true;
  }
  const { exposure: _savedExposure, description: _savedDescription, ...savedConnection } = saved;
  const { exposure: _exposure, description: _description, ...connection } = body;
  return JSON.stringify(savedConnection) !== JSON.stringify(connection);
}

/** Turns the draft into the request body; `error` says why it cannot when it cannot. */
export function serverPayload(draft: ServerDraft): ServerPayload {
  const toolPolicies: McpToolPolicyInput[] = [];
  const seen = new Set<string>();
  for (const tool of draft.tools) {
    const name = tool.name.trim();
    if (name.length === 0) {
      return { body: null, error: { kind: 'toolNeedsName' } };
    }
    if (seen.has(name)) {
      return { body: null, error: { kind: 'toolListedTwice', name } };
    }
    seen.add(name);
    const timeout = Number(tool.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return { body: null, error: { kind: 'toolTimeout', name } };
    }
    toolPolicies.push({ name, read_only: tool.readOnly, timeout_seconds: timeout });
  }
  if (draft.toolsMode === 'all') {
    const timeout = Number(draft.defaultTimeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return { body: null, error: { kind: 'defaultTimeout' } };
    }
    const defaultPolicy: McpDefaultPolicyInput = {
      read_only: draft.defaultReadOnly,
      timeout_seconds: timeout,
    };
    // The overrides ride along when present; an empty row list is an explicit
    // request to remove them (`null`), never an accident of the mode.
    return finish(draft, {
      tools: '*',
      tool_policies: toolPolicies.length > 0 ? toolPolicies : null,
      default_tool_policy: defaultPolicy,
    });
  }
  // An explicit list may be empty, exactly as the file allows; the default
  // policy is not modelled here, so the write keeps whatever the file has.
  return finish(draft, {
    tools: toolPolicies.map((tool) => tool.name),
    tool_policies: toolPolicies,
  });
}

function finish(
  draft: ServerDraft,
  policies:
    | {
        readonly tools: '*';
        readonly tool_policies: readonly McpToolPolicyInput[] | null;
        readonly default_tool_policy: McpDefaultPolicyInput;
      }
    | { readonly tools: readonly string[]; readonly tool_policies: readonly McpToolPolicyInput[] },
): ServerPayload {
  const payloadMax = Number(draft.payloadMax);
  if (!Number.isInteger(payloadMax) || payloadMax < 1 || payloadMax > 1_048_576) {
    return { body: null, error: { kind: 'payloadRange' } };
  }
  const resultMax = Number(draft.resultMax);
  if (!Number.isInteger(resultMax) || resultMax < 1 || resultMax > 32_768) {
    return { body: null, error: { kind: 'resultRange' } };
  }
  const description = draft.description.trim();
  const body = {
    ...(draft.url.length > 0 ? { url: draft.url } : {}),
    exposure: draft.exposure,
    description: description.length > 0 ? description : null,
    tools: policies.tools,
    payload_max_bytes: payloadMax,
    result_max_bytes: resultMax,
    ...('default_tool_policy' in policies ? { default_tool_policy: policies.default_tool_policy } : {}),
    ...('tool_policies' in policies ? { tool_policies: policies.tool_policies } : {}),
  };
  return { body, error: null };
}
