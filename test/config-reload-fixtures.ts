import { afterAll, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, type MutableModels } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { BotCommandService, type CommandSender } from '../src/orchestration/bot-commands.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler, type InvocationOutcome } from '../src/orchestration/scheduler.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { FileConfig } from '../src/platform/config.ts';
import { type LoadedConfig, loadConfig } from '../src/adapters/local-monolith/config.ts';
import { ConfigReloader, type TelegramConfigGateway } from '../src/adapters/local-monolith/config-reload.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { AgentModelSwitcher } from '../src/platform/model-switch.ts';
import { buildModelRegistry } from '../src/platform/providers.ts';
import { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import {
  type FixtureConfig,
  sleep,
  testConfigJsonc,
  testTelegramRuntime,
  writeTestConfig,
  writeTestKeyJar,
} from './helpers.ts';

const directories: string[] = [];
export const CHAT_ID = 123456789;
export const ADMIN: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
export const AGENT_MODEL = 'deepseek-v4-flash';
export const SECOND_MODEL = 'agent-model-2';
const captured: string[] = [];
let consoleSpy: ReturnType<typeof vi.spyOn> | undefined;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

afterEach(() => {
  consoleSpy?.mockRestore();
  consoleSpy = undefined;
  captured.length = 0;
});

export function logEvents(event: string): Record<string, unknown>[] {
  return captured
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every console.log line captured while the fixture's spy is installed. */
export function logLines(): readonly string[] {
  return captured;
}

export function textUpdate(updateId: number, messageId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: CHAT_ID, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function groupUpdate(updateId: number, messageId: number, chatId: number, senderId = 42): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'supergroup', title: 'Group' },
      from: { id: senderId, is_bot: false, first_name: `User ${senderId}` },
      text: `message from ${senderId}`,
    },
  };
}

export async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type ProviderEntry = FileConfig['providers'][string];
type ModelEntry = Extract<ProviderEntry, { kind: 'custom' }>['models'][number];

export function customProvider(
  providers: Readonly<Record<string, ProviderEntry>>,
  alias: string,
): Extract<ProviderEntry, { kind: 'custom' }> {
  const provider = providers[alias];
  if (provider === undefined || provider.kind !== 'custom') {
    throw new Error(`Expected a custom provider fixture: ${alias}`);
  }
  return provider;
}

export function builtinProvider(
  providers: Readonly<Record<string, ProviderEntry>>,
  alias: string,
): Extract<ProviderEntry, { kind: 'builtin' }> {
  const provider = providers[alias];
  if (provider === undefined || provider.kind !== 'builtin') {
    throw new Error(`Expected a builtin provider fixture: ${alias}`);
  }
  return provider;
}

export function model(id: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    context_window: 128_000,
    max_tokens: 8_192,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
    ...overrides,
  };
}

/** Counts SecretRef resolutions so a reload can be shown not to run one again. */
export class CountingSecrets extends SecretStore {
  resolutions = 0;

  override async resolve(reference: Parameters<SecretStore['resolve']>[0]): Promise<string> {
    this.resolutions += 1;
    return await super.resolve(reference);
  }
}

/**
 * The agent runs on a faux provider registered under a builtin alias: the file
 * declares that alias's models (a builtin provider registers exactly the models
 * the configuration enables) and the tests then swap in the faux provider, so
 * the registry owns the streaming behavior while the custom `agent` / `vision`
 * providers stay available for the provider-level reload cases.
 */
export function baseConfig(config: FixtureConfig): void {
  config.telegram.admins = [42];
  config.agent!.send_nudge_enabled = false;
  config.providers.faux = {
    kind: 'builtin',
    provider: 'deepseek',
    api_key: { jar: 'faux' },
    models: [
      model(AGENT_MODEL, { reasoning: true, input: ['text', 'image'], context_window: 200_000, max_tokens: 32_768 }),
      model(SECOND_MODEL, { reasoning: true }),
    ],
  };
  config.agent!.provider = 'faux';
  config.agent!.model = AGENT_MODEL;
  config.agent!.thinking_level = 'low';
}

export function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'faux',
    models: [
      { id: AGENT_MODEL, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768, reasoning: true },
      { id: SECOND_MODEL, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
    ],
  });
}

export interface Fixture {
  readonly directory: string;
  readonly secrets: SecretStore;
  readonly configPath: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  /** The startup registry, mutable so a test can stand in a faux provider. */
  readonly models: MutableModels;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly reloader: ConfigReloader;
  readonly ingestion: TelegramIngestion;
  readonly conversationRuntime: ConversationRuntime;
  readonly commands: BotCommandService;
  readonly scheduler: BucketScheduler;
  readonly sendApi: TelegramTransport;
  readonly sends: string[];
  file(): FileConfig;
  /** Rewrites the file from the current one with `transform` applied. */
  patch(transform: (config: FixtureConfig) => void): Promise<void>;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  /** Builds a runtime over `faux`, replacing the registry's `faux` provider. */
  runtimeWith(faux: ReturnType<typeof fauxProvider>): AgentRuntime;
}

