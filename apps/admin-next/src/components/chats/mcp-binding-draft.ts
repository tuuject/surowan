/**
 * Pure draft logic for the per-Chat MCP binding editor: the saved bindings as
 * an editable draft, how the draft follows a refreshed server list, and the
 * request body a save sends. Kept out of the component so the boundary rules
 * (policy overrides survive a round trip, deselected tools lose theirs) are
 * unit-testable without React, like `header-rows.ts`.
 */
import type { McpServerView } from '@/lib/api/mcp-servers.ts';
import type { ChatEntry } from '@/lib/api/chats.ts';

type BindingTools = '*' | readonly string[];

/** A binding's policy override in the units the request body uses. */
export interface BindingPolicyDraft {
  readonly name: string;
  readonly readOnly: boolean;
  readonly timeout: string;
}

/** One server's binding draft: whether it is bound, its tool selection and its policy overrides. */
export interface BindingDraft {
  readonly server: string;
  readonly bound: boolean;
  readonly allTools: boolean;
  readonly tools: ReadonlySet<string>;
  /** The saved per-tool overrides; kept verbatim unless the tool they name is deselected. */
  readonly policies: readonly BindingPolicyDraft[];
}

/** One saved binding as the Chats view reports it. */
interface SavedBinding {
  readonly server: string;
  readonly tools?: BindingTools;
  readonly tool_policies?: readonly { name: string; read_only: boolean; timeout_seconds: number }[];
}

/** The saved bindings of one chat, keyed by server alias. */
function savedBindingsOf(chat: ChatEntry | null): ReadonlyMap<string, SavedBinding> {
  return new Map((chat?.saved?.mcp ?? []).map((binding) => [binding.server, binding]));
}

function policiesOf(binding: SavedBinding | undefined): BindingPolicyDraft[] {
  return (binding?.tool_policies ?? []).map((policy) => ({
    name: policy.name,
    readOnly: policy.read_only,
    timeout: String(policy.timeout_seconds),
  }));
}

/** Drafts for every configured server, bound where the chat already binds them. */
export function bindingDraftsOf(
  servers: { readonly servers: readonly McpServerView[] },
  chat: ChatEntry | null,
): ReadonlyMap<string, BindingDraft> {
  const saved = savedBindingsOf(chat);
  const drafts = new Map<string, BindingDraft>();
  for (const server of servers.servers) {
    const binding = saved.get(server.alias);
    drafts.set(server.alias, {
      server: server.alias,
      bound: binding !== undefined,
      allTools: binding === undefined || binding.tools === undefined || binding.tools === '*',
      tools: new Set(binding?.tools === undefined || binding.tools === '*' ? [] : binding.tools),
      policies: policiesOf(binding),
    } satisfies BindingDraft);
  }
  return drafts;
}

/**
 * The drafts a refreshed server list needs: edits to known aliases stay, a
 * server another writer added while the dialog was open gets a default draft,
 * and a removed alias drops out. Without this, a server that appears mid-edit
 * renders a switch that silently does nothing.
 */
export function reconcileBindingDrafts(
  drafts: ReadonlyMap<string, BindingDraft>,
  servers: readonly McpServerView[],
): ReadonlyMap<string, BindingDraft> {
  const next = new Map<string, BindingDraft>();
  for (const server of servers) {
    const existing = drafts.get(server.alias);
    next.set(server.alias, existing ?? unboundDraft(server));
  }
  return next;
}

/**
 * The tool names a binding may narrow to: the server's own configured list, or
 * — for a wildcard server — what discovery advertised. Discovery can lag or be
 * absent (not connected yet, standalone panel), so a saved narrowed selection
 * is offered as-is: the operator can keep or remove those names and can always
 * switch to all tools.
 */
export function bindingChoices(server: McpServerView, draft: BindingDraft): readonly string[] {
  if (server.tools !== '*') {
    return server.tools;
  }
  const advertised = server.advertised_tools.map((tool) => tool.name);
  return advertised.length > 0 ? advertised : [...draft.tools];
}

/** The default draft for a server the chat has not bound. */
export function unboundDraft(server: McpServerView): BindingDraft {
  return { server: server.alias, bound: false, allTools: true, tools: new Set<string>(), policies: [] };
}

export type BindingMode = 'inherit' | 'none' | 'explicit';

/**
 * The request body a save sends for the drafts in this mode. A bound server's
 * saved policy overrides ride along untouched — dropping them would silently
 * fall the tool back to the server's own (possibly writable) policy — and only
 * the tools the operator deselects lose theirs.
 */
export function bindingWriteBody(
  mode: BindingMode,
  drafts: ReadonlyMap<string, BindingDraft>,
):
  | { readonly mode: 'inherit' }
  | { readonly mode: 'none' }
  | {
      readonly mode: 'explicit';
      readonly bindings: readonly {
        readonly server: string;
        readonly tools?: readonly string[];
        readonly tool_policies?: readonly { name: string; read_only: boolean; timeout_seconds: number }[];
      }[];
    } {
  if (mode === 'inherit') {
    return { mode: 'inherit' };
  }
  if (mode === 'none') {
    return { mode: 'none' };
  }
  const bindings: {
    server: string;
    tools?: readonly string[];
    tool_policies?: readonly { name: string; read_only: boolean; timeout_seconds: number }[];
  }[] = [];
  for (const draft of drafts.values()) {
    if (!draft.bound) {
      continue;
    }
    const keptPolicies = draft.policies
      .filter((policy) => draft.allTools || draft.tools.has(policy.name))
      .map((policy) => ({
        name: policy.name,
        read_only: policy.readOnly,
        timeout_seconds: Number(policy.timeout),
      }));
    bindings.push({
      server: draft.server,
      ...(draft.allTools ? {} : { tools: [...draft.tools] }),
      ...(keptPolicies.length === 0 ? {} : { tool_policies: keptPolicies }),
    });
  }
  return { mode: 'explicit', bindings };
}
