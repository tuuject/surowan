import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, type MutableModels } from '@earendil-works/pi-ai';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { ConversationContextStore } from '../src/context/context-store.ts';

import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import type { FileConfig, RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin.ts';
import { loadPlugins } from '../src/plugins/plugin.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import { DictionaryStore } from '../src/plugins/dictionary/dictionary-store.ts';

/**
 * Real invocation lifecycle for dictionary injection.
 *
 * These drive a full `AgentRuntime.run` over a faux provider, so the assertions
 * are on durable state — the canonical `context_messages` rows, `head_seq`,
 * `context_refs` and the audit stream — not on a returned string. Injection and
 * dedupe are properties of the live Context, and only a real run proves they
 * survive a batch, a cache forget and a GC.
 */

const directories: string[] = [];
const CHAT_ID = 123456789;

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly configStore: RuntimeConfigurationStore;
  readonly conversationRuntime: ConversationRuntime;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly logs: string[];
  runtimeWith(faux: ReturnType<typeof fauxProvider>): Promise<AgentRuntime>;
}

function fauxAgent(): ReturnType<typeof fauxProvider> {
  return fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
}

function update(updateId: number, messageId: number, text: string): Update {
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

async function fixture(transform?: (config: FileConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-dictionary-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  const jsonc = testConfigJsonc(directory, (config) => {
    config.telegram.bucket_window_seconds = 0;
    config.agent!.send_nudge_enabled = false;
    // No idle grace: one bucket per invocation keeps the transcript steps exact.
    config.agent!.context!.idle_grace_seconds = 0;
    // The dictionary is injected from the global scope by default; a private
    // chat reads globals only, which is exactly the scope under test here.
    config.dictionary = { injection_mode: 'aggressive' };
    transform?.(config);
  });
  await writeTestConfig(directory, configPath, jsonc);
  const loaded = await loadConfig(configPath);
  const registry = fauxRegistry(fauxAgent());
  const configStore = await testConfigStore(loaded, registry);
  const store = await SqliteStore.open(loaded.config);
  const conversationRuntime = new ConversationRuntime({
    agentCacheSize: () => loaded.config.agent!.context!.agent_cache_size,
  });
  const logs: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  const sendApi: TelegramTransport = {
    sendTyping: async () => undefined,
    sendMessage: async () => ({ message_id: 900, date: 1_700_000_100, chat: { id: CHAT_ID } }),
    sendSticker: async () => ({ message_id: 901, date: 1_700_000_100, chat: { id: CHAT_ID } }),
  };
  const runtimeWith = async (faux: ReturnType<typeof fauxProvider>): Promise<AgentRuntime> => {
    (registry.models as MutableModels).setProvider(faux.provider);
    return new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime(sendApi),
      bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
      systemResources: emptySystemResources(),
      // The same injectors the composition root hands the runtime, so the
      // dictionary plugin's injection runs in these faux-provider invocations.
      contextInjectors: loadPlugins(BUILTIN_PLUGINS).contextInjectors,
      conversationRuntime,
    });
  };
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  // The mock is only undone at the end of the suite; the array keeps collecting.
  log.mockClear();
  return { store, config: loaded.config, configStore, conversationRuntime, ingestion, scheduler, logs, runtimeWith };
}

interface RunResult {
  readonly outcome: Awaited<ReturnType<AgentRuntime['run']>>;
  readonly invocationId: bigint;
}

/** Ingests one message, runs its invocation to completion, and closes the bucket. */
async function runBatch(
  f: Fixture,
  runtime: AgentRuntime,
  snapshot: InvocationConfigSnapshot,
  updateId: number,
  messageId: number,
  text: string,
): Promise<RunResult> {
  f.ingestion.ingest(update(updateId, messageId, text), new Date());
  const [invocationId] = f.scheduler.processDue(new Date());
  if (invocationId === undefined) {
    throw new Error(`Expected an invocation for ${text}`);
  }
  const outcome = await runtime.run(invocationId, snapshot, new AbortController().signal);
  f.store.db.prepare("UPDATE invocations SET state = 'completed' WHERE id = ?").run(invocationId);
  f.store.db
    .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
    .run(invocationId);
  return { outcome, invocationId };
}

/** The user rows of the canonical history, in transcript order. */
function retainedUserRows(store: SqliteStore): { seq: bigint; payload_json: string }[] {
  return store.db
    .prepare<[], { seq: bigint; payload_json: string }>(
      "SELECT seq, payload_json FROM context_messages WHERE role = 'user' AND evicted_at IS NULL ORDER BY seq",
    )
    .all();
}

function headSeq(store: SqliteStore): bigint {
  const row = store.db.prepare<[], { head_seq: bigint }>('SELECT head_seq FROM conversation_contexts').get();
  if (row === undefined) {
    throw new Error('Expected a conversation context');
  }
  return row.head_seq;
}

