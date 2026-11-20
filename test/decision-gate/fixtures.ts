import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { vi, type Mock } from 'vitest';
import { type LoadedConfig, loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { TelegramIngestion as Ingestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { ConversationRuntime } from '../../src/orchestration/conversation-runtime.ts';
import type { DecisionGateBot, DecisionGateOptions } from '../../src/orchestration/decision-gate/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { keychainPath } from '../../src/platform/keychain.ts';
import type { RuntimeConfigurationStore } from '../../src/platform/runtime-config.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import {
  type FixtureConfig,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
  writeTestKeychain,
} from '../helpers.ts';

/**
 * Harness for the Decisions entry gate: a real store, a real
 * `InvocationQueueService`/`BucketScheduler` and the real ingestion edge, with
 * the Decisions API replaced by an in-memory service. Nothing here reaches a
 * network.
 */

const directories: string[] = [];

export const GROUP_A = -1_001_234_567_890;
export const GROUP_B = -1_001_234_567_891;
export const PRIVATE = 123_456_789;
export const BOT_ID = 999;
export const BOT_USERNAME = 'SurowanBot';
export const BOT_DISPLAY_NAME = '塑料碗';
export const WINDOW_MS = 15_000;
/** All fixture times hang off the real clock and sit in the past, so no test date can expire. */
export const START = new Date(Date.now() - 3_600_000);
export const KEYCHAIN_ENTRY = 'decision-gate';
export const API_KEY = 'decision-gate-secret';

export async function resetHarness(): Promise<void> {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export interface DecisionCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: {
    readonly model: string;
    readonly state: {
      readonly bot: { readonly name: string; readonly username: string };
      readonly history: readonly { readonly from: string; readonly text: string; readonly reply_to?: string }[];
      readonly pending: readonly { readonly from: string; readonly text: string; readonly reply_to?: string }[];
    };
    readonly questions: { readonly gate: { readonly type: string; readonly instructions: string } };
  };
}

type Responder = (call: DecisionCall) => Response | Promise<Response>;

/**
 * The Decisions API double. `respond` replaces the handler; `calls` keeps every
 * request the gate actually sent, in order, so a test can assert both content
 * and count.
 */
export class DecisionService {
  readonly calls: DecisionCall[] = [];
  responder: Responder = () => answer(0.9);
  /** Set for the stop test: never answers until the request is aborted. */
  hang = false;

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    const call = parseCall(String(input), init, String(init?.body ?? ''));
    this.calls.push(call);
    if (this.hang) {
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The decision request was aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    return await this.responder(call);
  }) as unknown as typeof fetch;
}

function parseCall(url: string, init: RequestInit | undefined, body: string): DecisionCall {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const parsed = JSON.parse(body) as DecisionCall['body'];
  return {
    url,
    authorization: headers.authorization ?? null,
    body: parsed,
  };
}

