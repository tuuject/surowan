/**
 * Which MCP servers and tools one Telegram Chat reaches.
 *
 * This module is pure configuration arithmetic: the manager resolves a Chat's
 * tool set at invocation start from it, and the composition root compares two
 * published configurations with it to decide which Chats a change affects.
 *
 * A Chat entry without `mcp` reaches every configured server with the server's
 * own settings — the behaviour every configuration had before bindings existed.
 * `mcp: []` reaches none. A binding only narrows one server: connection
 * settings (command, url, headers, env) stay on the server, so a Chat that needs
 * a different connection refers to another alias.
 */

import { allConfiguredChats } from '../../platform/config/index.ts';
import { deepEqual } from '../../platform/config/diff-merge.ts';
import type { FileChat, McpServerConfig, RawConfig } from '../../platform/config/index.ts';

/** The policy one bound tool runs under, in the units the call path uses. */
export interface McpToolPolicy {
  readonly readOnly: boolean;
  readonly timeoutMs: number;
}

/** One configured server as one Chat sees it. */
export interface McpChatServer {
  readonly server: McpServerConfig;
  /** The server's own tool names this Chat may call, or `'*'` for everything it exposes. */
  readonly tools: '*' | readonly string[];
  /** This Chat's per-tool overrides; other tools keep the server's own policy. */
  readonly policies: ReadonlyMap<string, McpToolPolicy>;
}

type ChatBindingShape = Pick<FileChat, 'mcp'>;

/**
 * Whether two configured servers are the same instance. `required` is
 * deprecated and has no effect anywhere, so a file that only adds or flips it
 * must not read as a different server: nothing reconnects, no Chat is
 * affected, and no tool disappears.
 *
 * `exposure` and `description` only change how the model is shown the same
 * tools — listed one by one or behind the `mcp` gateway — never which tools a
 * Chat may call or under which policy. Reconnecting for them, or stopping a run
 * and rebuilding its Context, would buy nothing: the next Invocation reads both
 * from the configuration it runs under, and a run in flight keeps its set.
 * `skills` is the same kind of setting: discovery always runs at connect, and
 * the flag only gates whether the model is shown what was discovered.
 */
export function sameMcpServerConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  const {
    required: _leftRequired,
    exposure: _leftExposure,
    description: _leftDescription,
    skills: _leftSkills,
    ...leftRest
  } = left;
  const {
    required: _rightRequired,
    exposure: _rightExposure,
    description: _rightDescription,
    skills: _rightSkills,
    ...rightRest
  } = right;
  return deepEqual(leftRest, rightRest);
}

/** How one configured server's tools reach the model; omitted means `direct`. */
export function mcpExposure(server: McpServerConfig): 'direct' | 'progressive' {
  return server.exposure ?? 'direct';
}

/** Whether the model may read this server's skills; omitted means yes. */
export function mcpSkillsEnabled(server: McpServerConfig): boolean {
  return server.skills !== false;
}

/** The server-level policy of one tool, in the shape bound policies use. */
export function serverToolPolicy(server: McpServerConfig, tool: string): McpToolPolicy | undefined {
  const configured =
    server.tool_policies?.find((policy) => policy.name === tool) ?? server.default_tool_policy ?? undefined;
  return configured === undefined
    ? undefined
    : { readOnly: configured.read_only, timeoutMs: Math.round(configured.timeout_seconds * 1_000) };
}

/**
 * The servers one Chat may reach, in configuration order. A Chat without `mcp`
 * reaches every server with the server's own settings — the behaviour every
 * configuration had before bindings existed; `mcp: []` reaches none. A Chat the
 * configuration does not list is not a Chat here: the caller decides that (the
 * runtime resolves the entry from the configuration and refuses work without it).
 */
export function boundChatServers(config: RawConfig, chat: ChatBindingShape): McpChatServer[] {
  const servers = config.mcp?.servers ?? [];
  const bindings = chat.mcp;
  if (bindings === undefined) {
    return servers.map((server) => ({ server, tools: server.tools, policies: new Map() }));
  }
  const byAlias = new Map(servers.map((server) => [server.alias, server]));
  const bound: McpChatServer[] = [];
  for (const binding of bindings) {
    const server = byAlias.get(binding.server);
    if (server === undefined) {
      // Configuration validation rejects an unknown alias; resolving before that
      // check (a doctor run with only required servers) must not invent one.
      continue;
    }
    bound.push({
      server,
      tools: binding.tools ?? server.tools,
      policies: new Map(
        (binding.tool_policies ?? []).map((policy) => [
          policy.name,
          { readOnly: policy.read_only, timeoutMs: Math.round(policy.timeout_seconds * 1_000) },
        ]),
      ),
    });
  }
  return bound;
}