/** The rows of the transcript whose payload still carries a dictionary block. */
function rowsCarryingDictionary(store: SqliteStore): { seq: bigint; payload_json: string }[] {
  return retainedUserRows(store).filter((row) => row.payload_json.includes('<untrusted_dictionary>'));
}

function injectedDictionaryCounts(f: Fixture): number[] {
  return f.logs
    .map((line) => {
      try {
        return JSON.parse(line) as { event?: string; injections?: Record<string, number> };
      } catch {
        return undefined;
      }
    })
    .filter(
      (entry): entry is { event: string; injections: Record<string, number> } => entry?.event === 'context_injected',
    )
    .map((entry) => entry.injections.dictionary ?? 0);
}

describe('dictionary runtime lifecycle', () => {
  test('a hit persists, dedupes on the next batch, reseeds from the DB after a cache forget, and refreshes after a GC', async () => {
    const f = await fixture();
    const faux = fauxAgent();
    faux.setResponses([
      fauxAssistantMessage('first'),
      fauxAssistantMessage('second'),
      fauxAssistantMessage('third'),
      fauxAssistantMessage('fourth'),
      fauxAssistantMessage('fifth'),
      fauxAssistantMessage('sixth'),
    ]);
    const runtime = await f.runtimeWith(faux);
    try {
      const dictionary = new DictionaryStore(f.store.orm);
      const entry = dictionary.create({
        term: '碗',
        definition: '群内对 Bot 的昵称',
        aliases: [],
        scope: 'global',
        chatId: null,
        enabled: true,
      });

      // Batch one carries the term, so `aggressive` injects it and the tag lands
      // in a canonical `context_messages` row.
      const first = await runBatch(f, runtime, f.configStore.beginInvocation(), 1, 10, '今天碗怎么不说话了？');
      expect(first.outcome).toEqual({ state: 'completed', reason: 'completed' });
      let carrying = rowsCarryingDictionary(f.store);
      expect(carrying).toHaveLength(1);
      expect(carrying[0]?.payload_json).toContain(`- [${entry.id} r1]`);
      // The audit stream reports the injected count on that batch.
      expect(injectedDictionaryCounts(f).at(-1)).toBe(1);

      // Batch two must not re-inject the same id+revision: the retained transcript
      // already carries the tag, so no new row holds a dictionary block.
      await runBatch(f, runtime, f.configStore.beginInvocation(), 2, 11, 'still talking');
      expect(rowsCarryingDictionary(f.store)).toHaveLength(1);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(0);

      // Drop the in-memory agent: the next run seeds from SQLite, and the tags
      // read back from the durable transcript still suppress a re-injection.
      const conversationId = f.store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1').get()?.id;
      if (conversationId === undefined) {
        throw new Error('Expected a conversation');
      }
      f.conversationRuntime.forget(conversationId);
      await runBatch(f, runtime, f.configStore.beginInvocation(), 3, 12, 'after the cache is gone');
      expect(rowsCarryingDictionary(f.store)).toHaveLength(1);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(0);

      // An update advances the revision, so the new version is injectable again.
      const updated = dictionary.update(
        entry.id,
        { term: '碗', definition: '更新后的解释', aliases: [], scope: 'global', chatId: null, enabled: true },
        entry.revision,
      );
      expect(updated.revision).toBe('2');
      await runBatch(f, runtime, f.configStore.beginInvocation(), 4, 13, 'after the update');
      carrying = rowsCarryingDictionary(f.store);
      expect(carrying.some((row) => row.payload_json.includes(`- [${entry.id} r2]`))).toBe(true);
      expect(carrying.some((row) => row.payload_json.includes('更新后的解释'))).toBe(true);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(1);
      // r2 is now carried, so the next batch adds nothing.
      await runBatch(f, runtime, f.configStore.beginInvocation(), 5, 14, 'still carrying r2');
      expect(injectedDictionaryCounts(f).at(-1)).toBe(0);

      // A GC advances `head_seq` past the batch that carried r2. Dropping the
      // in-memory agent makes the next run seed the retained window from SQLite,
      // exactly as an eviction or restart does, so the dedupe map is rebuilt from
      // what actually survived the collection.
      const contextStore = new ConversationContextStore(f.store);
      const header = contextStore.header(conversationId);
      if (header === undefined) {
        throw new Error('Expected a context header');
      }
      const userRows = retainedUserRows(f.store);
      const r2Row = userRows.find((row) => row.payload_json.includes(`- [${entry.id} r2]`));
      // A later checkpoint (the next batch's user row) is where a real collection
      // would cut to; it drops the r2 batch without orphaning a turn.
      const nextCheckpoint = userRows.find((row) => r2Row !== undefined && row.seq > r2Row.seq);
      if (r2Row === undefined || nextCheckpoint === undefined) {
        throw new Error('Expected the r2 row and a following checkpoint');
      }
      const beforeHead = headSeq(f.store);
      contextStore.advanceHead(header, nextCheckpoint.seq);
      expect(headSeq(f.store)).toBe(nextCheckpoint.seq);
      expect(headSeq(f.store)).toBeGreaterThan(beforeHead);
      expect(retainedUserRows(f.store).some((row) => row.payload_json.includes(`- [${entry.id} r2]`))).toBe(false);
      f.conversationRuntime.forget(conversationId);

      await runBatch(f, runtime, f.configStore.beginInvocation(), 6, 15, 'after the collection');
      carrying = rowsCarryingDictionary(f.store);
      expect(carrying.some((row) => row.payload_json.includes(`- [${entry.id} r2]`))).toBe(true);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(1);

      // The audit rows for the runs that injected are inspectable, and the
      // durable transcript carries the injected block the model actually saw.
      const injectedAudit = f.logs
        .map((line) => JSON.parse(line) as { event?: string; injections?: Record<string, number> })
        .filter((entry) => entry.event === 'context_injected' && (entry.injections?.dictionary ?? 0) === 1);
      expect(injectedAudit.length).toBeGreaterThanOrEqual(2);
    } finally {
      f.store.close();
      vi.restoreAllMocks();
    }
  }, 30_000);

  test('a disabled entry is never injected, and enabling it injects on the next batch', async () => {
    const f = await fixture((config) => {
      config.dictionary = { injection_mode: 'aggressive' };
    });
    const faux = fauxAgent();
    faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')]);
    const runtime = await f.runtimeWith(faux);
    try {
      const dictionary = new DictionaryStore(f.store.orm);
      const entry = dictionary.create({
        term: '塑料碗',
        definition: 'Bot 的昵称',
        aliases: [],
        scope: 'global',
        chatId: null,
        enabled: false,
      });
      await runBatch(f, runtime, f.configStore.beginInvocation(), 1, 10, 'hello');
      expect(rowsCarryingDictionary(f.store)).toHaveLength(0);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(0);

      dictionary.update(
        entry.id,
        { term: '塑料碗', definition: 'Bot 的昵称', aliases: [], scope: 'global', chatId: null, enabled: true },
        entry.revision,
      );
      await runBatch(f, runtime, f.configStore.beginInvocation(), 2, 11, 'again');
      const carrying = rowsCarryingDictionary(f.store);
      expect(carrying).toHaveLength(1);
      expect(carrying[0]?.payload_json).toContain(`- [${entry.id} r2]`);
    } finally {
      f.store.close();
      vi.restoreAllMocks();
    }
  }, 30_000);

  test('on_demand injection matches an unspaced term against a pangu-spaced message, both directions', async () => {
    const f = await fixture((config) => {
      config.dictionary = { injection_mode: 'on_demand' };
    });
    const faux = fauxAgent();
    faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second'), fauxAssistantMessage('third')]);
    const runtime = await f.runtimeWith(faux);
    try {
      const dictionary = new DictionaryStore(f.store.orm);
      // Stored unspaced; the message carries a pangu space.
      const entry = dictionary.create({
        term: 'AB钙',
        definition: '带希腊字母钙',
        aliases: [],
        scope: 'global',
        chatId: null,
        enabled: true,
      });

      await runBatch(f, runtime, f.configStore.beginInvocation(), 1, 10, '今天AB 钙怎么讲？');
      const carrying = rowsCarryingDictionary(f.store);
      expect(carrying).toHaveLength(1);
      expect(carrying[0]?.payload_json).toContain(`- [${entry.id} r1]`);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(1);

      // The reverse direction: an entry stored with the pangu space matches an
      // unspaced message. A new entry is used so dedupe does not mask the hit.
      const spaced = dictionary.create({
        term: 'CD 片',
        definition: '带空格的片',
        aliases: [],
        scope: 'global',
        chatId: null,
        enabled: true,
      });
      await runBatch(f, runtime, f.configStore.beginInvocation(), 2, 11, '那CD片呢');
      const carryingSpaced = rowsCarryingDictionary(f.store);
      expect(carryingSpaced.some((row) => row.payload_json.includes(`- [${spaced.id} r1]`))).toBe(true);
      expect(injectedDictionaryCounts(f).at(-1)).toBe(1);

      // A case-only difference is not a match: nothing is injected.
      await runBatch(f, runtime, f.configStore.beginInvocation(), 3, 12, '另外ab钙呢');
      expect(injectedDictionaryCounts(f).at(-1)).toBe(0);
    } finally {
      f.store.close();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
