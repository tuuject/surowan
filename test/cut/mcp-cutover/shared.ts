/**
 * Everything the MCP-cutover tests share: two real stdio MCP servers, two
 * Telegram Chats (one bound to each server), a scheduler whose handler stays
 * inside its round until aborted, and the serialized cutover the composition
 * root would run.
 *
 * The tests then split by topic: `rebuild.test.ts` covers stop → rebuild →
 * continuation, `scope.test.ts` which Chats a publish touches, `waiting.test.ts`
 * the handoff and queue behaviour, and `continuation.test.ts` where the
 * follow-up batch or its task completion comes from.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, vi } from 'vitest';
import { loadConfig } from '../../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../../src/adapters/local-monolith/database.ts';
import { createMcpCutover } from '../../../src/adapters/local-monolith/runtime/mcp-cutover/index.ts';
import type { McpConfigPublishResult } from '../../../src/adapters/local-monolith/runtime/mcp-cutover/shared.ts';
import { awaitServerAttempts } from '../../../src/capabilities/mcp/availability.ts';
import { McpManager } from '../../../src/capabilities/mcp/index.ts';
import { ConversationContextStore } from '../../../src/context/store/index.ts';
import { ConversationRuntime } from '../../../src/orchestration/conversation-runtime.ts';
import { BucketScheduler, type InvocationHandler } from '../../../src/orchestration/scheduler/index.ts';
import type { McpServerConfig, RawConfig } from '../../../src/platform/config/index.ts';
import { type InvocationContext, previewContext } from '../../../src/platform/invocation-context.ts';
import { keychainPath } from '../../../src/platform/keychain.ts';
import type { RuntimeConfigurationStore } from '../../../src/platform/runtime-config.ts';
import { SecretStore } from '../../../src/platform/secrets.ts';
import { invocations } from '../../../src/store/schema/index.ts';
import {
  afterThisTest,
  testConfigJsonc,
  testConfigStore,
  trackTempDirectory,
  writeTestConfig,
  writeTestKeychain,
} from '../../helpers.ts';
import { seedInvocation } from '../../memo/fixtures.ts';

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'mcp-server.ts');
export const CHAT_A = 111_111_111;
export const CHAT_B = 222_222_222;
export const CHAT_ANY = -100_333_333_333;

export function server(alias: string, pidFile: string): McpServerConfig {
  return {
    alias,
    transport: 'stdio',
    command: [process.execPath, FIXTURE, pidFile],
    tools: ['echo'],
    payload_max_bytes: 32768,
    result_max_bytes: 32768,
    tool_policies: [{ name: 'echo', read_only: false, timeout_seconds: 5 }],
  };
}

export interface Fixture {
  readonly directory: string;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly scheduler: BucketScheduler;
  readonly manager: McpManager;
  readonly runtime: ConversationRuntime;
  readonly forgotten: bigint[];
  readonly logs: string[];
  whenStarted(count: number): Promise<void>;
  /** Keeps the next handlers alive past their abort until the returned function runs. */
  hold(): () => void;
  /** Ends the round early, as a run that answered and now waits for messages would. */
  endRound(conversationId: bigint): void;
  conversationOf(invocationId: bigint): bigint | undefined;
  /** `mcp_server_state` row for one alias. */
  stateOf(alias: string): { readonly state: string; readonly reconnect_attempt: bigint } | undefined;
  /** The fixture server's process id, read from the pid file it wrote. */
  pidOf(alias: string): Promise<number>;
  /** Publishes `next` the way `ConfigReloader` does, then runs the serialized cutover. */
  apply(next: RawConfig, rotated?: ReadonlySet<string>): Promise<McpConfigPublishResult>;
}

