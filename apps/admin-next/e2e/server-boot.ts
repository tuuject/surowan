/**
 * Boot of the E2E backend process: temp directory, loopback upstream, fixture
 * config, seeded store, the listener, then `AdminServer`.
 *
 * The listener serves two trees on one port: `/__e2e/**` goes to the test-only
 * hooks, everything else to `AdminServer.handle` (real API + static SPA).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigReloader } from '../../../src/adapters/local-monolith/config-reload.ts';
import { AdminServer } from '../../../src/ingress/admin/server.ts';
import { keyJarPath } from '../../../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../../../src/platform/model-switch.ts';
import { buildModelRegistry } from '../../../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { prepareConfig } from './server-config.ts';
import { openFixtures } from './server-fixtures.ts';
import { handleHook, json } from './server-hooks.ts';
import { createRelayUpstream } from './server-relay.ts';
import { state } from './server-state.ts';

export async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-admin-e2e-'));
  state.directory = directory;
  const configPath = join(directory, 'config.jsonc');
  const staticDir = resolve(join(import.meta.dirname, '..', 'dist'));
  // The custom relay provider's listing endpoint: the Models page's discovery
  // must never reach the network, and the key/header assertions only hold when
  // the request lands here.
  const relay = await createRelayUpstream();
  state.upstream = relay.server;
  const { loaded, adminConfig } = await prepareConfig({
    directory,
    configPath,
    staticDir,
    relayPort: relay.port,
  });
  const fixtures = await openFixtures(loaded, directory);
  const { store, playgroundStore, playgroundAssets, playgroundIngress } = fixtures;

  const secrets = new SecretStore(keyJarPath(configPath));
  const registry = await buildModelRegistry(loaded.config, null, secrets);

  // Bind the loopback listener FIRST so the random port is known before the
  // passkeys origin is derived from it; `AdminServer` reads `admin.public_url`
  // at construction, so the in-memory config is patched before it is created.
  // WebAuthn RP IDs must be domains, hence `localhost` in passkeys mode.
  const passkeysMode = process.env.E2E_PASSKEYS === '1';
  const hostname = passkeysMode ? 'localhost' : '127.0.0.1';
  const started = serve({
    hostname,
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__e2e/')) {
        return await handleHook(request, url);
      }
      const admin = state.admin;
      if (admin === null) {
        return json({ error: 'admin_not_ready', message: 'E2E server is still starting' }, 503);
      }
      return await admin.handle(request);
    },
  });
  state.server = started;
  // @hono/node-server binds asynchronously; Bun.serve was listening on return.
  const listening = Promise.withResolvers<void>();
  started.once('listening', listening.resolve);
  started.once('error', listening.reject);
  await listening.promise;
  const address = started.address();
  if (address === null || typeof address === 'string') {
    throw new Error('E2E server did not bind a port');
  }
  const port = address.port;
  if (passkeysMode) {
    // Written after loadConfig because only the live port yields a valid
    // canonical origin. It is never written to the fixture file.
    adminConfig.public_url = `http://localhost:${port}`;
    console.log(`E2E_PASSKEYS origin=${adminConfig.public_url} rp_id=localhost`);
  }

  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const modelSwitcher = new AgentModelSwitcher(configStore);
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    // This fixture runs no agent runtime, so there is no tool registry to fit
    // into the model's context window; production wires the real validator.
    validateAgentModel: () => {
      if (state.failNextConfigApply) {
        state.failNextConfigApply = false;
        throw new Error('Synthetic apply failure');
      }
    },
    onPublished: () => undefined,
  });
  state.admin = new AdminServer({
    store,
    configStore,
    modelSwitcher,
    configReloader,
    secrets,
    playground: {
      store,
      rooms: playgroundStore,
      ingress: playgroundIngress,
      assets: playgroundAssets,
    },
    // The E2E process has to outlive the suite, so a restart request is recorded
    // instead of shutting the process down. `POST /api/restart` itself (the
    // config check and the 202) is exercised by test/admin-providers.test.ts.
    requestRestart: () => {
      console.log('E2E_RESTART_REQUESTED');
    },
  });

  console.log(`E2E_READY base=http://${hostname}:${port}`);
}