export async function setup(
  options: {
    readonly transform?: (config: FixtureConfig) => void;
    /** Builds the process-wide store over the fixture's key jar. */
    readonly secrets?: (keyJar: string) => SecretStore;
    /** Extra files written before the configuration is loaded. */
    readonly files?: Readonly<Record<string, string>>;
    /** Observe the Telegram token gateway the composition root installs. */
    readonly telegramConfig?: TelegramConfigGateway;
  } = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-reload-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      baseConfig(config);
      options.transform?.(config);
    }),
  );
  await writeTestKeyJar(directory, {
    faux: 'faux-secret',
    extra: 'extra-secret',
    'key-a': 'key-a',
    'key-b': 'key-b',
    'agent-rotated': 'agent-rotated',
  });
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(directory, name), content);
  }
  const loaded = await loadConfig(configPath);
  let fileConfig = structuredClone(loaded.fileConfig);
  const store = await SqliteStore.open(loaded.config);
  // One registry for the store and the reloader, exactly as the composition root
  // wires it: credentials are resolved once, at startup. The fixture keeps the
  // mutable handle the registry was built from so a test can stand in a faux
  // provider; a published registry is read-only by type.
  const secrets = (options.secrets ?? ((keyJar) => new SecretStore(keyJar)))(keyJarPath(configPath));
  const registry = await buildModelRegistry(loaded.config, null, secrets);
  const models = registry.models as MutableModels;
  const configStore = new RuntimeConfigurationStore({ config: loaded.config, hash: loaded.hash, ...registry });
  const modelSwitcher = new AgentModelSwitcher(configStore);
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => loaded.config.agent!.context!.agent_cache_size,
  });
  const sends: string[] = [];
  let messageId = 900;
  const sendApi: TelegramTransport = {
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } };
    },
    sendSticker: async () => ({ message_id: ++messageId, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  let runtime: AgentRuntime | undefined;
  const reloader = new ConfigReloader({
    loaded,
    store: configStore,
    modelSwitcher,
    secrets,
    // The pipeline tests build a runtime; without one there is no tool registry
    // to fit into a context window, so the check has nothing to reject.
    validateAgentModel: (candidate) => runtime?.validateAdditionalTools(previewContext(), [], candidate),
    onPublished: () => undefined,
    ...(options.telegramConfig === undefined ? {} : { telegramConfig: options.telegramConfig }),
  });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const commands = new BotCommandService(store, configStore, scheduler, modelSwitcher, conversationRuntime, reloader);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    captured.push(String(line));
  });
  return {
    directory,
    secrets,
    configPath,
    loaded,
    store,
    configStore,
    models,
    modelSwitcher,
    reloader,
    ingestion,
    conversationRuntime,
    commands,
    scheduler,
    sendApi,
    sends,
    file: () => fileConfig,
    patch: async (transform) => {
      const next = structuredClone(fileConfig) as FixtureConfig;
      transform(next);
      fileConfig = next;
      await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
      await restrictConfig(configPath);
    },
    writeText: async (text) => {
      await writeFile(configPath, text);
      await restrictConfig(configPath);
    },
    readText: () => readFile(configPath, 'utf8'),
    runtimeWith: (faux) => {
      models.setProvider(faux.provider);
      runtime = new AgentRuntime({
        store,
        configStore,
        secrets,
        ...testTelegramRuntime(sendApi),
        bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
        systemResources: emptySystemResources(),
        conversationRuntime,
      });
      return runtime;
    },
  };
}

/** `serve` and the reload path demand mode 0600; Windows has no such check. */
export async function restrictConfig(configPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600);
  }
}

export function contextRows(
  store: SqliteStore,
): { readonly seq: bigint; readonly role: string; readonly payload_json: string }[] {
  return store.db
    .prepare<[], { seq: bigint; role: string; payload_json: string }>(
      'SELECT seq, role, payload_json FROM context_messages ORDER BY seq',
    )
    .all();
}

export function transcript(store: SqliteStore): string {
  return contextRows(store)
    .map((row) => `${row.seq}:${row.role}:${row.payload_json}`)
    .join('\n');
}

/** Marks an invocation and its bucket terminal, as the scheduler would. */
export function settle(fixture: Fixture, invocationId: bigint): void {
  fixture.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  fixture.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
}

/** Runs one invocation outside the scheduler and closes it out. */
export async function runDirect(
  fixture: Fixture,
  runtime: AgentRuntime,
  invocationId: bigint,
): Promise<InvocationOutcome> {
  const outcome = await runtime.run(invocationId, fixture.configStore.beginInvocation(), new AbortController().signal);
  settle(fixture, invocationId);
  return outcome;
}
