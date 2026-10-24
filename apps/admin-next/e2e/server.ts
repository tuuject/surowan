/**
 * E2E backend process. Started once per spec file by `e2e/helpers.ts` as a
 * child process so the real `AdminServer` + real `SqliteStore` + the synthetic
 * admin fixture run under Node.js. It binds 127.0.0.1 on a random port and prints:
 *
 *   E2E_READY base=http://127.0.0.1:<port>
 *
 * The wrapper serves two trees on that single port:
 * - `/__e2e/**`  test-only hooks (state manipulation + shutdown);
 * - everything else is handed to `AdminServer.handle` (real API + static SPA).
 *
 * Passkeys mode (`E2E_PASSKEYS=1`) binds `localhost` instead of `127.0.0.1`
 * and sets `admin.public_url` to the live random origin before `AdminServer`
 * is constructed: Chromium rejects an IP literal as a WebAuthn RP ID
 * (`SecurityError: This is an invalid domain.`), so the RP must be a domain.
 *
 * Graceful shutdown: POST /__e2e/shutdown, SIGTERM/SIGINT, or the parent
 * closing a piped stdin (so a killed Playwright worker leaves no server). The temp
 * directory and its SQLite file are removed on shutdown. Nothing here reads
 * dev-data/, starts `serve`, or touches any user process.
 *
 * This file is the entry point and the launch contract (helpers spawn it by
 * filename); the work lives in the siblings:
 * - `server-boot.ts`      temp dir, loopback upstream, listener, `AdminServer`;
 * - `server-config.ts`    the fixture config, key jar and models.dev catalog;
 * - `server-fixtures.ts`  the seeded store, playground rooms and room runtime;
 * - `server-hooks.ts`     the `/__e2e/**` hooks;
 * - `server-relay.ts`     the loopback upstream and its counters;
 * - `server-rooms.ts`     the room runtime's scripted turns;
 * - `server-lifecycle.ts` shutdown;
 * - `server-state.ts`     the handles boot publishes to the modules above.
 */
import { main } from './server-boot.ts';
import { shutdown } from './server-lifecycle.ts';

/**
 * The Models page only offers "Restart now" when the deployment declared a
 * supervisor; nothing here actually exits the process (see `requestRestart`).
 */
process.env.PLASTICWAN_SUPERVISED = '1';

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
if (!process.stdin.isTTY) {
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();
}
process.on('uncaughtException', (error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  void shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error(`E2E_SERVER_ERROR ${reason instanceof Error ? reason.message : String(reason)}`);
  void shutdown();
});

void main().catch((error) => {
  console.error(`E2E_SERVER_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
