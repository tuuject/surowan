/**
 * Startup phases of `serve`: the environment and the services behind it, built
 * in the order the composition root used to build them inline. Each phase
 * returns what the next one consumes and publishes its teardown handles on the
 * shared serve state; the contracts between phases live here.
 */
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import { McpManager } from '../../capabilities/mcp.ts';
import { PlaygroundAssetStore } from '../../capabilities/media/local-assets.ts';
import { MediaService } from '../../capabilities/media/media.ts';
import type { MediaDownloader } from '../../capabilities/media/media-download.ts';
import { StickerService } from '../../capabilities/stickers.ts';
import { MemoryStore } from '../../context/memory.ts';
import { createImageBridge, type ImageBridge } from '../../image/bridge.ts';
import { generationEligibilityForHosts } from '../../image/host-eligibility.ts';
import { createImageService, type ImageService } from '../../image/service.ts';
import { PlaygroundIngress } from '../../ingress/playground.ts';
import { TelegramIngestion } from '../../ingress/telegram-ingestion.ts';
import { BOT_COMMANDS, registerBotCommands } from '../../orchestration/bot-commands.ts';
import type { HostReadiness } from '../../orchestration/host-scope.ts';
import { KeyedSemaphore } from '../../platform/concurrency.ts';
import { ImConnectionRegistry } from '../../platform/im-connection.ts';
import type { HostKind, ImHost } from '../../platform/im-host.ts';
import { AgentModelSwitcher } from '../../platform/model-switch.ts';
import { buildModelRegistry } from '../../platform/providers.ts';
import { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import { WARNING_READ_RETENTION_DAYS as DEFAULT_WARNING_READ_RETENTION_DAYS } from '../../platform/warning-catalog.ts';
import { BUILTIN_PLUGINS } from '../../plugins/builtin.ts';
import { type LoadedPlugins, loadPlugins } from '../../plugins/plugin.ts';
import { LongTaskService } from '../../store/long-tasks.ts';
import { PlaygroundStore } from '../../store/playground.ts';
import { recordPromptVersionsFromConfig } from '../../store/prompt-versions.ts';
import { appState } from '../../store/schema.ts';
import { WarningService } from '../../store/warnings.ts';
import { ServeLock, SqliteStore, stopRunningInstance, watchStopRequests } from './database.ts';
import { BUNDLED_MANUAL_DIR, bundledManualSpace, FileSystemDocSpaces } from './doc-spaces.ts';
import { createHostTooling, type HostTooling } from './host-tooling.ts';
import { logEvent, type ServeContext } from './runtime-host-support.ts';
import { BUNDLED_SYSTEM_RESOURCES_DIR, FileSystemResources } from './system-resources.ts';
import type { TelegramHost } from './telegram-host.ts';
import { ForwardingTelegramMedia, type TelegramIdentity, TelegramInstanceHolder } from './telegram-instance.ts';

/** The identity a Bot reports for itself; absent on a Playground-only process. */
export type { TelegramIdentity } from './telegram-instance.ts';

/** What the environment phase produced: the resolved token and the open store. */
export interface ServeEnvironment {
  readonly token: string | undefined;
  readonly store: SqliteStore;
  readonly connections: ImConnectionRegistry;
}

/** Every live object the running phases share, built once and passed by reference. */
export interface ServeServices {
  readonly token: string | undefined;
  readonly store: SqliteStore;
  readonly imageService: ImageService;
  readonly imageBridge: ImageBridge;
  readonly configStore: RuntimeConfigurationStore;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly bot: Bot | undefined;
  readonly me: TelegramIdentity | undefined;
  readonly ingestion: TelegramIngestion | undefined;
  /** The one slot the Telegram adapters read; empty while Telegram is stopped. */
  readonly telegram: TelegramInstanceHolder;
  /** Live per-namespace connection state, shared by the panel and the Scheduler. */
  readonly connections: ImConnectionRegistry;
  /** Whether one host may execute work right now. */
  readonly isHostReady: HostReadiness;
  readonly modelGate: KeyedSemaphore;
  readonly playgroundAssets: PlaygroundAssetStore;
  readonly media: MediaService;
  readonly mediaClient: MediaDownloader;
  readonly mcpManager: McpManager;
  readonly tasks: LongTaskService;
  readonly warnings: WarningService;
  readonly playgroundStore: PlaygroundStore;
  readonly playgroundIngress: PlaygroundIngress;
  readonly plugins: LoadedPlugins;
  readonly systemResources: FileSystemResources;
  readonly skillVisibleForHost: HostTooling['skillVisible'];
  readonly capabilityTools: HostTooling['capabilityTools'];
  readonly additionalTools: HostTooling['additionalTools'];
}

/** The two transports this process exposes, plus the identity a room shows. */
export interface ServeHosts {
  readonly telegramHost: TelegramHost;
  readonly playgroundHost: ImHost;
  readonly playgroundSelfName: string;
}

/** Construction result of the startup phases, as the run phases receive it. */
export interface ServeAssembly extends ServeServices, ServeHosts {}

/**
 * Resolves the token and takes ownership of the data directory: the takeover,
 * the serve lock, the stop watcher and the store all belong to this phase.
 */
export async function openServeEnvironment(session: ServeContext): Promise<ServeEnvironment> {
  const { loaded, secrets, takeover, playgroundOnly, state } = session;
  // A Playground-only process never resolves the Telegram token: an
  // unusable or deliberately absent SecretRef must not stop it. An absent
  // token means Telegram is disabled, which is now a legal configuration.
  const tokenReference = loaded.config.telegram.token;
  const token = playgroundOnly || tokenReference === undefined ? undefined : await secrets.resolve(tokenReference);
  // One registry per process. Nothing has opened a connection yet, so every IM
  // namespace starts disabled; the phases below publish each transition.
  const connections = new ImConnectionRegistry();
  if (takeover) {
    // Stop the incumbent only once this process knows it can start at all:
    // the config, its permissions and the bot token are checked by now.
    const stopped = await stopRunningInstance(loaded.config.data_dir);
    logEvent('takeover_completed', { stopped: stopped !== null, stopped_pid: stopped?.pid ?? null });
  }
  state.lock = await ServeLock.acquire(loaded.config.data_dir);
  state.stopWatcher = watchStopRequests(loaded.config.data_dir, () => {
    logEvent('takeover_requested');
    session.shutdown();
  });
  state.store = await SqliteStore.open(loaded.config);
  const openedStore = state.store;
  // The startup load is the first place a hand-edited prompt file becomes
  // visible to the process; record the starting versions before any apply.
  recordPromptVersionsFromConfig(openedStore.orm, loaded.config);
  return { token, store: openedStore, connections };
}

/**
 * Builds everything that hangs off the store and the image service: the
 * Telegram bot, media, stickers, MCP, long tasks, the room write path, the
 * plugin set and the tool wiring the hosts share.
 */
export async function startServeServices(session: ServeContext, environment: ServeEnvironment): Promise<ServeServices> {
  const { loaded, secrets, playgroundOnly, state } = session;
  const { token, store, connections } = environment;
  const openedStore = store;
  // Hosts are fixed for the process lifetime. Whether one may execute work is a
  // live question answered by `isHostReady`; a Telegram that is disabled, still
  // connecting or misconfigured keeps its work in place instead of having the
  // whole host disappear from the Scheduler and the image worker.
  const servedHosts: readonly HostKind[] = ['telegram', 'playground'];
  const isHostReady: HostReadiness = (host) => host === 'playground' || connections.isReady(host);
  const imageEligible = generationEligibilityForHosts(openedStore, servedHosts, isHostReady);
  const imageService = createImageService(openedStore, loaded.config, {
    logger: { warn: (message) => logEvent('image_service_warning', { message }) },
    executionEligibility: imageEligible,
  });
  state.imageService = imageService;
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
  // The registry is built once here and republished by every reload; the
  // configuration and its models always travel together.
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const warnings = new WarningService(openedStore.orm);
  warnings.start({
    retentionDays: () =>
      configStore.current().config.retention.warning_read_days ?? DEFAULT_WARNING_READ_RETENTION_DAYS,
  });
  state.warnings = warnings;
  const modelSwitcher = new AgentModelSwitcher(configStore);
  // Telegram objects exist only while the process holds an instance. A
  // Playground-only process (and a deployment with no token) owns none: no
  // Bot, no command registration, no webhook delete, no ingestion and no
  // sticker sync. The panel and room write path are independent of Telegram.
  const telegram = new TelegramInstanceHolder();
  let me: TelegramIdentity | undefined;
  let ingestion: TelegramIngestion | undefined;
  let bot: Bot | undefined;
  if (!playgroundOnly && token !== undefined) {
    bot = new Bot(token);
    state.bot = bot;
    me = await bot.api.getMe();
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
      openedStore.orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, 'telegram_initialized'))
        .get() !== undefined;
    await bot.api.deleteWebhook({ drop_pending_updates: !initialized });
    if (!initialized) {
      openedStore.orm
        .insert(appState)
        .values({ key: 'telegram_initialized', value: '1', updatedAt: new Date().toISOString() })
        .run();
    }
    ingestion = new TelegramIngestion(openedStore, configStore, me);
    telegram.set({ api: bot.api, bot, token, me });
    connections.set('telegram', {
      status: 'connected',
      since: new Date().toISOString(),
      bot: { id: String(me.id), username: me.username ?? null },
    });
  }
  const modelGate = new KeyedSemaphore();
  // One downloader for the process lifetime: it follows the current instance,
  // and refuses explicitly when there is none. Room media is read from its own
  // local assets, so that refusal is unreachable for a room.
  const mediaClient: MediaDownloader = new ForwardingTelegramMedia(telegram);
  const playgroundAssets = new PlaygroundAssetStore({
    orm: openedStore.orm,
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
  const stickerService =
    bot === undefined ? undefined : new StickerService({ store, config: loaded.config, api: bot.api, media });
  if (stickerService !== undefined) {
    state.stickers = stickerService;
    await stickerService.sync();
    stickerService.start();
  }
  // MCP does not belong to Telegram: it is always constructed and started,
  // whether or not this process holds a Telegram instance.
  const mcpManager = new McpManager(store, loaded.config, secrets);
  state.mcp = mcpManager;
  const memoryStore = new MemoryStore(openedStore.orm);
  const tasks = new LongTaskService(openedStore.orm, () => state.scheduler?.wake(), servedHosts);
  // The room write path: an admitted input is held, a Release seals it into a
  // queued invocation through the same ledger Telegram uses.
  const playgroundStore = new PlaygroundStore(openedStore.orm);
  const playgroundIngress = new PlaygroundIngress(openedStore.orm, {
    assets: playgroundAssets,
    onQueued: () => state.scheduler?.wake(),
  });
  const bridge = createImageBridge({
    service: imageService,
    store: openedStore,
    tasks,
    eligible: imageEligible,
    prepareInputImage: (mediaId, signal) => media.prepareInputImage(mediaId, signal),
  });
  state.imageBridge = bridge;
  bridge.reconcile();
  const plugins = loadPlugins(BUILTIN_PLUGINS, {
    image: bridge,
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
    ...(stickerService === undefined ? {} : { stickers: stickerService }),
    mcp: mcpManager,
    tasks,
    docSpaces,
    ...(bridge === undefined ? {} : { imageBridge: bridge }),
  });
  const skillVisibleForHost = tooling.skillVisible;
  // Runtime-internal capabilities: dispatched through the execute primitive.
  // The host profile decides which of them exist at all, so a Playground
  // room never inherits Telegram-only tools just because they are configured.
  const capabilityTools = tooling.capabilityTools;
  // Directly exposed non-primitive tools: allowlisted MCP tools only.
  const additionalTools = tooling.additionalTools;
  return {
    token,
    store,
    imageService,
    imageBridge: bridge,
    configStore,
    modelSwitcher,
    bot,
    me,
    ingestion,
    telegram,
    connections,
    isHostReady,
    modelGate,
    playgroundAssets,
    media,
    mediaClient,
    mcpManager,
    tasks,
    warnings,
    playgroundStore,
    playgroundIngress,
    plugins,
    systemResources,
    skillVisibleForHost,
    capabilityTools,
    additionalTools,
  };
}