export async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-cutover-'));
  trackTempDirectory(directories, directory);
  const configPath = join(directory, 'config.jsonc');
  const pid = (alias: string) => join(directory, `${alias}.pid`);
  const marker = join(directory, 'scripted-marker.txt');
  const commandSecret = `require('node:fs').writeFileSync('${marker.split(String.fromCharCode(92)).join('/')}', 'started');console.log('ok');`;
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      const alpha = { ...server('alpha', pid('alpha')), env: { ALPHA_KEY: { jar: 'alpha-key' } } };
      const delta = {
        ...server('scripted', pid('scripted')),
        env: { DELTA_KEY: { command: [process.execPath, '-e', commandSecret] } },
      };
      config.mcp = {
        servers: [
          alpha,
          server('beta', pid('beta')),
          {
            alias: 'remote',
            transport: 'streamable_http',
            url: 'http://127.0.0.1:1/mcp',
            follow_redirects: false,
            tools: '*',
            payload_max_bytes: 32768,
            result_max_bytes: 32768,
            default_tool_policy: { read_only: true, timeout_seconds: 5 },
            headers: { 'x-key': { jar: 'gamma-key' } },
          },
          delta,
        ],
      };
      config.telegram.chats = [
        { id: CHAT_A, instructions_file: 'chat-instructions.md', mcp: [{ server: 'alpha' }] },
        { id: CHAT_B, instructions_file: 'chat-instructions.md', mcp: [{ server: 'beta' }] },
      ];
    }),
  );
  await writeTestKeychain(directory, { 'alpha-key': 'alpha-key-v1', 'gamma-key': 'gamma-key-v1' });
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const manager = new McpManager(store, loaded.config, new SecretStore(keychainPath(loaded.configPath)));
  const runtime = new ConversationRuntime({ agentCacheSize: () => 8 });
  const conversationOf = (invocationId: bigint): bigint | undefined =>
    store.orm.select({ id: invocations.conversationId }).from(invocations).where(eq(invocations.id, invocationId)).get()
      ?.id;
  const startedIds: bigint[] = [];
  let startedWaiter: { count: number; resolve: () => void } | undefined;
  let holdGate: Promise<void> | undefined;
  let releaseHold: (() => void) | undefined;
  const handler: InvocationHandler = async (id, _snapshot, signal) => {
    startedIds.push(id);
    if (startedWaiter !== undefined && startedIds.length >= startedWaiter.count) {
      startedWaiter.resolve();
      startedWaiter = undefined;
    }
    const conversationId = conversationOf(id);
    if (conversationId !== undefined) {
      runtime.beginRound(conversationId);
    }
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    // A held handler outlives its abort, which is the only way the cutover has
    // to hand the rebuild to a completion promise.
    await holdGate;
    if (conversationId !== undefined) {
      runtime.endRound(conversationId);
    }
    return { state: 'aborted', reason: 'aborted' };
  };
  const scheduler = new BucketScheduler(store, configStore, handler);
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  afterThisTest(
    async () => {
      spy.mockRestore();
      // A held handler would keep `stop` waiting forever.
      holdGate = undefined;
      releaseHold?.();
      await scheduler.stop(0);
      await manager.stop();
      store.close();
    },
    () => {
      cleanups.push(async () => {
        spy.mockRestore();
        holdGate = undefined;
        releaseHold?.();
        await scheduler.stop(0);
        await manager.stop();
        store.close();
      });
    },
  );
  await manager.start();
  await awaitServerAttempts(manager);
  const forgotten: bigint[] = [];
  const cutover = createMcpCutover({
    store,
    configStore,
    scheduler,
    isHostReady: () => true,
    mcp: manager,
    roundInProgress: (conversationId) => runtime.isRoundInProgress(conversationId),
    forgetConversation: (conversationId) => {
      forgotten.push(conversationId);
    },
    redactError: (error) => String(error),
    // A short in-line wait, so a held handler hands the rest off quickly.
    waitMilliseconds: 20,
  });
  let generation = 1;
  return {
    directory,
    store,
    configStore,
    scheduler,
    manager,
    runtime,
    forgotten,
    logs,
    whenStarted: async (count) => {
      const waiter = Promise.withResolvers<void>();
      if (startedIds.length >= count) {
        return;
      }
      startedWaiter = { count, resolve: waiter.resolve };
      const timer = setTimeout(() => waiter.resolve(), 10_000);
      await waiter.promise;
      clearTimeout(timer);
    },
    hold: () => {
      const gate = Promise.withResolvers<void>();
      holdGate = gate.promise;
      releaseHold = () => gate.resolve();
      return releaseHold;
    },
    endRound: (conversationId) => runtime.endRound(conversationId),
    conversationOf,
    pidOf: async (alias) => Number(await readFile(pid(alias), 'utf8')),
    stateOf: (alias) =>
      store.db
        .prepare<[string], { state: string; reconnect_attempt: bigint }>(
          'SELECT state, reconnect_attempt FROM mcp_server_state WHERE alias = ?',
        )
        .get(alias),
    apply: async (next, rotated) => {
      const previous = configStore.current();
      generation += 1;
      configStore.publish({
        config: next,
        hash: `hash-${generation}`,
        models: previous.models,
        visionModel: previous.visionModel,
      });
      return await cutover.publish(previous.config, next, generation, rotated);
    },
  };
}

