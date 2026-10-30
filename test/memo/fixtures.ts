import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { asc, eq } from 'drizzle-orm';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { MemoBlobStore } from '../../src/context/memo-pad/blobs.ts';
import { MemoPadStore } from '../../src/context/memo-pad/store.ts';
import type { MemoToolEnvironment } from '../../src/context/memo-pad/tools/index.ts';
import { InvocationContextState, unavailableCapabilities } from '../../src/platform/invocation-context.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { buckets, chats, conversations, invocations, toolCalls } from '../../src/store/schema/index.ts';
import { type FixtureConfig, testConfigJsonc, testConfigStore, writeTestConfig } from '../helpers.ts';

export interface MemoFixture {
  readonly directory: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly memoPad: MemoPadStore;
  readonly blobs: MemoBlobStore;
  /** `<data_dir>/images/memo-blobs`, the root every blob path must stay under. */
  readonly blobRoot: string;
  close(): Promise<void>;
}

export async function memoFixture(transform?: (config: FixtureConfig) => void): Promise<MemoFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-memo-'));
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const blobRoot = join(loaded.config.data_dir, 'images', 'memo-blobs');
  return {
    directory,
    loaded,
    store,
    configStore,
    memoPad: new MemoPadStore(store.orm),
    blobs: new MemoBlobStore({ orm: store.orm, root: blobRoot }),
    blobRoot,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

export interface SeededChat {
  readonly telegramChatId: bigint;
  readonly chatId: bigint;
  readonly conversationId: bigint;
}

/** One Telegram Chat with a single Forum Topic conversation. */
export function seedChat(store: SqliteStore, telegramChatId: bigint, threadId = 0n): SeededChat {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const chat = store.orm
    .insert(chats)
    .values({
      hostKind: 'telegram',
      telegramChatId,
      canonicalChatId: telegramChatId,
      type: telegramChatId > 0n ? 'private' : 'supergroup',
      updatedAt: now,
    })
    .returning({ id: chats.id })
    .get();
  if (chat === undefined) {
    throw new Error('chat insert returned no row');
  }
  const conversation = store.orm
    .insert(conversations)
    .values({ chatId: chat.id, messageThreadId: threadId, createdAt: now, updatedAt: now })
    .returning({ id: conversations.id })
    .get();
  if (conversation === undefined) {
    throw new Error('conversation insert returned no row');
  }
  return { telegramChatId, chatId: chat.id, conversationId: conversation.id };
}

/** A completed bucket + invocation, the audit parent every tool call needs. */
export function seedInvocation(store: SqliteStore, conversationId: bigint): bigint {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const bucket = store.orm
    .insert(buckets)
    .values({
      conversationId,
      state: 'completed',
      firstReceivedAt: now,
      deadlineAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: buckets.id })
    .get();
  if (bucket === undefined) {
    throw new Error('bucket insert returned no row');
  }
  const invocation = store.orm
    .insert(invocations)
    .values({
      bucketId: bucket.id,
      conversationId,
      state: 'completed',
      configHash: 'test',
      promptVersion: 1n,
      createdAt: now,
    })
    .returning({ id: invocations.id })
    .get();
  if (invocation === undefined) {
    throw new Error('invocation insert returned no row');
  }
  return invocation.id;
}

export function seedInvocationContext(seeded: SeededChat, invocationId: bigint): InvocationContextState {
  return new InvocationContextState({
    invocationId,
    conversationId: seeded.conversationId,
    hostKind: 'telegram',
    chatId: seeded.telegramChatId,
    internalChatId: seeded.chatId,
    threadId: 0n,
    completion: null,
  });
}

export function memoToolEnvironment(fixture: MemoFixture, context: InvocationContextState): MemoToolEnvironment {
  return {
    store: fixture.store,
    memoPad: fixture.memoPad,
    blobs: fixture.blobs,
    context,
    configStore: fixture.configStore,
    capabilities: unavailableCapabilities(),
    prepareImage: async () => {
      throw new Error('images are not used by these tests');
    },
  };
}

export function toolNamed(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`tool ${name} is missing`);
  }
  return tool;
}

export async function runTool(
  tool: AgentTool,
  toolCallId: string,
  input: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = await tool.execute(toolCallId, input, new AbortController().signal);
  return {
    text: result.content
      .filter((entry) => entry.type === 'text')
      .map((entry) => entry.text)
      .join(''),
    details: result.details,
  };
}

export interface AuditRow {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly state: string;
  readonly errorCode: string | null;
}

export function auditRows(store: SqliteStore, invocationId: bigint): AuditRow[] {
  return store.orm
    .select({
      toolCallId: toolCalls.toolCallId,
      toolName: toolCalls.toolName,
      state: toolCalls.state,
      errorCode: toolCalls.errorCode,
    })
    .from(toolCalls)
    .where(eq(toolCalls.invocationId, invocationId))
    .orderBy(asc(toolCalls.id))
    .all();
}
