import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { ResolveUserIdInputSchema, createResolveUserIdTool } from '../src/capabilities/resolve-user-id-tool.ts';
import { USER_ID_GUIDANCE } from '../src/context/context-builder.ts';
import { createMemoryTools, MemoryStore } from '../src/context/memory.ts';
import { alarmTools } from './alarm-fixtures.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { previewContext } from '../src/platform/invocation-context.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import type { Update } from 'grammy/types';
import { fauxProvider } from '@earendil-works/pi-ai';
import { fauxRegistry, renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30_000);

function update(updateId: number, messageId: number, text: string, userId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: 'Alice' },
      text,
    },
  } as unknown as Update;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-resolve-user-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.admins = [42];
      config.telegram.bucket_window_seconds = 0;
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, fauxRegistry(fauxProvider({ provider: 'agent' })));
  const store = await SqliteStore.open(loaded.config);
  return {
    config: loaded.config,
    configStore,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (invocationId: bigint) => renderInvocationContext(store, loaded.config, invocationId),
  };
}

function processDue(scheduler: BucketScheduler, at: Date): bigint {
  const invocation = scheduler.processDue(at).at(0);
  if (invocation === undefined) {
    throw new Error('scheduler produced no invocation');
  }
  return invocation;
}

function finishBucket(store: SqliteStore, invocationId: bigint, at: Date): void {
  const at2 = at.toISOString();
  store.db
    .prepare(
      "UPDATE invocations SET state = 'completed', finished_at = ?, completion_reason = 'completed' WHERE id = ?",
    )
    .run(at2, invocationId);
  store.db
    .prepare(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(at2, at2, invocationId);
}

describe('resolve_user_id primitive', () => {
  test('schema admits only compact positive integers', () => {
    const validator = Compile(ResolveUserIdInputSchema);
    expect(validator.Check({ user_id: '1' })).toBe(true);
    expect(validator.Check({ user_id: '12' })).toBe(true);
    expect(validator.Check({ user_id: '0' })).toBe(false);
    expect(validator.Check({ user_id: '-1' })).toBe(false);
    expect(validator.Check({ user_id: '01' })).toBe(false);
    expect(validator.Check({ user_id: 'abc' })).toBe(false);
    expect(validator.Check({})).toBe(false);
    expect(validator.Check({ user_id: '1', extra: true })).toBe(false);
  });

  test('resolves compact ids back to the real Telegram users without confusion', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'from alice', 42), received);
    ingestion.ingest(update(2, 11, 'from bob', 9_000_000_000_000_000_000), new Date(received.getTime() + 1_000));
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId);
    const tool = createResolveUserIdTool({ store, context });
    const one = await tool.execute('r1', { user_id: '1' });
    const two = await tool.execute('r2', { user_id: '2' });
    // Real ids come back as full-precision decimal strings, distinct per user.
    expect(one.details.telegram_user_id).toBeTypeOf('string');
    expect(two.details.telegram_user_id).toBeTypeOf('string');
    expect(one.details.telegram_user_id).not.toBe(two.details.telegram_user_id);
    expect([one.details.telegram_user_id, two.details.telegram_user_id].toSorted().join(',')).toBe(
      ['42', '9000000000000000000'].join(','),
    );
    // Repeated resolution is stable within one invocation.
    expect((await tool.execute('r3', { user_id: '1' })).details.telegram_user_id).toBe(one.details.telegram_user_id);
    store.close();
  });

  test('unknown ids fail without guessing and maps do not cross invocations', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello', 42), received);
    const firstInvocation = processDue(scheduler, new Date(received.getTime() + 2_000));
    const firstTool = createResolveUserIdTool({ store, context: build(firstInvocation) });
    expect((await firstTool.execute('first-1', { user_id: '1' })).details.telegram_user_id).toBe('42');
    await expect(firstTool.execute('unknown', { user_id: '2' })).rejects.toThrow('resolve_user_id_unknown');
    await expect(firstTool.execute('huge', { user_id: '99999999' })).rejects.toThrow('resolve_user_id_unknown');
    // A real Telegram id quoted by the model is not a compact id.
    await expect(firstTool.execute('real', { user_id: '42' })).rejects.toThrow('resolve_user_id_unknown');
    // A second invocation builds a fresh map from its own rendered text — it
    // neither inherits nor reuses the ended invocation's table. The retained
    // history re-renders user 42 first (id 1 again); the new speaker gets 2.
    finishBucket(store, firstInvocation, new Date(received.getTime() + 3_000));
    ingestion.ingest(update(2, 12, 'again', 777), new Date(received.getTime() + 4_000));
    const secondInvocation = processDue(scheduler, new Date(received.getTime() + 17_000));
    const secondTool = createResolveUserIdTool({ store, context: build(secondInvocation) });
    expect((await secondTool.execute('second-1', { user_id: '1' })).details.telegram_user_id).toBe('42');
    expect((await secondTool.execute('second-2', { user_id: '2' })).details.telegram_user_id).toBe('777');
    await expect(secondTool.execute('second-3', { user_id: '3' })).rejects.toThrow('resolve_user_id_unknown');
    store.close();
  });

  test('a large real id keeps full precision through resolution', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    // 2^53+1 cannot travel through a JS number, so the precision boundary this
    // primitive owns is the string -> bigint -> string round trip on the map.
    // Feed an id that survives the ingestion JSON boundary exactly and assert
    // the returned string is that same value, not a Number-rounded one.
    ingestion.ingest(update(1, 10, 'large', 1_800_143_986_509_153), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const tool = createResolveUserIdTool({ store, context: build(invocationId) });
    const result = await tool.execute('r1', { user_id: '1' });
    expect(result.details.telegram_user_id).toBe('1800143986509153');
    expect(BigInt(result.details.telegram_user_id)).toBe(1_800_143_986_509_153n);
    expect(Number.isSafeInteger(Number(result.details.telegram_user_id))).toBe(true);
    store.close();
  });

  test('the stable system prompt states the compact-id rule once', async () => {
    const { store, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello', 42), received);
    const context = build(processDue(scheduler, new Date(received.getTime() + 15_000)));
    expect(context.systemPrompt).toContain(USER_ID_GUIDANCE);
    expect(context.systemPrompt).toContain('resolve_user_id');
    // The mapping table never leaks into the prompt.
    expect(context.systemPrompt).not.toMatch(/\b42\b/);
    store.close();
  });

  test('alarm rejects an unresolved compact id and stores the resolved real id', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'remind me', 42), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId);
    const tools = alarmTools(store, config, context);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    // Passing the compact id straight through is rejected, never stored.
    await expect(
      tools.alarm.execute('compact', { target_user_id: '1', summary: 'x', datetime: future }),
    ).rejects.toThrow('compact context id');
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM long_tasks WHERE plugin_id = 'alarm'")
        .get()?.count,
    ).toBe(0n);
    // Resolving first, then passing the real id, persists the real id.
    const resolved = await createResolveUserIdTool({ store, context }).execute('resolve', { user_id: '1' });
    const created = await tools.alarm.execute('real', {
      target_user_id: resolved.details.telegram_user_id,
      summary: 'x',
      datetime: future,
    });
    const row = store.db
      .prepare<[string], { target_user_id: string; created_by_user_id: bigint | null; delivery: string | null }>(
        `SELECT json_extract(payload_json, '$.target_user_id') AS target_user_id, created_by_user_id,
                json_extract(delivery_json, '$.mentionUser.userId') AS delivery
         FROM long_tasks WHERE id = ?`,
      )
      .get(created.details.id);
    expect(row).toEqual({ target_user_id: '42', created_by_user_id: 42n, delivery: '42' });
    store.close();
  });

  test('a persisted alarm keeps the real id after its invocation ended', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'remind me', 42), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId);
    const resolved = await createResolveUserIdTool({ store, context }).execute('resolve', { user_id: '1' });
    await alarmTools(store, config, context).alarm.execute('real', {
      target_user_id: resolved.details.telegram_user_id,
      summary: 'after the invocation',
      datetime: new Date(Date.now() + 3_600_000).toISOString(),
    });
    finishBucket(store, invocationId, received);
    const delivery = store.db
      .prepare<[], { payload_user_id: string; delivery_user_id: string | null }>(
        `SELECT json_extract(payload_json, '$.target_user_id') AS payload_user_id,
                json_extract(delivery_json, '$.mentionUser.userId') AS delivery_user_id
         FROM long_tasks WHERE plugin_id = 'alarm'`,
      )
      .get();
    expect(delivery).toEqual({ payload_user_id: '42', delivery_user_id: '42' });
    store.close();
  });

  test('memory notes and alarm summaries persist compact ids as real ids', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'remember me', 42), received);
    const context = build(processDue(scheduler, new Date(received.getTime() + 15_000)));
    const [addMemory] = createMemoryTools(new MemoryStore(store.orm), context);
    if (addMemory === undefined) {
      throw new Error('add_memory is missing');
    }
    await addMemory.execute('m1', { content: 'uid:1 likes cats' });
    // A note that only fits as compact text is refused rather than truncated.
    await expect(addMemory.execute('m2', { content: `uid:1 ${'x'.repeat(144)}` })).rejects.toThrow(
      'exceeds 150 characters',
    );
    expect(store.db.prepare<[], { content: string }>('SELECT content FROM memories ORDER BY created_at').all()).toEqual(
      [{ content: 'uid:42 likes cats' }],
    );
    expect(
      store.db
        .prepare<[string], { error_code: string | null }>('SELECT error_code FROM tool_calls WHERE tool_call_id = ?')
        .get('m2'),
    ).toEqual({ error_code: 'memory_content_too_long' });

    const { alarm } = alarmTools(store, config, context);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await alarm.execute('a1', { target_user_id: '42', summary: 'remind uid:1 to feed the cat', datetime: future });
    expect(
      store.db
        .prepare<[], { summary: string }>(
          "SELECT json_extract(payload_json, '$.summary') AS summary FROM long_tasks WHERE plugin_id = 'alarm'",
        )
        .get(),
    ).toEqual({ summary: 'remind uid:42 to feed the cat' });
    await expect(
      alarm.execute('a2', { target_user_id: '42', summary: `uid:1 ${'x'.repeat(494)}`, datetime: future }),
    ).rejects.toThrow('exceeds 500 characters');
    store.close();
  });

  test('the runtime registers resolve_user_id as a direct primitive, not an execute capability', async () => {
    const { store, config, configStore } = await setup();
    const { AgentRuntime } = await import('../src/orchestration/agent-runtime.ts');
    const registry = new AgentRuntime({
      store,
      configStore,
      telegramApi: {
        sendMessage: async () => {
          throw new Error('not used');
        },
      },
      secrets: { redact: (value: string) => value, redactError: (error: Error) => error.message },
      bot: { id: 999n, displayName: 'PlasticWan', username: 'plasticwan_test' },
      systemResources: emptySystemResources(),
    } as never);
    const presented = registry.sceneToolDefinitions(previewContext(), config);
    expect(presented.tools.map((tool) => tool.name)).toContain('resolve_user_id');
    store.close();
  });
});