/**
 * Chats that lose something when `previous` becomes `next`, in configuration
 * order. A Chat is affected when a bound server or binding disappeared, when a
 * server it reaches changed any field, when its binding narrowed its tools, or
 * when it changed the policy of a tool it already had.
 *
 * Additions are not affecting: a new server, a new binding, or a wider tool list
 * reaches the next invocation without stopping the current one. A Chat only in
 * `previous` was removed, which the chat lifecycle handles; a Chat only in `next`
 * has no running work to protect.
 */
export function affectedMcpChatIds(
  previous: RawConfig,
  next: RawConfig,
  /** Aliases whose secret references rotated: every Chat reaching one is affected. */
  rotated: ReadonlySet<string> = new Set(),
): number[] {
  // A configured id is only unique inside its own host, so the lookup key
  // carries the host prefix; the reported id stays the configured number the
  // caller (Telegram cutover today) names Chats by.
  const before = new Map(allConfiguredChats(previous).map(({ host, chat }) => [`${host}:${chat.id}`, chat]));
  const affected: number[] = [];
  for (const { host, chat } of allConfiguredChats(next)) {
    const previousChat = before.get(`${host}:${chat.id}`);
    if (previousChat !== undefined && chatMcpChanged(previous, next, previousChat, chat, rotated)) {
      affected.push(chat.id);
    }
  }
  return affected;
}

function chatMcpChanged(
  previous: RawConfig,
  next: RawConfig,
  previousChat: ChatBindingShape,
  chat: ChatBindingShape,
  rotated: ReadonlySet<string>,
): boolean {
  const before = new Map(boundChatServers(previous, previousChat).map((bound) => [bound.server.alias, bound]));
  const after = new Map(boundChatServers(next, chat).map((bound) => [bound.server.alias, bound]));
  for (const [alias, bound] of before) {
    const current = after.get(alias);
    if (current === undefined) {
      // The server left the configuration, or this Chat lost its binding.
      return true;
    }
    if (rotated.has(alias) || !sameMcpServerConfig(bound.server, current.server)) {
      // A rotated server reconnects: its Chat sees the new tool world.
      return true;
    }
    if (narrows(bound.tools, current.tools)) {
      return true;
    }
    if (policiesChanged(bound, current)) {
      return true;
    }
  }
  return false;
}

/** Whether `after` hides a tool `before` exposed. A wildcard is "everything". */
function narrows(before: '*' | readonly string[], after: '*' | readonly string[]): boolean {
  if (after === '*') {
    return false;
  }
  if (before === '*') {
    // The exposed names come from discovery, so an explicit list is a narrowing
    // this comparison cannot rule out.
    return true;
  }
  return before.some((tool) => !after.includes(tool));
}

/**
 * Whether the policy of a tool the Chat already had changed. Server-level policy
 * changes are already covered by the server comparison; only this Chat's own
 * overrides can differ here. A previously explicit list hides no tool it had, so
 * an override for a newly added tool is a pure addition; only a previous `*`
 * exposes names the comparison cannot enumerate.
 */
function policiesChanged(before: McpChatServer, after: McpChatServer): boolean {
  if (before.tools === '*') {
    // Both sides' overrides are compared as a whole: discovery decides which
    // tools a wildcard exposes on either side.
    return !deepEqual(overrideEntries(before), overrideEntries(after));
  }
  for (const tool of before.tools) {
    if (after.tools !== '*' && !after.tools.includes(tool)) {
      // A narrowing is reported by `narrows`; the removed tool is not this Chat's anymore.
      continue;
    }
    const previousPolicy = before.policies.get(tool) ?? serverToolPolicy(before.server, tool);
    const nextPolicy = after.policies.get(tool) ?? serverToolPolicy(after.server, tool);
    if (!deepEqual(previousPolicy, nextPolicy)) {
      return true;
    }
  }
  return false;
}

function overrideEntries(bound: McpChatServer): [string, McpToolPolicy][] {
  return [...bound.policies.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1));
}
