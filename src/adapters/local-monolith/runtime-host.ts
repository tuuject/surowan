/** Local process composition root: owns transport, files, locks and lifecycle. */
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Bot, type Context } from 'grammy';
import { PlaygroundAssetStore } from '../../capabilities/media/local-assets.ts';
import { McpManager } from '../../capabilities/mcp.ts';
import { MediaService } from '../../capabilities/media/media.ts';
import { TelegramMediaClient } from '../../capabilities/media/media-download.ts';
import { StickerService } from '../../capabilities/stickers.ts';
import { createTelegramHost, grammyTelegramTransport, type TelegramHost } from './telegram-host.ts';
import { MemoryStore } from '../../context/memory.ts';
import { createImageBridge, type ImageBridge } from '../../image/bridge.ts';
import { generationEligibilityForHosts } from '../../image/host-eligibility.ts';
import { createImageService, type ImageService } from '../../image/service.ts';
import { AdminQueryError } from '../../ingress/admin/audit.ts';
import { AdminServer } from '../../ingress/admin/server.ts';
import { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import { createCoreRuntime } from '../../orchestration/runtime.ts';
import {
  BOT_COMMANDS,
  BotCommandService,
  commandSender,
  type ParsedCommand,
  registerBotCommands,
} from '../../orchestration/bot-commands.ts';
import { ReplayError, ReplayRunner } from '../../orchestration/replay.ts';
import type { BucketScheduler } from '../../orchestration/scheduler.ts';
import { KeyedSemaphore } from '../../platform/concurrency.ts';
import { toChatId, toConversationId, type HostKind, type ImConversationRef } from '../../platform/im-host.ts';
import { assertConfigPermissions, loadConfig } from './config.ts';
import { ConfigReloader } from './config-reload.ts';
import { createHostTooling, imageDeliveryResolver } from './host-tooling.ts';
import { previewContext, unavailableCapabilities } from '../../platform/invocation-context.ts';
import { keyJarPath } from '../../platform/key-jar.ts';
import { AgentModelSwitcher } from '../../platform/model-switch.ts';
import { buildModelRegistry, configuredAgentModels } from '../../platform/providers.ts';
import { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { SecretStore } from '../../platform/secrets.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, FileSystemResources } from './system-resources.ts';
import { BUNDLED_MANUAL_DIR, bundledManualSpace, FileSystemDocSpaces } from './doc-spaces.ts';
import { BUILTIN_PLUGINS } from '../../plugins/builtin.ts';
import { loadPlugins } from '../../plugins/plugin.ts';
import { runStartupCatchUp } from '../../startup-catch-up.ts';
import { ServeLock, SqliteStore, stopRunningInstance, watchStopRequests } from './database.ts';
import { LongTaskService } from '../../store/long-tasks.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { recordPromptVersionsFromConfig } from '../../store/prompt-versions.ts';
import type { BusinessStore } from '../../store/store.ts';
import { appState, chats, conversations } from '../../store/schema.ts';

const ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'] as const;

/**
 * Exit code of a panel-requested restart. `EX_TEMPFAIL` marks an intentional
 * stop that a supervisor should bring back, and stays distinguishable from a
 * crash in logs and container restart policies.
 */
export const RESTART_EXIT_CODE = 75;

export async function serve(configPath: string, takeover = false): Promise<void> {
  const loaded = await loadConfig(configPath);
  await assertConfigPermissions(loaded.configPath);
  const secrets = new SecretStore(keyJarPath(loaded.configPath));
  let lock: ServeLock | undefined;
  let stopWatcher: (() => void) | undefined;
  let store: SqliteStore | undefined;
  let imageService: ImageService | undefined;
  let imageBridge: ImageBridge | undefined;
  let bot: Bot | undefined;
  let scheduler: BucketScheduler | undefined;
  let stickers: StickerService | undefined;
  let mcp: McpManager | undefined;
  let host: TelegramHost | undefined;
  let admin: AdminServer | undefined;
  let startupCatchUpController: AbortController | undefined;
  const replayShutdown = new AbortController();
  let shuttingDown = false;
  let restartRequested = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logEvent('shutdown_requested');
    startupCatchUpController?.abort(new Error('shutdown'));
    replayShutdown.abort(new Error('shutdown'));
    // Unblock bot.start() so the finally block below runs the full cleanup.
    // grammY's stop() also fires a best-effort offset-confirming getUpdates;
    // swallow its rejection so it can never become an unhandled promise
    // rejection and crash the process mid-shutdown.
    void bot?.stop().catch(() => undefined);
  };
  /**
   * The Admin Panel's restart: the same graceful shutdown as a signal, but the
   * process leaves with `RESTART_EXIT_CODE` so the supervisor starts it again.
   *
   * Shutdown reaches `admin.stop()` only through the `finally` block below,
   * after `bot.stop()` has unblocked `bot.start()`, so the panel's 202 is long
   * gone by the time the Admin server destroys its connections. Anything that
   * stops the Admin server earlier would cut that response off.
   */
  const requestRestart = (): void => {
    if (restartRequested || shuttingDown) {
      return;
    }
    restartRequested = true;
    logEvent('restart_requested');
    shutdown();
  };
  const stopSignals = watchStopSignals(shutdown, (signal) => {
    // 130/143 = 128 + the signal number: the shell's convention for a process
    // that died of a signal, which is what an interrupted drain is.
    const code = signal === 'SIGTERM' ? 143 : 130;
    logEvent('shutdown_forced', { signal });
    // Under a supervisor stdout is a pipe and its writes are asynchronous, so
    // leave from the flush callback; a write that never lands is still bounded
    // by the timer.
    const timer = setTimeout(() => process.exit(code), 250);
    process.stdout.write('', () => {
      clearTimeout(timer);
      process.exit(code);
    });
  });
  try {
    const token = await secrets.resolve(loaded.config.telegram.token);
    if (takeover) {
      // Stop the incumbent only once this process knows it can start at all:
      // the config, its permissions and the bot token are checked by now.
      const stopped = await stopRunningInstance(loaded.config.data_dir);
      logEvent('takeover_completed', { stopped: stopped !== null, stopped_pid: stopped?.pid ?? null });
    }
    lock = await ServeLock.acquire(loaded.config.data_dir);
    stopWatcher = watchStopRequests(loaded.config.data_dir, () => {
      logEvent('takeover_requested');
      shutdown();
    });
    store = await SqliteStore.open(loaded.config);
    const openedStore = store;
    // The startup load is the first place a hand-edited prompt file becomes
    // visible to the process; record the starting versions before any apply.
    recordPromptVersionsFromConfig(openedStore.orm, loaded.config);
    // Both hosts run through this process's shared runtime and scheduler, so
    // image work of either may execute here. The Playground-only lifecycle
    // narrows this set when it does not construct the Telegram host.
    const servedHosts: readonly HostKind[] = ['telegram', 'playground'];
    const imageEligible = generationEligibilityForHosts(openedStore, servedHosts);
    imageService = createImageService(openedStore, loaded.config, {
      logger: { warn: (message) => logEvent('image_service_warning', { message }) },
      executionEligibility: imageEligible,
    });
    try {
      imageService.publishConfig(await imageService.prepareConfig(loaded.config, secrets));
    } catch (error) {
      // Image generation is optional; an unusable snapshot must not stop the bot.
      logEvent('image_service_warning', {
        message: secrets.redact(error instanceof Error ? error.message : String(error)),
      });
    }
    logEvent('image_service_started', {
      image_dir: imageService.imageDir,
      enabled: imageService.core.config.hasValidConfig(),
    });
    if (loaded.warnings.length > 0) {
      logEvent('config_warnings', { warnings: loaded.warnings.join(' | ') });
    }
    bot = new Bot(token);
    // The registry is built once here and republished by every reload; the
    // configuration and its models always travel together.
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
    const modelSwitcher = new AgentModelSwitcher(configStore);
    const me = await bot.api.getMe();
    try {
      await registerBotCommands(bot.api);
      logEvent('commands_registered', { commands: BOT_COMMANDS.map((entry) => entry.command).join(',') });
    } catch (error) {
      // Registration is convenience only: command parsing works without the
      // Telegram menu, so a failed setMyCommands must not block startup.
      logEvent('command_registration_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const initialized =
      store.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, 'telegram_initialized'))
        .get() !== undefined;
    await bot.api.deleteWebhook({ drop_pending_updates: !initialized });
    if (!initialized) {
      store.orm
        .insert(appState)
        .values({ key: 'telegram_initialized', value: '1', updatedAt: new Date().toISOString() })
        .run();
    }
    const ingestion = new TelegramIngestion(store, configStore, me);
    const modelGate = new KeyedSemaphore();
    const mediaClient = new TelegramMediaClient(bot.api, token);
    const playgroundAssets = new PlaygroundAssetStore({
      orm: store.orm,
      root: join(configStore.current().config.data_dir, 'images', 'playground'),
    });
    const media = new MediaService({
      store,
      configStore,
      secrets,
      mediaClient,
      modelGate,
      localAssets: playgroundAssets,
    });
    const stickerService = new StickerService({ store, config: loaded.config, api: bot.api, media });
    stickers = stickerService;
    await stickerService.sync();
    stickerService.start();
    const mcpManager = new McpManager(store, loaded.config, secrets);
    mcp = mcpManager;
    const memoryStore = new MemoryStore(store.orm);
    const tasks = new LongTaskService(store.orm, () => scheduler?.wake());
    const bridge = createImageBridge({
      service: imageService,
      store: openedStore,
      tasks,
      eligible: imageEligible,
      prepareInputImage: (mediaId, signal) => media.prepareInputImage(mediaId, signal),
    });
    imageBridge = bridge;
    bridge.reconcile();
    const plugins = loadPlugins(BUILTIN_PLUGINS, {
      image: imageBridge,
    });
    const systemResources = await FileSystemResources.load(BUNDLED_SYSTEM_RESOURCES_DIR, plugins.skillDirectories);
    logEvent('system_skills_loaded', { skills: systemResources.skills.map((skill) => skill.name).join(',') });
    // Bundled documentation spaces: the user manual packed at build time. A
    // missing pack only disables the document capabilities; doctor reports it.
    const docSpaces = await FileSystemDocSpaces.load([bundledManualSpace(BUNDLED_MANUAL_DIR)]);
    logEvent('doc_spaces_loaded', {
      spaces: docSpaces.summaries.map((space) => `${space.id}:${space.documents}`).join(','),
    });
    if (docSpaces.missing.length > 0) {
      logEvent('doc_spaces_missing', { spaces: docSpaces.missing.join(',') });
    }
    // The host profile, the plugins' host lists and the image bridge's
    // per-conversation switch are decided in exactly one place.
    const tooling = createHostTooling({
      store: openedStore,
      configStore,
      plugins,
      media,
      memory: memoryStore,
      stickers: stickerService,
      mcp: mcpManager,
      tasks,
      docSpaces,
      ...(imageBridge === undefined ? {} : { imageBridge }),
    });
    const skillVisibleForHost = tooling.skillVisible;
    // Runtime-internal capabilities: dispatched through the execute primitive.
    // The host profile decides which of them exist at all, so a Playground
    // room never inherits Telegram-only tools just because they are configured.
    const capabilityTools = tooling.capabilityTools;
    // Directly exposed non-primitive tools: allowlisted MCP tools only.
    const additionalTools = tooling.additionalTools;
    // One host for both delivery and chat action: its per-conversation activity
    // bookkeeping is what keeps the ingestion status and the model's own
    // `typing` call from doubling up requests.
    const telegramHost = createTelegramHost({
      transport: grammyTelegramTransport(bot.api),
      sendRate: () => ({
        sendsPerWindow: configStore.current().config.agent.rate_limits.sends_per_window,
        windowSeconds: configStore.current().config.agent.rate_limits.window_seconds,
      }),
    });
    host = telegramHost;
    const {
      runtime,
      scheduler: startedScheduler,
      conversationRuntime,
    } = createCoreRuntime({
      store,
      configStore,
      secrets,
      host: telegramHost,
      conversation: (target) => resolveConversation(openedStore, target),
      ...(imageBridge === undefined
        ? {}
        : {
            imageGeneration: imageDeliveryResolver(imageBridge),
          }),
      bot: {
        id: BigInt(me.id),
        displayName: [me.first_name, me.last_name].filter((part) => part !== undefined).join(' '),
        username: me.username ?? null,
      },
      modelGate,
      systemResources,
      contextInjectors: plugins.contextInjectors,
      directImageLoader: (context, signal) => media.loadDirectImages(context.directImages, signal),
      capabilityTools,
      additionalTools,
      tasks,
      skillVisibility: skillVisibleForHost,
    });
    scheduler = startedScheduler;
    const preview = previewContext();
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
        recordPromptVersionsFromConfig(openedStore.orm, configStore.current().config);
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
    const catchUpController = new AbortController();
    startupCatchUpController = catchUpController;
    const catchUp = await runStartupCatchUp({
      api: bot.api,
      store,
      ingestion,
      scheduler: startedScheduler,
      commands,
      allowedUpdates: ALLOWED_UPDATES,
      signal: catchUpController.signal,
    });
    startupCatchUpController = undefined;
    logEvent('startup_catch_up_completed', {
      updates: catchUp.updates,
      stored_messages: catchUp.storedMessages,
      invocations: catchUp.invocationIds.length,
    });
    await mcpManager.start();
    startedScheduler.start();
    if (loaded.config.admin?.enabled === true) {
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
        requestRestart,
        imageService,
        imageBridge,
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
      admin = adminServer;
      const listening = await adminServer.start();
      logEvent('admin_started', { host: listening.hostname, port: listening.port });
    }
    bot.use(async (context) => {
      const result = ingestion.ingest(context.update);
      // A sleeping bot skips queued invocations, so a status would promise a reply that never comes.
      if (result.mention !== undefined && activeSleepUntil(openedStore.orm) === null) {
        const target = resolveConversation(openedStore, result.mention);
        telegramHost.activity.start({ conversation: target, policy: telegramHost.policy(target) }, 'until_delivery');
      }
      if (result.command !== undefined) {
        await replyToCommand(context, commands, result.command);
      }
      startedScheduler.wake();
    });
    logEvent('serve_started', { bot_id: String(me.id), config_hash: loaded.hash });
    await bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(secrets.redact(message));
  } finally {
    // The signal handlers outlive the drain below: that wait is what a second
    // signal exists to cut short. Without a handler Node falls back to the
    // default action, which skips `shutdown_forced` and, for a container's
    // PID 1, ignores the signal altogether.
    try {
      replayShutdown.abort(new Error('shutdown'));
      stopWatcher?.();
      await admin?.stop();
      await scheduler?.stop(30_000);
      host?.activity.stopAll();
      // The image worker borrows the SQLite connection; it must settle (marking
      // late results interrupted if the shutdown budget expires) before the
      // store closes underneath it.
      imageBridge?.stop();
      await imageService?.stop();
      await stickers?.stop();
      await mcp?.stop();
      store?.close();
      await lock?.release();
    } finally {
      stopSignals();
    }
  }
  if (restartRequested) {
    logEvent('restart_exit', { code: RESTART_EXIT_CODE });
    // Leaving through the exit code lets pending output flush; the unref'd timer
    // only fires if some handle outlives the cleanup, so the supervisor is not
    // left waiting on a process that cannot finish.
    process.exitCode = RESTART_EXIT_CODE;
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 1_000).unref();
  }
}

