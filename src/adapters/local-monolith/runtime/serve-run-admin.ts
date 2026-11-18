import { AdminQueryError } from '../../../ingress/admin/audit/shared.ts';
import { AdminServer } from '../../../ingress/admin/index.ts';
import { ReplayError, ReplayRunner } from '../../../orchestration/replay/index.ts';
import { WEB_SEARCH_PROVIDERS } from '../../../plugins/web-search/extension.ts';
import { logEvent, type ServeContext } from './support.ts';
import type { ServeAssembly } from './serve.ts';
import type { ServeCore } from './serve-run.ts';
/** Starts the Admin panel when the config enables it; a no-op otherwise. */
export async function startAdminServer(session: ServeContext, assembly: ServeAssembly, core: ServeCore): Promise<void> {
  const { loaded, secrets, requestRestart, replayShutdown, state } = session;
  const {
    store,
    configStore,
    tasks,
    recurringAlarms,
    modelSwitcher,
    media,
    mediaClient,
    modelGate,
    systemResources,
    imageService,
    imageBridge,
    playgroundAssets,
    playgroundStore,
    playgroundIngress,
    skillVisibleForHost,
    plugins,
    warnings,
    connections,
    mcpManager,
  } = assembly;
  const searchProviders = plugins.extensions(WEB_SEARCH_PROVIDERS).map((provider) => provider.rule);
  const { runtime, startedScheduler, configReloader } = core;
  if (loaded.config.admin.enabled) {
    const replay = new ReplayRunner({
      store,
      configStore,
      secrets,
      systemResources,
      modelGate,
      shutdownSignal: replayShutdown.signal,
      toolDefinitions: (context, config) => runtime.sceneToolDefinitions(context, config),
      skillVisibility: (skill, target) => skillVisibleForHost(skill, target),
      imageLoader: async (mediaId, signal) => {
        const image = await media.prepareSceneImage(mediaId, signal);
        return { type: 'image', data: image.base64, mimeType: image.mime };
      },
    });
    const adminServer = new AdminServer({
      store,
      configStore,
      connections,
      scheduler: startedScheduler,
      tasks,
      recurringAlarms,
      modelSwitcher,
      configReloader,
      secrets,
      searchProviders,
      warnings,
      mcpServerStates: () => mcpManager.serverStates(),
      requestRestart,
      imageService,
      imageBridge,
      playground: {
        store,
        rooms: playgroundStore,
        ingress: playgroundIngress,
        assets: playgroundAssets,
      },
      mediaDownloader: mediaClient,
      shutdownSignal: replayShutdown.signal,
      replayPreflight: (id, selection) => {
        try {
          return replay.inspect(id, selection);
        } catch (error) {
          if (error instanceof ReplayError) {
            throw new AdminQueryError(error.code, error.message, error.status);
          }
          throw error;
        }
      },
      invocationPrompts: (id) => {
        try {
          return replay.prompts(id);
        } catch (error) {
          if (error instanceof ReplayError) {
            throw new AdminQueryError(error.code, error.message, error.status);
          }
          throw error;
        }
      },
      replayInvocation: async (id, input, signal) => {
        try {
          return await replay.run(id, input, signal);
        } catch (error) {
          if (error instanceof ReplayError) {
            throw new AdminQueryError(error.code, error.message, error.status);
          }
          throw error;
        }
      },
    });
    state.admin = adminServer;
    const listening = await adminServer.start();
    logEvent('admin_started', { host: listening.hostname, port: listening.port });
  }
}

/**
 * Blocks until a signal, takeover or panel restart resolves the idle promise.
 * Long polling belongs to the connection manager, so there is never a bot loop
 * for this function to await: Telegram may be disabled, connecting or running
 * and the process stays alive for the panel and rooms either way.
 */
export async function runServeLoop(session: ServeContext, assembly: ServeAssembly): Promise<void> {
  const { loaded, idle } = session;
  const state = assembly.connections.get('telegram');
  const identity = assembly.telegram.identity;
  logEvent('serve_started', {
    mode: state.status,
    ...(state.status === 'config_error' ? { reason: state.reason } : {}),
    bot_id: identity === undefined ? null : String(identity.id),
    config_hash: loaded.hash,
  });
  await idle;
}