/** A model answer with the given P(yes). */
export function answer(probability: number, usage: { input_tokens?: number; cost?: number } = {}): Response {
  return json({
    answers: { gate: { type: 'noul', noul: probability } },
    usage: {
      input_tokens: usage.input_tokens ?? 21,
      output_tokens: 1,
      ...(usage.cost === undefined ? {} : { cost: usage.cost }),
    },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function gate(enabled: boolean, mode: 'shadow' | 'enforce', overrides: Record<string, unknown> = {}) {
  return {
    enabled,
    mode,
    timeout_ms: 3_000,
    api_key: { jar: KEYCHAIN_ENTRY },
    ...overrides,
  };
}

export interface HarnessOptions {
  readonly mode?: 'shadow' | 'enforce';
  /** Replaces the whole `telegram.decision_gate` section; `undefined` leaves the section out. */
  readonly decisionGate?: Record<string, unknown> | undefined;
  readonly transform?: (config: FixtureConfig) => void;
  readonly twoGroups?: boolean;
  readonly random?: () => number;
  readonly tasks?: LongTaskService;
  /** Overrides the bot identity object the gate holds; production passes a live one. */
  readonly bot?: DecisionGateBot;
  /** Skips the proactive reply sampler entirely, like `createCoreRuntime` with no sampled Chat. */
  readonly proactiveBot?: boolean;
  /** Global in-flight cap of the gate; the production default is 4. */
  readonly maxConcurrent?: number;
}

export interface Harness {
  readonly directory: string;
  readonly configPath: string;
  readonly loaded: LoadedConfig;
  readonly store: SqliteStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly attachment: ConversationRuntime;
  readonly tasks: LongTaskService;
  readonly decisions: DecisionService;
  readonly wake: Mock<() => void>;
  readonly random: Mock<() => number>;
  readonly secrets: SecretStore;
  /** Builds another scheduler, as a restarted process over the same database does. */
  newScheduler(options?: { readonly tasks?: LongTaskService; readonly store?: SqliteStore }): BucketScheduler;
}

export async function setup(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-decision-gate-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.bucket_window_seconds = 15;
    config.telegram.chats = [
      { id: GROUP_A, instructions_file: 'chat-instructions.md' },
      ...(options.twoGroups === true ? [{ id: GROUP_B, instructions_file: 'chat-instructions.md' }] : []),
    ];
    if (options.decisionGate !== undefined) {
      config.telegram.decision_gate = options.decisionGate as NonNullable<FixtureConfig['telegram']['decision_gate']>;
    }
    options.transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  await writeTestKeychain(directory, { [KEYCHAIN_ENTRY]: API_KEY });
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const secrets = new SecretStore(keychainPath(configPath));
  const decisions = new DecisionService();
  // The wake callback is the production `() => scheduler?.wake()`: it always
  // reaches the scheduler that is current, including a restarted one.
  let current: BucketScheduler | undefined;
  const wake = vi.fn(() => current?.wake());
  const random = vi.fn(options.random ?? (() => 0.99));
  const bot: DecisionGateBot = options.bot ?? {
    id: BigInt(BOT_ID),
    displayName: BOT_DISPLAY_NAME,
    username: BOT_USERNAME,
  };
  const gateOptions = (): DecisionGateOptions => ({
    bot,
    secrets,
    wake,
    fetchImpl: decisions.fetch,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  });
  const attachment = new ConversationRuntime({ agentCacheSize: () => 8 });
  const build = (restart: { readonly tasks?: LongTaskService; readonly store?: SqliteStore } = {}): BucketScheduler => {
    const built = new BucketScheduler(
      restart.store ?? store,
      configStore,
      async () => ({ state: 'completed', reason: 'test' }),
      attachment,
      restart.tasks,
      options.proactiveBot === false ? undefined : { bot: { id: BigInt(BOT_ID), username: BOT_USERNAME }, random },
      undefined,
      undefined,
      undefined,
      gateOptions(),
    );
    current = built;
    return built;
  };
  const tasks = options.tasks ?? new LongTaskService(store.orm);
  const scheduler = build({ tasks });
  return {
    directory,
    configPath,
    loaded,
    store,
    configStore,
    ingestion: new Ingestion(store, configStore, { id: BOT_ID, username: BOT_USERNAME }),
    scheduler,
    attachment,
    tasks,
    decisions,
    wake,
    random,
    secrets,
    newScheduler: (restart: { readonly tasks?: LongTaskService; readonly store?: SqliteStore } = {}) => build(restart),
  };
}

export function groupMessage(updateId: number, messageId: number, fields: Record<string, unknown> = {}): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(START.getTime() / 1000) + messageId,
      chat: { id: GROUP_A, type: 'supergroup', title: 'Group A' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `message ${messageId}`,
      ...fields,
    },
  } as unknown as Update;
}

export function privateMessage(updateId: number, messageId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(START.getTime() / 1000) + messageId,
      chat: { id: PRIVATE, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: `private ${messageId}`,
    },
  } as unknown as Update;
}