export function logEvent(event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

/**
 * Two-stage stop for SIGINT and SIGTERM: the first signal starts the graceful
 * shutdown, a second one calls `forceExit` instead of waiting for the drain.
 *
 * The escape hatch exists because the drain budget is a wait the operator may
 * not want: an Invocation that refuses to settle keeps the process alive until
 * its own abort lands. Forcing leaves the same state as a supervisor's SIGKILL
 * — the interrupted Invocation is recovered as `process_restart` on the next
 * start — and a signal that arrives after an internal shutdown (takeover,
 * panel restart) still needs its own first press.
 */
export function watchStopSignals(shutdown: () => void, forceExit: (signal: NodeJS.Signals) => void): () => void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      forceExit(signal);
      return;
    }
    stopping = true;
    shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

/**
 * Resolves the conversation a delivery or activity call targets.
 *
 * The runtime never invents a chat route: the chat kind that decides the
 * conversation policy and the conversation row itself both come from storage,
 * so a group and a private chat with the same id cannot be confused, and a
 * delivery always lands on a conversation the server already knows about.
 */
export function resolveConversation(
  store: BusinessStore,
  target: { readonly chatId: bigint; readonly threadId: bigint; readonly conversationId?: bigint },
): ImConversationRef {
  const orm = store.orm;
  // The conversation row decides the host when the caller has one: the same
  // numeric value can be a Telegram chat id and a room's internal chat id, and
  // only the row knows which. Ingestion's mention target carries no
  // conversation id, so that path resolves a Telegram chat by its wire id.
  if (target.conversationId !== undefined && target.conversationId !== 0n) {
    const row = orm
      .select({
        id: conversations.id,
        chatId: conversations.chatId,
        threadId: conversations.messageThreadId,
        hostKind: chats.hostKind,
        type: chats.type,
        telegramChatId: chats.telegramChatId,
      })
      .from(conversations)
      .innerJoin(chats, eq(chats.id, conversations.chatId))
      .where(eq(conversations.id, target.conversationId))
      .get();
    if (row !== undefined) {
      const hostKind: HostKind = row.hostKind === 'playground' ? 'playground' : 'telegram';
      return {
        host: hostKind,
        id: toConversationId(row.id),
        chatId: toChatId((hostKind === 'telegram' ? row.telegramChatId : row.chatId)?.toString() ?? '0'),
        topicId: row.threadId === 0n ? null : Number(row.threadId),
        scope: row.type === 'private' ? 'private' : 'group',
      };
    }
  }
  const chat = orm
    .select({ id: chats.id, type: chats.type })
    .from(chats)
    .where(and(eq(chats.hostKind, 'telegram'), eq(chats.telegramChatId, target.chatId)))
    .get();
  const conversation =
    chat === undefined
      ? undefined
      : orm
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.chatId, chat.id), eq(conversations.messageThreadId, target.threadId)))
          .get();
  return {
    host: 'telegram',
    id: toConversationId(conversation?.id ?? 0n),
    chatId: toChatId(target.chatId.toString()),
    topicId: target.threadId === 0n ? null : Number(target.threadId),
    scope: chat?.type === 'private' ? 'private' : 'group',
  };
}

async function replyToCommand(context: Context, commands: BotCommandService, command: ParsedCommand): Promise<void> {
  const message = context.update.message;
  if (message === undefined) {
    return;
  }
  const chatId = message.chat.id;
  const sender = commandSender(message);
  let text: string;
  try {
    text = await commands.run(command, BigInt(chatId), sender);
  } catch (error) {
    logEvent('command_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    await context.api.sendMessage(String(chatId), text, {
      ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
      reply_parameters: { message_id: message.message_id },
    });
    logEvent('command_reply_sent', { command: command.name, chat_id: String(chatId) });
  } catch (error) {
    logEvent('command_reply_failed', {
      command: command.name,
      chat_id: String(chatId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