/** Queues one Invocation whose opening batch has already been injected. */
export function queueInvocation(store: SqliteStore, conversationId: bigint, injectedAt: string): bigint {
  const invocationId = seedInvocation(store, conversationId);
  const now = new Date().toISOString();
  const invocation = store.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get();
  if (invocation === undefined) {
    throw new Error('Missing seeded invocation');
  }
  store.orm.update(invocations).set({ state: 'queued', createdAt: now }).where(eq(invocations.id, invocationId)).run();
  store.orm.run(sql`UPDATE buckets SET state = 'queued', first_received_at = ${now}, deadline_at = ${now}
    WHERE id = ${invocation.bucketId}`);
  store.orm.run(sql`INSERT INTO invocation_buckets(invocation_id, bucket_id, attached_at, injected_at)
    VALUES (${invocationId}, ${invocation.bucketId}, ${now}, ${injectedAt})`);
  return invocationId;
}

export function seedContext(
  store: SqliteStore,
  conversationId: bigint,
  text: string,
): { generation: bigint; id: bigint } {
  const contexts = new ConversationContextStore(store);
  const { header } = contexts.open(conversationId, 'seed-hash');
  contexts.append(header, {
    invocationId: null,
    isCheckpoint: true,
    estTokens: 4,
    json: JSON.stringify({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }),
    role: 'user',
  });
  store.orm.run(sql`INSERT INTO context_refs(context_id, ref, kind, source_seq, expires_at, created_at)
    VALUES (${header.id}, 'img_seed', 'media', ${header.nextSeq}, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`);
  const current = contexts.header(conversationId);
  if (current === undefined) {
    throw new Error('Missing Context header');
  }
  return { generation: current.generation, id: current.id };
}

export function now(): string {
  return new Date('2026-01-01T00:00:00.000Z').toISOString();
}

export function contextFor(
  invocationId: bigint,
  hostChatId: bigint,
  internalChatId: bigint,
  conversationId: bigint,
): InvocationContext {
  // Distinct native and internal ids: a path resolving by internalChatId must
  // fail these tests, not pass because both fields happen to be equal.
  return { ...previewContext('telegram'), invocationId, hostChatId, internalChatId, conversationId };
}

export function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const text = result.content.find((entry) => entry.type === 'text');
  if (text === undefined || text.text === undefined) {
    throw new Error('MCP result omitted text');
  }
  const envelope = text.text.startsWith('{"content"')
    ? (JSON.parse(text.text) as { content: { type: string; text?: string }[] })
    : { content: [text] };
  const inner = envelope.content.find((entry) => entry.type === 'text');
  if (inner === undefined || inner.text === undefined) {
    throw new Error('MCP envelope omitted text');
  }
  return inner.text;
}

export function withChangedAlpha(config: RawConfig, edit?: (next: RawConfig) => void): RawConfig {
  const next = structuredClone(config);
  const alpha = next.mcp?.servers.find((entry) => entry.alias === 'alpha');
  if (alpha === undefined) {
    throw new Error('Missing alpha server');
  }
  alpha.result_max_bytes = 4096;
  edit?.(next);
  return next;
}
