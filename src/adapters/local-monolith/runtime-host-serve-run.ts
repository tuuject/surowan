/**
 * Running phases of `serve`: the hosts, the core runtime, the Admin panel and
 * the loops that keep the process alive until the shutdown path resolves.
 */

import type { Context } from 'grammy';
import type { ImageService } from '../../image/service.ts';
import type { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import { AdminQueryError } from '../../ingress/admin/audit.ts';
import { AdminServer } from '../../ingress/admin/server.ts';
import { BotCommandService } from '../../orchestration/bot-commands.ts';
import { ReplayError, ReplayRunner } from '../../orchestration/replay.ts';
import { type CoreRuntime, createCoreRuntime } from '../../orchestration/runtime.ts';
import type { ImHost } from '../../platform/im-host.ts';
import { previewContext, unavailableCapabilities } from '../../platform/invocation-context.ts';
import { configuredAgentModels } from '../../platform/providers.ts';
import { runStartupCatchUp } from '../../startup-catch-up.ts';
import { runRuntimeCatchUp } from '../../runtime-catch-up.ts';
import { recordPromptVersionsFromConfig } from '../../store/prompt-versions.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { ConfigReloader } from './config-reload.ts';
import { imageDeliveryResolver } from './host-tooling.ts';
import { resolveTelegramTokenSource } from './telegram-connection-token.ts';
import { createPlaygroundHost } from './playground-host.ts';
import type { ServeAssembly, ServeHosts, ServeServices } from './runtime-host-serve.ts';
import {
  ALLOWED_UPDATES,
  logEvent,
  replyToCommand,
  resolveConversation,
  type ServeContext,
} from './runtime-host-support.ts';
import { createTelegramHost } from './telegram-host.ts';
import { forwardingTelegramTransport, TelegramConnectionIdentity } from './telegram-instance.ts';

/** The wired runtime, its scheduler and the command path the panel shares. */
export interface ServeCore {
  readonly runtime: CoreRuntime['runtime'];
  readonly startedScheduler: CoreRuntime['scheduler'];
  readonly conversationRuntime: CoreRuntime['conversationRuntime'];
  readonly configReloader: ConfigReloader;
  readonly commands: BotCommandService;
}

/**
 * Connects the two transports to the store and the config: the Telegram host
 * borrows whichever instance is current, the Playground host borrows the room
 * assets. Both are constructed once and never rebuilt.
 */
export function connectServeHosts(session: ServeContext, services: ServeServices): ServeHosts {
  const { state } = session;
  // One host for both delivery and chat action: its per-conversation activity
  // bookkeeping is what keeps the ingestion status and the model's own
  // `typing` call from doubling up requests. With no instance it refuses every
  // send as `telegram_unavailable` instead of disappearing.
  const telegramHost = createTelegramHost({
    transport: forwardingTelegramTransport(services.telegram),
    sendRate: () => ({
      sendsPerWindow: services.configStore.current().config.agent.rate_limits.sends_per_window,
      windowSeconds: services.configStore.current().config.agent.rate_limits.window_seconds,
    }),
  });
  state.host = telegramHost;
  // Rooms show the same identity the Telegram bot has, so a mixed deployment
  // reads as one bot; a process with no Telegram instance names it itself. The
  // identity is read per delivery, so a connection that opens after the room
  // host exists still names it.
  const playgroundHost: ImHost = createPlaygroundHost({
    store: services.store,
    self: new TelegramConnectionIdentity(services.telegram),
    pictures: services.playgroundAssets,
    sendRate: () => ({
      sendsPerWindow: services.configStore.current().config.agent.rate_limits.sends_per_window,
      windowSeconds: services.configStore.current().config.agent.rate_limits.window_seconds,
    }),
  });
  state.roomHost = playgroundHost;
  return { telegramHost, playgroundHost };
}

/**
 * Wires the runtime, its reload path and the command service, then starts the
 * background work: catch-up, MCP and the scheduler.
 */
export async function startCoreRuntime(session: ServeContext, assembly: ServeAssembly): Promise<ServeCore> {
  const { loaded, secrets, state } = session;
  const {
    store,
    configStore,
    telegramHost,
    playgroundHost,
    imageBridge,
    imageService,
    modelGate,
    systemResources,
    plugins,
    media,
    tasks,
    capabilityTools,
    additionalTools,
    skillVisibleForHost,
    telegram,
    telegramConnection,
    isHostReady,
    modelSwitcher,
    mcpManager,
    warnings,
  } = assembly;
  const {
    runtime,
    scheduler: startedScheduler,
    conversationRuntime,
  } = createCoreRuntime({
    store,
    configStore,
    secrets,
    hosts: { telegram: telegramHost, playground: playgroundHost },
    conversation: (target) => resolveConversation(store, target),
    ...(imageBridge === undefined
      ? {}
      : {
          imageGeneration: imageDeliveryResolver(imageBridge),
        }),
    bot: new TelegramConnectionIdentity(telegram),
    isHostReady,
    modelGate,
    systemResources,
    contextInjectors: plugins.contextInjectors,
    directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
    capabilityTools,
    additionalTools,
    tasks,
    warnings,
    skillVisibility: skillVisibleForHost,
  });
  state.scheduler = startedScheduler;
  // Tool registries are validated against a host this process binds: the
  // send tools resolve their host, and a missing one is a hard failure. Both
  // hosts are always bound, even while Telegram has no instance.
  const preview = previewContext('telegram');
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    imageConfig: {
      prepare: (candidate) =>
        imageService === undefined ? Promise.resolve(undefined) : imageService.prepareConfig(candidate, secrets),
      publish: (snapshot) => imageService?.publishConfig(snapshot as Parameters<ImageService['publishConfig']>[0]),
    },
    // A published token is the connection manager's to act on; reading it here
    // keeps a broken SecretRef a connection state instead of an apply failure.
    telegramConfig: {
      prepare: (candidate) => resolveTelegramTokenSource(candidate, secrets),
      publish: (source) => telegramConnection.applyToken(source),
    },
    validateAgentModel: (model) =>
      runtime.validateAdditionalTools(
        preview,
        additionalTools(preview, Number.MAX_SAFE_INTEGER, unavailableCapabilities()),
        model,
      ),
    // A raised max_concurrency only takes effect on the next scheduler tick.
    onPublished: () => {
      startedScheduler.wake();
      // A hand-edited prompt file picked up by this apply becomes a version
      // here; panel saves already recorded themselves before applying.
      recordPromptVersionsFromConfig(store.orm, configStore.current().config);
    },
  });
  const commands = new BotCommandService(
    store,
    configStore,
    startedScheduler,
    modelSwitcher,
    conversationRuntime,
    configReloader,
  );
  mcpManager.setRegistryValidator((mcpTools) => {
    const snapshot = configStore.current();
    for (const { model } of configuredAgentModels(snapshot.config, snapshot.models)) {
      runtime.validateAdditionalTools(preview, mcpTools, model);
    }
  });
  // A live update goes through the same ingestion, command and status path the
  // serve loop used to install on the bot; the manager calls it per connection.
  const onUpdate = async (context: Context, ingestion: TelegramIngestion): Promise<void> => {
    const result = ingestion.ingest(context.update);
    // A sleeping bot skips queued invocations, so a status would promise a
    // reply that never comes.
    if (result.mention !== undefined && activeSleepUntil(store.orm) === null) {
      const target = resolveConversation(store, result.mention);
      telegramHost.activity.start({ conversation: target, policy: telegramHost.policy(target) }, 'until_delivery');
    }
    if (result.command !== undefined) {
      await replyToCommand(context, commands, result.command);
    }
    startedScheduler.wake();
  };
  // The Telegram connection starts here, after the store, the panel command path
  // and the scheduler exist. It resolves after the first attempt, so a slow or
  // unreachable Telegram does not delay the scheduler; a healthy token finishes
  // the cold backlog drain before the scheduler launches its first batch.
  await telegramConnection.start({
    onUpdate,
    coldCatchUp: async (api, ingestion, signal) => {
      const catchUp = await runStartupCatchUp({
        api,
        store,
        ingestion,
        scheduler: startedScheduler,
        commands,
        allowedUpdates: ALLOWED_UPDATES,
        signal,
      });
      logEvent('startup_catch_up_completed', {
        updates: catchUp.updates,
        stored_messages: catchUp.storedMessages,
        invocations: catchUp.invocationIds.length,
      });
    },
    // A replaced token or a recovered connection drains the bot-wide backlog
    // again, but only the newest messages of each chat; the Scheduler must not
    // start Telegram work until this pass is part of the connection.
    runtimeCatchUp: async (api, ingestion, signal, me) => {
      await runRuntimeCatchUp({
        api,
        ingestion,
        commands,
        scheduler: startedScheduler,
        allowedUpdates: ALLOWED_UPDATES,
        botUsername: me.username ?? null,
        signal,
      });
    },
  });
  await mcpManager.start();
  startedScheduler.start();
  return { runtime, startedScheduler, conversationRuntime, configReloader, commands };
}

/** Starts the Admin panel when the config enables it; a no-op otherwise. */
export async function startAdminServer(session: ServeContext, assembly: ServeAssembly, core: ServeCore): Promise<void> {
  const { loaded, secrets, requestRestart, replayShutdown, state } = session;
  const {
    store,
    configStore,
    tasks,
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
    warnings,
    connections,
  } = assembly;
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
      modelSwitcher,
      configReloader,
      secrets,
      warnings,
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
