/**
 * Reconcile: adopting one published server list by alias.
 *
 * A server is added, replaced or stopped only when its own entry changed, so an
 * untouched alias keeps its client and any call running on it. `required` is
 * deprecated and ignored: a hot-added or hot-changed server that fails to
 * connect is published as `degraded` with the normal reconnect backoff and
 * reported back so the reload log can say which one it was.
 */
import type { RawConfig } from '../../platform/config/index.ts';
import { sameMcpServerConfig } from './bindings.ts';
import { connect, managedServer, type Revalidate, scheduleReconnect, setState, stopServer } from './connection.ts';
import type { McpServerChange, McpServerReconcileResult, McpState } from './shared.ts';

export async function reconcile(
  state: McpState,
  published: { readonly config: RawConfig; readonly generation: number },
  revalidate: Revalidate,
): Promise<McpServerReconcileResult> {
  const { config, generation } = published;
  if (generation < state.generation) {
    // A handed-off cutover finishes after a newer configuration was published;
    // adopting its servers would roll the live instances back.
    return { added: [], replaced: [], removed: [], failed: [], stale: true };
  }
  state.generation = generation;
  state.config = config;
  const wanted = new Map((config.mcp?.servers ?? []).map((server) => [server.alias, server]));
  const added: string[] = [];
  const replaced: string[] = [];
  const removed: string[] = [];
  const failed: McpServerChange[] = [];
  for (const [alias, server] of [...state.servers]) {
    if (wanted.has(alias)) {
      continue;
    }
    await stopServer(state, server);
    state.servers.delete(alias);
    removed.push(alias);
  }
  for (const [alias, serverConfig] of wanted) {
    const current = state.servers.get(alias);
    if (current !== undefined && sameMcpServerConfig(current.config, serverConfig)) {
      continue;
    }
    if (current === undefined) {
      added.push(alias);
    } else {
      await stopServer(state, current);
      state.servers.delete(alias);
      replaced.push(alias);
    }
    const server = managedServer(serverConfig);
    state.servers.set(alias, server);
    try {
      await connect(state, server, false, revalidate);
    } catch (error) {
      setState(state, server, 'degraded', 'initialization_failed', error);
      scheduleReconnect(state, server, revalidate);
      failed.push({ alias, error: state.secrets.redactError(error) });
    }
  }
  return { added, replaced, removed, failed, stale: false };
}
