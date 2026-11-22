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
import { ConfigReloader } from '../../../src/adapters/local-monolith/config/reload.ts';
import { McpManager } from '../../../src/capabilities/mcp/index.ts';
import { jarEntryDigests, mcpServerKeyDigests } from '../../../src/adapters/local-monolith/config/reload-apply.ts';
import { CronerScheduleEngine } from '../../../src/adapters/local-monolith/recurring-schedule.ts';
import { publishStickerSets } from '../../../src/adapters/local-monolith/runtime/sticker-sets.ts';
import { AdminServer } from '../../../src/ingress/admin/index.ts';
import { ImConnectionRegistry } from '../../../src/platform/im-connection.ts';
import { keychainPath } from '../../../src/platform/keychain.ts';
import { AgentModelSwitcher } from '../../../src/platform/models/switch.ts';
import { buildModelRegistry } from '../../../src/platform/providers.ts';
import { createImageBridge } from '../../../src/image/bridge/index.ts';
import { createImageService } from '../../../src/image/service.ts';
import { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { LongTaskService } from '../../../src/store/long-tasks/index.ts';
import { RecurringAlarmService } from '../../../src/store/recurring-alarms/index.ts';
import { prepareConfig } from './server-config.ts';
import { requestedDocsSeed } from './docs-locale.ts';
import { installDocsImageUpstream } from './server-docs-image.ts';
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

  const secrets = new SecretStore(keychainPath(configPath));
  // Docs screenshots photograph the image pages, so this process runs the real
  // image core with the vendor answered in-process (see `server-docs-image.ts`).
  // The shared E2E suites keep /api/image at 503, exactly as before.
  const docsSeed = requestedDocsSeed();
  let imageService: ReturnType<typeof createImageService> | null = null;
  if (docsSeed !== null) {
    await installDocsImageUpstream();
    imageService = createImageService(store, loaded.config, {});
    // Published before the first await: a shutdown signal during boot must find
    // the worker and drain it.
    state.imageService = imageService;
    imageService.publishConfig(await imageService.prepareConfig(loaded.config, secrets));
  }
  // The real outbound MCP manager, but only for the specs that assert on live
  // MCP state (`test.use({ mcpManager: true })`): the stdio fixture spawns a
  // child process, and every other suite keeps the fixture's small footprint.
  const mcpManager = process.env.E2E_MCP_MANAGER === '1' ? new McpManager(store, loaded.config, secrets) : null;
  await mcpManager?.start();
  state.mcpManager = mcpManager;
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  // The fixture runs no connection manager; tests move this registry between
  // states to render the Telegram page and the standing warnings.
  const connections = new ImConnectionRegistry();
  state.connections = connections;

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
  let publishedConfig = configStore.current().config;
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    // Seed the rotation digests like production: the startup build resolved
    // these secrets once, so the first apply must not flag anything rotated.
    providerKeyDigests: registry.keyDigests ?? {},
    jarDigests: await jarEntryDigests(loaded.config, secrets),
    mcpServerKeyDigests: await mcpServerKeyDigests(loaded.config, secrets),
    // This fixture runs no agent runtime, so there is no tool registry to fit
    // into the model's context window; production wires the real validator.
    validateAgentModel: () => {
      if (state.failNextConfigApply) {
        state.failNextConfigApply = false;
        throw new Error('Synthetic apply failure');
      }
    },
    // An image-settings save republishes the snapshot like `serve` does, so the
    // enable switch and the model list follow the file without a restart.
    ...(imageService === null
      ? {}
      : {
          imageConfig: {
            prepare: (candidate: Parameters<typeof imageService.prepareConfig>[0]) =>
              imageService.prepareConfig(candidate, secrets),
            publish: (snapshot: unknown) =>
              imageService.publishConfig(snapshot as Parameters<typeof imageService.publishConfig>[0]),
          },
        }),
    // The sticker-set publish path is the product's: the store follows the
    // file at once. No runtime runs here, so nothing is aborted or fetched.
    onPublished: async () => {
      const next = configStore.current().config;
      publishStickerSets(
        { store, abortInvocations: () => 0, stickers: () => undefined, onRefreshFailed: () => undefined },
        publishedConfig,
        next,
      );
      publishedConfig = next;
      // The MCP instances follow the file like `serve` does. There is no
      // scheduler to cut over here, so the reconcile alone stands in for the
      // cutover; a server that cannot connect degrades and retries on its own.
      if (mcpManager !== null) {
        await mcpManager
          .reconcile({ config: next, generation: configStore.current().generation })
          .catch(() => undefined);
      }
    },
  });
  // No Scheduler runs here: Run now records its firing and task, and the
  // occurrence simply stays undelivered, which is all the panel can observe.
  const tasks = new LongTaskService(store.orm);
  // The admin image pages read `enabled`/`modelList` from the bridge; this
  // process has no conversation media to translate into image input, so the
  // agent-side input path stays closed.
  const imageBridge =
    imageService === null
      ? null
      : createImageBridge({
          service: imageService,
          store,
          tasks,
          prepareInputImage: () => Promise.reject(new Error('The E2E fixture translates no conversation media')),
        });
  const recurringAlarms = new RecurringAlarmService({
    store,
    engine: new CronerScheduleEngine(),
    tasks,
    config: () => configStore.current().config,
  });
  state.admin = new AdminServer({
    store,
    configStore,
    connections,
    tasks,
    recurringAlarms,
    modelSwitcher,
    configReloader,
    secrets,
    ...(imageService === null || imageBridge === null ? {} : { imageService, imageBridge }),
    playground: {
      store,
      rooms: playgroundStore,
      ingress: playgroundIngress,
      assets: playgroundAssets,
    },
    // The E2E process has to outlive the suite, so a restart request is recorded
    // instead of shutting the process down. `POST /api/restart` itself (the
    // config check and the 202) is exercised by test/admin/providers.test.ts.
    requestRestart: () => {
      console.log('E2E_RESTART_REQUESTED');
    },
    ...(mcpManager === null
      ? {}
      : {
          mcpServerStates: () => mcpManager.serverStates(),
          mcpServerTools: () => mcpManager.serverToolListings(),
        }),
  });

  console.log(`E2E_READY base=http://${hostname}:${port}`);
}
