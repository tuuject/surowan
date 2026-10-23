/**
 * Graceful shutdown of the E2E backend.
 *
 * Reached from `POST /__e2e/shutdown`, SIGTERM/SIGINT, or the parent closing a
 * piped stdin (so a killed Playwright worker leaves no server). Every step is
 * best effort; the temp directory and its SQLite file are removed, then the
 * process exits 0.
 */
import { rm } from 'node:fs/promises';
import { stopFixtureServer } from '../../../test/helpers.ts';
import { stopRoomScheduler } from './server-rooms.ts';
import { state } from './server-state.ts';

export async function shutdown(): Promise<void> {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  try {
    const server = state.server;
    if (server !== null) {
      if ('closeAllConnections' in server) {
        server.closeAllConnections();
      }
      server.close();
    }
  } catch {
    // best effort
  }
  try {
    await stopRoomScheduler();
  } catch {
    // best effort
  }
  try {
    const upstream = state.upstream;
    if (upstream !== null) {
      await stopFixtureServer(upstream);
    }
  } catch {
    // best effort
  }
  try {
    state.store?.close();
  } catch {
    // best effort
  }
  try {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // best effort
  }
  process.exit(0);
}
