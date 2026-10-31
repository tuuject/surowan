import { join } from 'node:path';
import type { BucketScheduler } from '../../../orchestration/scheduler/index.ts';
import { LongTaskService } from '../../../store/long-tasks/index.ts';
import { MemoBlobStore } from '../../../context/memo-pad/blobs.ts';
import type { ImageBridge } from '../../../image/bridge.ts';
import type { ImageService } from '../../../image/service.ts';
import { ImConnectionRegistry } from '../../../platform/im-connection.ts';
import type { WarningService } from '../../../store/warnings.ts';
import type { PlaygroundAdminDeps } from '../playground/index.ts';
import { createImageAdminHandler } from '../image.ts';
import { createInvocationMediaReader } from '../invocation-media.ts';
import { createPlaygroundAdminHandler } from '../playground/index.ts';
import { createStaticAssetHandler } from '../static.ts';
import { createAdminsAdminHandler } from './admins.ts';
import { createAdminAuthHandler } from './auth.ts';
import type { AdminAuth } from '../auth.ts';
import type { AdminPasskeys } from '../passkeys.ts';
import { createChatsAdminHandler } from './chats.ts';
import { createControlAdminHandler } from '../control.ts';
import { createDictionaryAdminHandler } from './dictionary.ts';
import { createImageAdminRoutes } from './image.ts';
import { createInspectionAdminHandler } from '../inspection.ts';
import { createMemoryAdminHandler } from './memory.ts';
import { createPlaygroundAdminRoutes } from './playground.ts';
import { createPromptsAdminHandler } from './prompts.ts';
import { createProvidersAdminHandler } from './providers.ts';
import { createTelegramAdminHandler } from '../telegram.ts';
import { createTuningAdminHandler } from './tuning.ts';
import { createWarningsAdminHandler } from '../warnings.ts';
import { createSearchAdminRoutes } from './search.ts';
import { BUILTIN_SEARCH_PROVIDERS } from '../../../platform/web-search.ts';
import type { AdminServerOptions } from '../index.ts';

export interface AdminRoutesDeps {
  readonly options: AdminServerOptions;
  /** The resolved panel bundle directory. */
  readonly staticDir: string;
  readonly auth: AdminAuth;
  readonly passkeys: AdminPasskeys | undefined;
  /** Aborted when admin stops; joined with the host's shutdown signal. */
  readonly healthSignal: AbortSignal;
  readonly healthChecks: Set<Promise<unknown>>;
  /** Shared with the scheduler and login path; the panel may fall back to its own instance. */
  readonly warnings: WarningService;
  /** The in-flight model payload cleanup, shared with `stop()`. */
  readonly payloadClear: {
    current(): Promise<number> | undefined;
    set(value: Promise<number> | undefined): void;
  };
}

/**
 * The composition root of the `/api` route groups. Every group is built once
 * here and receives its live collaborators by reference, so no group reaches
 * back into `AdminServer`.
 */
export function createAdminRoutes(deps: AdminRoutesDeps) {
  const { options, auth, passkeys, healthSignal, healthChecks, payloadClear, staticDir, warnings } = deps;
  const reloader = options.configReloader;
  const secrets = options.secrets;
  const scheduler: BucketScheduler | undefined = options.scheduler;
  const imageBridge: ImageBridge | undefined = options.imageBridge;
  const imageService: ImageService | undefined = options.imageService;
  const playgroundDeps: PlaygroundAdminDeps | undefined = options.playground;
  // Tests and standalone panels may have no connection manager; a fresh registry
  // reports every namespace as disabled, which is the truthful default.
  const connections = options.connections ?? new ImConnectionRegistry();
  const tasks = options.tasks ?? new LongTaskService(options.store.orm, () => scheduler?.wake());
  const image =
    imageService === undefined || imageBridge === undefined
      ? undefined
      : createImageAdminHandler({ service: imageService, bridge: imageBridge });
  const playground = playgroundDeps === undefined ? undefined : createPlaygroundAdminHandler(playgroundDeps);
  const memoBlobs =
    options.memoBlobs ??
    new MemoBlobStore({
      orm: options.store.orm,
      root: join(options.configStore.current().config.data_dir, 'images', 'memo-blobs'),
    });
  const readInvocationMedia =
    options.mediaDownloader === undefined
      ? undefined
      : createInvocationMediaReader({
          orm: options.store.orm,
          downloader: options.mediaDownloader,
          shutdownSignal: options.shutdownSignal ?? new AbortController().signal,
        });

  return {
    auth: createAdminAuthHandler({ auth, passkeys, orm: options.store.orm, secrets }),
    control: createControlAdminHandler({
      store: options.store,
      configReloader: reloader,
      secrets,
      scheduler,
      tasks,
      modelSwitcher: options.modelSwitcher,
      requestRestart: options.requestRestart,
    }),
    tuning: createTuningAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      payloadClear,
    }),
    dictionary: createDictionaryAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      modelSwitcher: options.modelSwitcher,
    }),
    memory: createMemoryAdminHandler({
      store: options.store,
      memoBlobs,
    }),
    admins: createAdminsAdminHandler({ configReloader: reloader, secrets }),
    providers: createProvidersAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      healthSignal,
      healthChecks,
    }),
    chats: createChatsAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      memoBlobs,
      ...(scheduler === undefined ? {} : { scheduler }),
    }),
    prompts: createPromptsAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      scheduler,
    }),
    playground: createPlaygroundAdminRoutes({ playground, scheduler }),
    image: createImageAdminRoutes({ image, bridge: imageBridge, configReloader: reloader, secrets }),
    telegram: createTelegramAdminHandler({ connections, configReloader: reloader, secrets }),
    inspection: createInspectionAdminHandler({
      store: options.store,
      configStore: options.configStore,
      configReloader: reloader,
      secrets,
      replayInvocation: options.replayInvocation,
      replayPreflight: options.replayPreflight,
      invocationPrompts: options.invocationPrompts,
      readInvocationMedia,
    }),
    warnings: createWarningsAdminHandler({ warnings, configStore: options.configStore, connections }),
    search: createSearchAdminRoutes({
      configReloader: reloader,
      secrets,
      configStore: options.configStore,
      searchProviders: options.searchProviders ?? BUILTIN_SEARCH_PROVIDERS,
    }),
    static: createStaticAssetHandler({ staticDir }),
  };
}

export type AdminRoutes = ReturnType<typeof createAdminRoutes>;
