import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import {
  bundledSystemResources,
  testConfigJsonc,
  testConfigStore,
  testTelegramRuntime,
  type TestRegistry,
  writeTestConfig,
} from './helpers.ts';
import type { CapabilityToolFactory } from '../src/orchestration/agent-runtime-types.ts';

const directories: string[] = [];

export async function cleanupSkillDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

/** Registers an extra temporary path for `cleanupSkillDirectories`. */
export function trackSkillTempPath(path: string): void {
  directories.push(path);
}

export interface InvocationSetup {
  readonly store: SqliteStore;
  readonly loaded: LoadedConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly invocationId: bigint;
}

export async function setupInvocation(
  prefix: string,
  withStickers: boolean,
  registry: TestRegistry,
): Promise<InvocationSetup & { stickerId?: bigint }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    if (withStickers) {
      config.telegram.sticker_sets = [{ alias: 'cats', name: 'CatSet' }];
    }
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, registry);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: 'hello',
    },
  };
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(update, received);
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  return { store, loaded, configStore, invocationId };
}

/** The runtime the skills tests drive: faux transport, bundled resources, caller-supplied capabilities. */
export async function skillAgentRuntime(
  store: SqliteStore,
  configStore: RuntimeConfigurationStore,
  capabilityTools: CapabilityToolFactory,
): Promise<AgentRuntime> {
  return new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async () => ({ message_id: 500, date: 1, chat: { id: 123456789 } }),
      sendSticker: async () => ({ message_id: 501, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: await bundledSystemResources(),
    capabilityTools,
  });
}

export function lastToolResult(messages: readonly Message[]): ToolResultMessage {
  const last = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult').at(-1);
  if (last === undefined) {
    throw new Error('Expected a tool result message');
  }
  return last;
}

export function toolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('');
}
