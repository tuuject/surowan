/**
 * Waiting on the background connections `McpManager.start()` kicks off.
 * `start()` returns before any server has finished its first attempt, so the
 * doctor — which reports whether each configured server answered — and test
 * harnesses that assert on `mcp_server_state` need every alias out of
 * `starting` before they read it.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { McpServerAvailability } from '../../platform/warning-catalog.ts';

/** Anything that reports live per-alias MCP state. */
export interface McpServerStateSource {
  serverStates(): readonly McpServerAvailability[];
}

/**
 * Resolves once no configured server is still `starting` — every alias either
 * reached `ready` or failed into `degraded` — or when `timeoutMs` passes,
 * whichever comes first.
 */
export async function awaitServerAttempts(
  source: McpServerStateSource,
  timeoutMs = 45_000,
): Promise<readonly McpServerAvailability[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = source.serverStates();
    if (states.every((server) => server.state !== 'starting') || Date.now() >= deadline) {
      return states;
    }
    await delay(50);
  }
}
