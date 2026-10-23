/**
 * The synthetic data every spec file starts from: the real `SqliteStore` with
 * the shared admin fixture, plus the playground rooms and the room runtime the
 * playground specs release messages into.
 */
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { LoadedConfig } from '../../../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import { createHostTooling } from '../../../src/adapters/local-monolith/host-tooling.ts';
import { createPlaygroundHost } from '../../../src/adapters/local-monolith/playground-host.ts';

import {
  BUNDLED_SYSTEM_RESOURCES_DIR,
  FileSystemResources,
} from '../../../src/adapters/local-monolith/system-resources.ts';
import { PlaygroundAssetStore } from '../../../src/capabilities/media/local-assets.ts';
import { MediaService } from '../../../src/capabilities/media/media.ts';
import { MemoryStore } from '../../../src/context/memory.ts';
import { PlaygroundIngress } from '../../../src/ingress/playground.ts';
import { createCoreRuntime } from '../../../src/orchestration/runtime.ts';
import { KeyedSemaphore } from '../../../src/platform/concurrency.ts';
import { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { BUILTIN_PLUGINS } from '../../../src/plugins/builtin.ts';
import { loadPlugins } from '../../../src/plugins/plugin.ts';
import { LongTaskService } from '../../../src/store/long-tasks.ts';
import { PlaygroundStore } from '../../../src/store/playground.ts';
import { recordPromptVersionsFromConfig } from '../../../src/store/prompt-versions.ts';
import { seedAdminBulkRows } from '../../../test/fixtures/admin-seed-bulk.ts';
import { seedAdminFixture } from '../../../test/fixtures/admin-seed.ts';
import { seedAdminWarnings } from '../../../test/fixtures/admin-seed-context.ts';
import { fauxRegistry } from '../../../test/helpers.ts';
import {
  nudgeRoomScheduler,
  setPlaygroundModel,
  setPlaygroundSeed,
  setRoomFaux,
  setRoomRuntime,
  wakeRoomScheduler,
} from './server-rooms.ts';
import { state } from './server-state.ts';
import { resolveConversation } from '../../../src/adapters/local-monolith/runtime-host-support.ts';

export interface Fixtures {
  readonly store: SqliteStore;
  readonly playgroundStore: PlaygroundStore;
  readonly playgroundAssets: PlaygroundAssetStore;
  readonly playgroundIngress: PlaygroundIngress;
}

export async function openFixtures(loaded: LoadedConfig, directory: string): Promise<Fixtures> {
  const store = await SqliteStore.open(loaded.config);
  // Published before anything is seeded: a shutdown signal that lands mid-boot
  // must still find the open store to close.
  state.store = store;
  const seed = seedAdminFixture(store);
  seedAdminBulkRows(store);
  seedAdminWarnings(store.orm);
  // The playground specs drive the real room store: two rooms, one of them with
  // an admitted (held) message, so the timeline, the counters and the
  // per-room isolation all have something to show.
  const playgroundStore = new PlaygroundStore(store.orm);
  const playgroundAssets = new PlaygroundAssetStore({
    orm: store.orm,
    root: join(directory, 'images', 'playground'),
  });
  // The room runtime: the same AgentRuntime/Scheduler/Context path the product
  // runs, with a fake model provider so a Release can be observed end to end
  // without a network. Telegram-only services (stickers, MCP) are genuinely
  // absent here, exactly as in a Playground-only process.
  // The room runtime gets its own provider identity so the fixture's Telegram
  // runs (which name the product's agent model) can never consume the scripted
  // room turns: they fail fast at model resolution instead.
  const faux = fauxProvider({
    provider: 'playground-e2e',
    models: [{ id: 'playground-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  setRoomFaux(faux);
  setPlaygroundModel([{ text: 'room run finished without sending' }]);
  const runtimeConfigStore = new RuntimeConfigurationStore({
    config: {
      ...loaded.config,
      agent: { ...loaded.config.agent, provider: 'playground-e2e', model: 'playground-model' },
    },
    hash: 'e2e-playground',
    ...fauxRegistry(faux),
  });
  const runtimeSecrets = new SecretStore();
  const runtimePlugins = loadPlugins(BUILTIN_PLUGINS, {});
  const runtimeResources = await FileSystemResources.load(
    BUNDLED_SYSTEM_RESOURCES_DIR,
    runtimePlugins.skillDirectories,
  );
  const roomHost = createPlaygroundHost({
    store,
    self: { displayName: 'Playground Bot' },
    pictures: playgroundAssets,
    sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
  });
  // The harness's room runtime is a Playground-only scheduler: it must not
  // complete the synthetic Telegram fixture's overdue timers, which exist to be
  // rendered, not executed. The core runtime requires the same host set here.
  const runtimeTasks = new LongTaskService(store.orm, () => nudgeRoomScheduler(), ['playground']);
  const roomMedia = new MediaService({
    store,
    configStore: runtimeConfigStore,
    secrets: runtimeSecrets,
    mediaClient: { download: () => Promise.reject(new Error('the E2E process has no media wire')) },
    modelGate: new KeyedSemaphore(),
    localAssets: playgroundAssets,
  });
  const roomTooling = createHostTooling({
    store,
    configStore: runtimeConfigStore,
    plugins: runtimePlugins,
    media: roomMedia,
    memory: new MemoryStore(store.orm),
    tasks: runtimeTasks,
  });
  setRoomRuntime(
    createCoreRuntime({
      store,
      configStore: runtimeConfigStore,
      secrets: runtimeSecrets,
      hosts: { playground: roomHost },
      conversation: (target) => resolveConversation(store, target),
      bot: { id: 1n, displayName: 'Playground Bot', username: null },
      systemResources: runtimeResources,
      capabilityTools: roomTooling.capabilityTools,
      additionalTools: roomTooling.additionalTools,
      skillVisibility: roomTooling.skillVisible,
      tasks: runtimeTasks,
    }),
  );
  const playgroundIngress = new PlaygroundIngress(store.orm, {
    assets: playgroundAssets,
    onQueued: () => wakeRoomScheduler(),
  });
  const seededRooms: { id: string; title: string }[] = [];
  for (const [title, text] of [
    ['E2E Room', 'first room message'],
    ['E2E Second Room', 'second room message'],
  ] as const) {
    const created = playgroundStore.createRoom({ title, members: [{ name: 'Ada', role: 'admin' }] });
    await playgroundIngress.submit(created.chatId, {
      requestKey: `e2e-${created.chatId.toString()}`,
      senderId: created.members[0]?.senderId,
      text,
    });
    seededRooms.push({ id: created.chatId.toString(), title });
  }
  setPlaygroundSeed(seededRooms);
  // E2E-only fixture tweak: the shared seed keeps `thinking_text = ''` because
  // some historical-replay tests build pre-030 tables; the panel meanwhile
  // gets one assistant row with CoT text to assert the separated display.
  store.db
    .prepare('UPDATE agent_messages SET thinking_text = ? WHERE invocation_id = ? AND role = ? AND sequence_no = ?')
    .run('cot that never reached an answer', seed.invocationB, 'assistant', 1n);
  // Production records the starting prompt versions at startup; mirror that so
  // the Prompts page has history to show.
  recordPromptVersionsFromConfig(store.orm, loaded.config);
  return { store, playgroundStore, playgroundAssets, playgroundIngress };
}