export interface DecisionRow {
  readonly id: bigint;
  readonly bucket_id: bigint;
  readonly conversation_id: bigint;
  readonly mode: string;
  readonly model: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly applied: bigint;
  readonly probability: number | null;
  readonly threshold: number;
  readonly history_count: bigint;
  readonly pending_count: bigint;
  readonly input_tokens: bigint | null;
  readonly cost: number | null;
  readonly duration_ms: bigint | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export function decisionRows(store: SqliteStore, bucketId?: bigint): DecisionRow[] {
  const rows =
    bucketId === undefined
      ? store.db.prepare<[], DecisionRow>('SELECT * FROM bucket_decisions ORDER BY id').all()
      : store.db
          .prepare<[bigint], DecisionRow>('SELECT * FROM bucket_decisions WHERE bucket_id = ? ORDER BY id')
          .all(bucketId);
  return rows.map((row) => ({ ...row, applied: BigInt(row.applied) }));
}

export function bucketRow(
  store: SqliteStore,
  id: bigint,
): { state: string; error_code: string | null; deadline_at: string } {
  const row = store.db
    .prepare<[bigint], { state: string; error_code: string | null; deadline_at: string }>(
      'SELECT state, error_code, deadline_at FROM buckets WHERE id = ?',
    )
    .get(id);
  if (row === undefined) {
    throw new Error(`Bucket ${id} does not exist`);
  }
  return row;
}

export function invocationCount(store: SqliteStore): number {
  return Number(
    store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count ?? 0n,
  );
}

export function invocationBucketRows(store: SqliteStore): { invocation_id: bigint; bucket_id: bigint }[] {
  return store.db
    .prepare<[], { invocation_id: bigint; bucket_id: bigint }>(
      'SELECT invocation_id, bucket_id FROM invocation_buckets ORDER BY bucket_id',
    )
    .all();
}

/** A running invocation for the Conversation, with the completed bucket a finished run leaves behind. */
export function seedRunningInvocation(store: SqliteStore, conversationId: bigint, id = 900n): bigint {
  const timestamp = START.toISOString();
  store.db
    .prepare(
      `INSERT INTO buckets(id, conversation_id, state, kind, first_received_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, 'completed', 'realtime', ?, ?, ?, ?)`,
    )
    .run(id, conversationId, timestamp, timestamp, timestamp, timestamp);
  store.db
    .prepare(
      `INSERT INTO invocations(id, bucket_id, conversation_id, state, config_hash, prompt_version, created_at)
       VALUES (?, ?, ?, 'running', 'h', 1, ?)`,
    )
    .run(id, id, conversationId, timestamp);
  return id;
}

/**
 * A message the bot published itself, written the way `send/record.ts` writes
 * one: intake never stores the bot's own outgoing messages.
 */
export function seedBotMessage(
  store: SqliteStore,
  input: { readonly conversationId: bigint; readonly messageNo: number; readonly text: string; readonly sentAt: Date },
): void {
  const at = input.sentAt.toISOString();
  const chat = store.db
    .prepare<[bigint], { chat_id: bigint }>('SELECT chat_id FROM conversations WHERE id = ?')
    .get(input.conversationId);
  if (chat === undefined) {
    throw new Error('Unknown conversation');
  }
  store.db
    .prepare(
      `INSERT INTO senders(host_kind, host_sender_type, host_sender_id, display_name, username, is_bot, updated_at)
       VALUES ('telegram', 'user', ?, ?, ?, 1, ?)
       ON CONFLICT(host_kind, host_sender_type, host_sender_id)
       DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
    )
    .run(BigInt(BOT_ID), BOT_DISPLAY_NAME, BOT_USERNAME, at);
  const senderId = store.db
    .prepare<[bigint], { id: bigint }>("SELECT id FROM senders WHERE host_sender_id = ? AND host_kind = 'telegram'")
    .get(BigInt(BOT_ID))?.id;
  if (senderId === undefined) {
    throw new Error('Bot sender was not created');
  }
  const messageId = store.db
    .prepare(
      `INSERT INTO messages(conversation_id, chat_id, host_kind, message_no, visible, sent_by_bot, sent_at, received_at)
       VALUES (?, ?, 'telegram', ?, 1, 1, ?, ?)`,
    )
    .run(input.conversationId, chat.chat_id, input.messageNo, at, at).lastInsertRowid;
  const revisionId = store.db
    .prepare(
      `INSERT INTO message_revisions(message_id, revision_no, sender_id, kind, text, raw_fragment_json, created_at)
       VALUES (?, 1, ?, 'text', ?, ?, ?)`,
    )
    .run(
      messageId,
      senderId,
      input.text,
      JSON.stringify({ message_id: input.messageNo, kind: 'text' }),
      at,
    ).lastInsertRowid;
  store.db.prepare('UPDATE messages SET current_revision_id = ? WHERE id = ?').run(revisionId, messageId);
}

export function internalChatId(store: SqliteStore): bigint {
  const row = store.db.prepare<[], { id: bigint }>('SELECT id FROM chats ORDER BY id LIMIT 1').get();
  if (row === undefined) {
    throw new Error('No chat exists');
  }
  return row.id;
}

export function conversationIdOf(store: SqliteStore): bigint {
  const row = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations ORDER BY id LIMIT 1').get();
  if (row === undefined) {
    throw new Error('No conversation exists');
  }
  return row.id;
}

/** Resolves once `predicate` holds; fails the test after the timeout instead of hanging. */
export async function until(predicate: () => boolean, label = 'condition', timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function invocationStates(store: SqliteStore): string[] {
  return store.db
    .prepare<[], { state: string }>('SELECT state FROM invocations ORDER BY id')
    .all()
    .map((row) => row.state);
}

export interface Attempt {
  readonly bucketId: bigint | undefined;
  readonly invocations: readonly bigint[];
}

/** Ingest one message and run the due pass for its window. */
export function attempt(harness: Harness, update: Update, receivedAt: Date = START, dueAt?: Date): Attempt {
  const result = harness.ingestion.ingest(update, receivedAt);
  const invocations = harness.scheduler.processDue(dueAt ?? new Date(receivedAt.getTime() + WINDOW_MS));
  return { bucketId: result.bucketId, invocations };
}

/** Waits for every started decision to finish and its phase 2 to commit. */
export async function settle(harness: Harness): Promise<void> {
  await harness.scheduler.decisionsSettled();
}

export function gateEvents(log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  const events: Record<string, unknown>[] = [];
  for (const call of log.mock.calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(call[0]));
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const event = parsed as Record<string, unknown>;
      if (event.event === 'agent_decision_gate') {
        events.push(event);
      }
    }
  }
  return events;
}
