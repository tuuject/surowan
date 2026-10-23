import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type FauxProviderHandle, fauxProvider, type ImageContent } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';
import Type, { type TSchema } from 'typebox';
import { afterEach, expect } from 'vitest';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { ContextBuilder, type StablePrompt } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { type ReplayPromptOverrides, ReplayRunner } from '../src/orchestration/replay.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources, type SystemResources } from '../src/platform/system-resources.ts';
import { AlarmInputSchema, ListAlarmInputSchema } from '../src/plugins/alarm/alarm.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { invocationMessages, media, messageRevisions, messages } from '../src/store/schema.ts';
import { seedAdminFixture } from './fixtures/admin-seed.ts';
import { fauxRegistry, type TestRegistry, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

/**
 * Scene replay contract: a replay no longer reads a recorded model request.
 * It rebuilds one historical public group-chat scene from the seeded chat
 * (`seedAdminFixture` provides the real chat, conversation, bucket, invocation
 * and frozen opening batch), runs it against the *current* prompt layers, the
 * current chat's model, and the current tool registry, and only ever produces
 * synthetic side effects. Recording mode and model-call payloads are irrelevant.
 *
 * `prepareScene` completes the seeded fixture into the shape the scene builder
 * reads: a valid opening-batch snapshot plus public history before the scene
 * cutoff (including a bot message) and one message after it.
 */

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

/** invocations.created_at of the seeded invocation A: the scene cutoff. */
export const CUTOFF_AT = '2026-09-10T07:59:45.000Z';
export const OPENING_TEXT = 'plain text message with a reply';
export const HISTORY_CAPTION = 'history photo caption';
export const LATE_TEXT = 'message after the scene cutoff';
const HISTORY_MESSAGE = 6_050n;
const HISTORY_REVISION = 6_150n;
export const HISTORY_MEDIA = 6_250n;
const LATE_MESSAGE = 6_051n;
const LATE_REVISION = 6_151n;

export const SCENE_FIDELITY = {
  input: 'historical_public_chat',
  model_selection: 'current_chat_config',
  prompt_selection: 'current_chat_config',
  tool_selection: 'current_registry',
  hot_injections: 'not_replayed',
  external_tools: 'blocked',
  system_resources: 'current_read_only',
  side_effects: 'synthetic',
} as const;

/** Fixture executors throw: a scene test must never reach a production tool. */
const unusedExecutor: AgentTool['execute'] = async () => {
  throw new Error('fixture executor must never run');
};

export function definition(name: string, parameters: TSchema = Type.Object({})): AgentTool {
  return { name, label: name, description: `fixture ${name}`, parameters, execute: unusedExecutor };
}

/** The registry a caller may inject through `toolDefinitions`, like production does. */
export function sceneRegistry(): { readonly tools: readonly AgentTool[]; readonly capabilities: readonly AgentTool[] } {
  return {
    tools: [
      definition('read', Type.Object({ uri: Type.String(), base: Type.Optional(Type.String()) })),
      definition('send', SendInputSchema),
      definition('execute'),
      definition('zzz'),
      definition('mcp_remote_write'),
    ],
    capabilities: [
      definition('add_memory', AddMemoryInputSchema),
      definition('alarm', AlarmInputSchema),
      definition('list_alarm', ListAlarmInputSchema),
      definition('search_stickers'),
    ],
  };
}

/**
 * Turns the seeded fixture into a complete scene:
 * - the seeded opening batch (messageB) gets the full snapshot shape the current
 *   writer stores, so it is a valid frozen `new` batch;
 * - a bot message before the cutoff joins the public history (with one photo,
 *   which a text-only scene reports as omitted), and a message after the cutoff
 *   proves the scene never reads past the opening bucket.
 */
function prepareScene(store: SqliteStore, seed: ReturnType<typeof seedAdminFixture>): void {
  const orm = store.orm;
  // The Admin rendering seed intentionally uses abbreviated snapshots. This
  // fixture exercises as-of history and supplies its own complete opening row.
  orm
    .delete(invocationMessages)
    .where(and(eq(invocationMessages.invocationId, seed.invocationA), eq(invocationMessages.section, 'history')))
    .run();
  orm
    .update(invocationMessages)
    .set({
      snapshotJson: JSON.stringify({
        message_id: '901',
        telegram_date: '2026-09-10T08:00:05.000Z',
        sent_by_bot: false,
        revision: '1',
        sender: { id: '42', name: 'Alice', username: 'alice' },
        kind: 'text',
        text: OPENING_TEXT,
        caption: null,
        reply_to_message_id: null,
        reply_snapshot: null,
        forward_origin: null,
        media_group_id: null,
        media: [],
      }),
    })
    .where(and(eq(invocationMessages.invocationId, seed.invocationA), eq(invocationMessages.section, 'new')))
    .run();
  orm
    .insert(messages)
    .values({
      id: HISTORY_MESSAGE,
      conversationId: seed.conversationId,
      chatId: seed.chatId,
      telegramMessageId: 880n,
      currentRevisionId: null,
      visible: true,
      sentByBot: true,
      telegramDate: '2026-09-10T07:58:00.000Z',
      receivedAt: '2026-09-10T07:58:01.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: HISTORY_REVISION,
      messageId: HISTORY_MESSAGE,
      revisionNo: 1n,
      senderId: null,
      kind: 'photo',
      text: null,
      caption: HISTORY_CAPTION,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:58:02.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(media)
    .values({
      id: HISTORY_MEDIA,
      revisionId: HISTORY_REVISION,
      kind: 'photo',
      fileId: 'file_history_seed',
      fileUniqueId: 'unique_history_seed',
      mimeType: 'image/jpeg',
      fileSize: 4_096n,
      width: 640n,
      height: 480n,
      telegramJson: '{}',
    })
    .run();
  orm
    .insert(messages)
    .values({
      id: LATE_MESSAGE,
      conversationId: seed.conversationId,
      chatId: seed.chatId,
      telegramMessageId: 999n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T08:30:00.000Z',
      receivedAt: '2026-09-10T08:30:00.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: LATE_REVISION,
      messageId: LATE_MESSAGE,
      revisionNo: 1n,
      senderId: null,
      kind: 'text',
      text: LATE_TEXT,
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T08:30:00.000Z',
      rawFragmentJson: '{}',
    })
    .run();
}

export interface FixtureOptions {
  readonly change?: (config: FileConfig) => void;
  readonly contextWindow?: number;
  readonly images?: boolean;
  readonly imageLoader?: (mediaId: bigint, signal: AbortSignal) => Promise<ImageContent>;
  readonly resources?: SystemResources;
  /** Same hook production wires through `AgentRuntime.sceneToolDefinitions`. */
  readonly defaultRegistry?: boolean;
  readonly definitions?: (
    context: InvocationContext,
    config: RawConfig,
  ) => {
    readonly tools: readonly AgentTool[];
    readonly capabilities: readonly AgentTool[];
  };
  /** The rendered global prompt layer; defaults to the fixture's 'Participate safely.'. */
  readonly systemPrompt?: string;
  /**
   * Builds a registry beyond the single agent faux (e.g. for cross-provider
   * selection). `extra` are the additional faux handles the test asserts on.
   */
  readonly registry?: (faux: FauxProviderHandle) => {
    readonly registry: TestRegistry;
    readonly extra: readonly FauxProviderHandle[];
  };
}

export async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-replay-'));
  const path = join(directory, 'config.jsonc');
  await writeTestConfig(directory, path, testConfigJsonc(directory, options.change), options.systemPrompt);
  const loaded = await loadConfig(path);
  const faux = fauxProvider({
    provider: 'agent',
    models: [
      {
        id: 'agent-model',
        input: options.images === true ? ['text', 'image'] : ['text'],
        contextWindow: options.contextWindow ?? 200_000,
        maxTokens: 128,
      },
    ],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const built = options.registry?.(faux);
  const configStore = await testConfigStore(loaded, built?.registry ?? fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanup.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const seed = seedAdminFixture(store);
  prepareScene(store, seed);
  const secrets = new SecretStore();
  const shutdown = new AbortController();
  const gate = new KeyedSemaphore();
  const runner = new ReplayRunner({
    store,
    configStore,
    secrets,
    systemResources: options.resources ?? emptySystemResources(),
    modelGate: gate,
    shutdownSignal: shutdown.signal,
    ...(options.imageLoader === undefined ? {} : { imageLoader: options.imageLoader }),
    ...(options.defaultRegistry === true ? {} : { toolDefinitions: options.definitions ?? (() => sceneRegistry()) }),
  });
  const run = (override: ReplayPromptOverrides = {}, signal: AbortSignal = new AbortController().signal) =>
    runner.run(seed.invocationA, override, signal);
  return {
    directory,
    loaded,
    faux,
    extraFauxes: built?.extra ?? [],
    configStore,
    store,
    seed,
    secrets,
    shutdown,
    gate,
    runner,
    run,
    rows: () => stateRows(store),
  };
}

/** Every table and all of its rows, for before/after comparison. */
function stateRows(store: SqliteStore): Record<string, unknown[]> {
  const names = store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]),
  );
}

/** The stable prompt the scene composes from the current config, with no skills. */
export function stablePrompt(store: SqliteStore, config: RawConfig, invocationId: bigint): StablePrompt {
  const builder = new ContextBuilder(
    store,
    new ContextRefStore(store, { ttlHours: () => config.agent!.context!.ref_ttl_hours }),
  );
  return builder.buildSystemPrompt(config, builder.identity(config, invocationId), false, {
    provider: config.agent!.provider!,
    model: config.agent!.model!,
  });
}

/** All model-visible message text as one string; layout details stay free. */
export function messageText(context: { readonly messages: readonly unknown[] }): string {
  return JSON.stringify(context.messages);
}

/** Asserts a synchronous ReplayError code; returns the error for further checks. */
export function replayError(action: () => unknown, code: string): Error {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Error;
  }
  throw new Error(`expected replay error ${code}`);
}
