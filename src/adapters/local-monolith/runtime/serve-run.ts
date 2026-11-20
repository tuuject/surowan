/**
 * Running phases of `serve`: the hosts, the core runtime, the Admin panel and
 * the loops that keep the process alive until the shutdown path resolves.
 */

import { reconcileStickerSets } from '../../../capabilities/stickers/sets.ts';
import { ConversationContextStore } from '../../../context/store/index.ts';
import { WEB_SEARCH_PROVIDERS } from '../../../plugins/web-search/extension.ts';
import { runStartupCatchUp } from '../../../ingress/telegram-ingestion/catch-up/startup.ts';
import { runRuntimeCatchUp } from '../../../ingress/telegram-ingestion/catch-up/runtime.ts';
import { recordPromptVersionsFromConfig } from '../../../store/prompt-versions.ts';
import type { ImageService } from '../../../image/service.ts';
import { BotCommandService } from '../../../orchestration/bot-commands/index.ts';
import { type CoreRuntime, createCoreRuntime } from '../../../orchestration/runtime.ts';
import type { ImHost } from '../../../platform/im-host/index.ts';
import { webSearchAvailable } from '../../../platform/web-search.ts';
import { ConfigReloader } from '../config/reload.ts';
import { imageDeliveryResolver } from '../host-tooling.ts';
import { createPlaygroundHost } from '../playground/index.ts';
import { createRoomProfiles } from '../playground/profiles.ts';
import { resolveTelegramTokenSource } from '../telegram/connection-token.ts';
import { createTelegramHost } from '../telegram/host.ts';
import { forwardingTelegramTransport, TelegramConnectionIdentity } from '../telegram/instance.ts';
import { createTelegramProfiles } from '../telegram/profiles.ts';
import { createTelegramUpdateHandler } from '../telegram/updates.ts';
import {
  addedTelegramChatIds,
  conversationIdsForTelegramChats,
  publishGroupMemory,
  removedTelegramChatIds,
  stopRemovedChats,
} from './chat-lifecycle.ts';
import { createMcpPublication } from './mcp-publication.ts';
import type { ServeAssembly, ServeHosts, ServeServices } from './serve.ts';
import { configuredStickerSets, publishStickerSets } from './sticker-sets.ts';
import { ALLOWED_UPDATES, logEvent, resolveConversation, type ServeContext } from './support.ts';
import { abortRunningInvocationsOnSearchDisable } from './web-search-availability.ts';

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
    // Profiles are read through whichever instance is current: a connection
    // that opens after this host exists makes them available, and one that
    // stops takes them away, without rebuilding the tool registry.
    profiles: () => {
      const instance = services.telegram.current;
      return instance === undefined
        ? undefined
        : createTelegramProfiles({
            api: instance.api,
            store: services.store,
            download: services.mediaClient,
            mediaCache: () => services.configStore.current().config.paths.media_cache,
          });
    },
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
  const roomProfiles = createRoomProfiles({
    store: services.store,
    self: new TelegramConnectionIdentity(services.telegram),
  });
  const playgroundHost: ImHost = createPlaygroundHost({
    store: services.store,
    self: new TelegramConnectionIdentity(services.telegram),
    pictures: services.playgroundAssets,
    profiles: () => roomProfiles,
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
    mcpSkills,
    skillVisibleForHost,
    telegram,
    telegramConnection,
    isHostReady,
    modelSwitcher,
    mcpManager,
    toolImageStore,
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
    toolImageStore,
    mediaFiles: { read: (mediaId, signal) => media.readOriginalFile(mediaId, signal) },
    capabilityTools,
    additionalTools,
    mcpSkills,
    tasks,
    warnings,
    skillVisibility: skillVisibleForHost,
  });
  state.scheduler = startedScheduler;
  // The provider set is decided by the loaded plugins; every configuration read
  // below (and in the panel's write path) validates engine ids against it.
  const searchProviders = plugins.extensions(WEB_SEARCH_PROVIDERS).map((provider) => provider.rule);
  // Availability is a capability-set change, not an ordinary setting: turning
  // search off (or disabling the last engine) removes the tool and its skill,
  // so every running invocation has to stop instead of continuing with a set
  // the next invocation will not see.
  let webSearchWasAvailable = webSearchAvailable(configStore.current().config, searchProviders);
  let publishedConfig = configStore.current().config;
  // The panel lists sticker sets from the store; mirror the started
  // configuration now instead of waiting for a Telegram connection to sync.
  reconcileStickerSets(store, configuredStickerSets(publishedConfig));
  // The configuration the group-memory cutover last completed against. It only
  // advances when a cutover succeeds, so a failed one is retried by the next
  // apply (the reloader reruns this hook while its publication is pending).
  let groupMemoryConfig = publishedConfig;
  // The MCP side of this process: candidate validation, the registry validator
  // and the serialized cutover, all built once in `mcp-publication.ts`.
  const mcpPublication = createMcpPublication({
    store,
    configStore,
    secrets,
    scheduler: startedScheduler,
    conversationRuntime,
    isHostReady,
    mcp: mcpManager,
    runtime,
  });
  const configReloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    providerKeyDigests: assembly.providerKeyDigests,
    jarDigests: assembly.jarDigests,
    mcpServerKeyDigests: assembly.mcpServerKeyDigests,
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
    searchProviders,
    validateAgentModel: (candidate, model) => mcpPublication.validateModel(candidate, model),
    // A raised max_concurrency only takes effect on the next scheduler tick.
    onPublished: async ({ rotatedMcpAliases }) => {
      const nextConfig = configStore.current().config;
      const removedChats = removedTelegramChatIds(publishedConfig, nextConfig);
      if (removedChats.length > 0) {
        const stopped = stopRemovedChats(
          store,
          tasks,
          (ids, reason) => startedScheduler.abortInvocations(ids, reason),
          (conversationId) => conversationRuntime.forget(conversationId),
          removedChats,
          nextConfig,
        );
        logEvent('telegram_chat_removed', {
          chats: removedChats.map((id) => id.toString()).join(','),
          stopped_invocations: stopped.invocations,
          cancelled_tasks: stopped.tasks,
        });
      }
      const addedChats = addedTelegramChatIds(publishedConfig, nextConfig);
      const groupMemory = await publishGroupMemory(
        {
          store,
          stopper: startedScheduler,
          forgetConversation: (conversationId) => conversationRuntime.forget(conversationId),
          reconcileLanes: (config) => assembly.sleeping.reconcile(config),
          redactError: (error) => secrets.redactError(error),
        },
        groupMemoryConfig,
        nextConfig,
      );
      if (groupMemory.cutover) {
        groupMemoryConfig = nextConfig;
      }
      const stickerSets = publishStickerSets(
        {
          store,
          abortInvocations: (ids, reason) => startedScheduler.abortInvocations(ids, reason),
          stickers: () => telegramConnection.stickers,
          onRefreshFailed: (error) =>
            logEvent('telegram_stickers_refresh_failed', { error: secrets.redactError(error) }),
        },
        publishedConfig,
        nextConfig,
      );
      if (stickerSets.changed) {
        logEvent('sticker_sets_published', {
          membership_changed: stickerSets.membershipChanged,
          stopped_invocations: stickerSets.abortedInvocations,
        });
      }
      // MCP servers and per-Chat bindings are adopted here: the affected Chats
      // are stopped and rebuilt before the server instances move, and the
      // consequences are logged as one event per publish. Aliases whose secret
      // references rotated reconnect the same way.
      await mcpPublication.publish(
        publishedConfig,
        nextConfig,
        configStore.current().generation,
        new Set(rotatedMcpAliases),
      );
      publishedConfig = nextConfig;
      if (addedChats.length > 0) {
        // A Chat can be removed and added again while its stored Memo Pad
        // survives; the first run after the re-add must re-render the full list
        // instead of trusting the old snapshot in its retained Context.
        new ConversationContextStore(store).requestMemoRefreshForConversations(
          conversationIdsForTelegramChats(store, addedChats),
        );
      }
      const available = webSearchAvailable(nextConfig, searchProviders);
      if (webSearchWasAvailable && !available) {
        const stopped = abortRunningInvocationsOnSearchDisable(store.orm, (ids, reason) =>
          startedScheduler.abortInvocations(ids, reason),
        );
        logEvent('web_search_disabled', { stopped });
      }
      webSearchWasAvailable = available;
      startedScheduler.wake();
      // A hand-edited prompt file picked up by this apply becomes a version
      // here; panel saves already recorded themselves before applying.
      recordPromptVersionsFromConfig(store.orm, nextConfig);
      if (groupMemory.failure !== undefined) {
        throw groupMemory.failure;
      }
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
  mcpPublication.validateRegistry();
  // A live update goes through the same ingestion, command and status path the
  // serve loop used to install on the bot; the manager calls it per connection.
  const onUpdate = createTelegramUpdateHandler({
    store,
    host: telegramHost,
    commands,
    wake: () => startedScheduler.wake(),
  });
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
  assembly.sleeping.start();
  state.sleeping = assembly.sleeping;
  return { runtime, startedScheduler, conversationRuntime, configReloader, commands };
}
