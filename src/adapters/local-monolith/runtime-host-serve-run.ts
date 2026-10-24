/**
 * Running phases of `serve`: the hosts, the core runtime, the Admin panel and
 * the loops that keep the process alive until the shutdown path resolves.
 */

import type { ImageService } from '../../image/service.ts';
import { AdminQueryError } from '../../ingress/admin/audit.ts';
import { AdminServer } from '../../ingress/admin/server.ts';
import { BotCommandService } from '../../orchestration/bot-commands.ts';
import { ReplayError, ReplayRunner } from '../../orchestration/replay.ts';
import { type CoreRuntime, createCoreRuntime } from '../../orchestration/runtime.ts';
import type { ImHost } from '../../platform/im-host.ts';
import { previewContext, unavailableCapabilities } from '../../platform/invocation-context.ts';
import { configuredAgentModels } from '../../platform/providers.ts';
import { runStartupCatchUp } from '../../startup-catch-up.ts';
import { recordPromptVersionsFromConfig } from '../../store/prompt-versions.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { ConfigReloader } from './config-reload.ts';
import { imageDeliveryResolver } from './host-tooling.ts';
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
  // reads as one bot; a process with no Telegram instance names it itself.
  const playgroundSelfName = new TelegramConnectionIdentity(services.telegram).displayName;
  const playgroundHost: ImHost = createPlaygroundHost({
    store: services.store,
    self: { displayName: playgroundSelfName, username: null },
    pictures: services.playgroundAssets,
    sendRate: () => ({
      sendsPerWindow: services.configStore.current().config.agent.rate_limits.sends_per_window,
      windowSeconds: services.configStore.current().config.agent.rate_limits.window_seconds,
    }),
  });
  state.roomHost = playgroundHost;
  return { telegramHost, playgroundHost, playgroundSelfName };
}

/**
 * Wires the runtime, its reload path and the command service, then starts the
 * background work: catch-up, MCP and the scheduler.
 */
export async function startCoreRuntime(session: ServeContext, assembly: ServeAssembly): Promise<ServeCore> {
  const { loaded, secrets, playgroundOnly, state } = session;
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
    bot,
    ingestion,
    telegram,
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
  // send tools resolve their host, and a missing one is a hard failure.
  const preview = previewContext(playgroundOnly ? 'playground' : 'telegram');
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
  if (bot !== undefined && ingestion !== undefined) {
    const catchUpController = new AbortController();
    state.startupCatchUpController = catchUpController;
    const catchUp = await runStartupCatchUp({
      api: bot.api,
      store,
      ingestion,
      scheduler: startedScheduler,
      commands,
      allowedUpdates: ALLOWED_UPDATES,
      signal: catchUpController.signal,
    });
    state.startupCatchUpController = undefined;
    logEvent('startup_catch_up_completed', {
      updates: catchUp.updates,
      stored_messages: catchUp.storedMessages,
      invocations: catchUp.invocationIds.length,
    });
  }
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

/** Blocks until shutdown: idle when no long polling runs, otherwise until the bot stops. */
export async function runServeLoop(session: ServeContext, assembly: ServeAssembly, core: ServeCore): Promise<void> {
  const { loaded, playgroundOnly, idle } = session;
  const openedStore = assembly.store;
  const startedScheduler = core.startedScheduler;
  const commands = core.commands;
  if (playgroundOnly) {
    // No long polling loop to block on: the process lives until a signal,
    // takeover or panel restart resolves the same idle promise shutdown uses.
    logEvent('serve_started', { mode: 'playground-only', bot_id: null, config_hash: loaded.hash });
    await idle;
    return;
  }
  const instance = assembly.telegram.current;
  if (instance === undefined || instance.bot === undefined || assembly.ingestion === undefined) {
    // Telegram is disabled: the panel and rooms still need the process, so it
    // lives on the same idle promise instead of exiting.
    logEvent('serve_started', { mode: 'telegram-disabled', bot_id: null, config_hash: loaded.hash });
    await idle;
    return;
  }
  const runningBot = instance.bot;
  const runningHost = assembly.telegramHost;
  const runningIngestion = assembly.ingestion;
  runningBot.use(async (context) => {
    const result = runningIngestion.ingest(context.update);
    // A sleeping bot skips queued invocations, so a status would promise a reply that never comes.
    if (result.mention !== undefined && activeSleepUntil(openedStore.orm) === null) {
      const target = resolveConversation(openedStore, result.mention);
      runningHost.activity.start({ conversation: target, policy: runningHost.policy(target) }, 'until_delivery');
    }
    if (result.command !== undefined) {
      await replyToCommand(context, commands, result.command);
    }
    startedScheduler.wake();
  });
  logEvent('serve_started', { bot_id: String(instance.me.id), config_hash: loaded.hash });
  await runningBot.start({ allowed_updates: [...ALLOWED_UPDATES] });
}
