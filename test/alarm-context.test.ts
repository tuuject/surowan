import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { fauxRegistry, renderInvocationContext, testConfigJsonc, testConfigStore, writeTestConfig } from './helpers.ts';
import { alarmTools, getAlarmTask, insertAlarmTask } from './alarm-fixtures.ts';
import {
  cleanupAlarmFixtures,
  directories,
  futureIso,
  stores,
  toolCallAudits,
  update,
} from './alarm-context-fixtures.ts';

afterEach(cleanupAlarmFixtures);

async function authFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-auth-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.agent!.history_messages = 5;
      config.telegram.bucket_window_seconds = 0;
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  return {
    store,
    config: loaded.config,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' })),
    build: (id: bigint) => renderInvocationContext(store, loaded.config, id),
  };
}

function processOne(scheduler: BucketScheduler, at: Date): bigint {
  const [id] = scheduler.processDue(at);
  if (id === undefined) {
    throw new Error('Expected one due invocation');
  }
  return id;
}

function finishInvocation(store: SqliteStore, id: bigint, at: string): void {
  store.db
    .prepare(
      "UPDATE invocations SET state = 'completed', finished_at = ?, completion_reason = 'completed' WHERE id = ?",
    )
    .run(at, id);
  store.db
    .prepare(
      "UPDATE buckets SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
    )
    .run(at, at, id);
}

describe('alarm authorization', () => {
  test('creator Alice can cancel an alarm targeting Bob; Bob cannot see or cancel it while pending', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'Bob is visible', 99), at);
    ingestion.ingest(update(2, 'remind Bob', 42), new Date(at.getTime() + 1_000));
    const aliceInvocation = processOne(scheduler, new Date(at.getTime() + 2_000));
    const context = build(aliceInvocation);
    const created = await alarmTools(store, config, context).alarm.execute('alice-create', {
      target_user_id: '99',
      summary: 'meeting',
      datetime: futureIso(),
    });
    expect((await alarmTools(store, config, context).list_alarm.execute('alice-list', {})).details.items).toEqual([
      expect.objectContaining({ id: created.details.id }),
    ]);
    finishInvocation(store, aliceInvocation, new Date(at.getTime() + 3_000).toISOString());
    ingestion.ingest(update(3, 'my alarms', 99), new Date(at.getTime() + 4_000));
    const bobInvocation = processOne(scheduler, new Date(at.getTime() + 5_000));
    const bob = alarmTools(store, config, build(bobInvocation));
    expect((await bob.list_alarm.execute('bob-list', {})).details.items).toEqual([]);
    await expect(bob.delete_alarm.execute('bob-delete', { id: created.details.id })).rejects.toThrow('alarm not found');
    expect(getAlarmTask(store, BigInt(created.details.id))?.task_state).toBe('waiting');
    finishInvocation(store, bobInvocation, new Date(at.getTime() + 6_000).toISOString());
    ingestion.ingest(update(4, 'cancel it', 42), new Date(at.getTime() + 7_000));
    const aliceAgain = build(processOne(scheduler, new Date(at.getTime() + 8_000)));
    expect(
      (await alarmTools(store, config, aliceAgain).delete_alarm.execute('alice-delete', { id: created.details.id }))
        .details.state,
    ).toBe('cancelled');
    expect(toolCallAudits(store).filter((row) => row.tool_name === 'delete_alarm')).toEqual([
      { tool_name: 'delete_alarm', state: 'error', error_code: 'alarm_not_found' },
      { tool_name: 'delete_alarm', state: 'success', error_code: null },
    ]);
  });

  test('delete only cancels caller-owned pending alarms and normalizes failures to not_found', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'delete alarms'), at);
    const context = build(processOne(scheduler, new Date(at.getTime() + 1_000)));
    const own = insertAlarmTask(store, context.conversationId, 42n, 'mine', futureIso());
    const other = insertAlarmTask(store, context.conversationId, 99n, 'theirs', futureIso());
    const tool = alarmTools(store, config, context).delete_alarm;
    expect((await tool.execute('delete-ok', { id: own.toString() })).details.state).toBe('cancelled');
    expect(getAlarmTask(store, own)).toMatchObject({
      task_state: 'cancelled',
      receipt_state: 'suppressed',
      cancel_reason: 'user_requested',
    });
    await expect(tool.execute('delete-other', { id: other.toString() })).rejects.toThrow('alarm not found');
    await expect(tool.execute('delete-missing', { id: '999999' })).rejects.toThrow('alarm not found');
    await expect(tool.execute('delete-already-cancelled', { id: own.toString() })).rejects.toThrow('alarm not found');
    expect(toolCallAudits(store)).toEqual([
      { tool_name: 'delete_alarm', state: 'success', error_code: null },
      ...Array.from({ length: 3 }, () => ({
        tool_name: 'delete_alarm',
        state: 'error',
        error_code: 'alarm_not_found',
      })),
    ]);
  });

  test('latest new user is the caller even with multi-user visible history', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'Alice history'), at);
    const first = processOne(scheduler, new Date(at.getTime() + 1_000));
    finishInvocation(store, first, new Date(at.getTime() + 2_000).toISOString());
    ingestion.ingest(update(2, 'Alice again'), new Date(at.getTime() + 3_000));
    ingestion.ingest(update(3, 'Bob latest', 99), new Date(at.getTime() + 4_000));
    const context = build(processOne(scheduler, new Date(at.getTime() + 5_000)));
    expect(context.visibleSenders.size).toBe(2);
    expect(context.callerUserId).toBe(99n);
    const created = await alarmTools(store, config, context).alarm.execute('latest-new', {
      target_user_id: '42',
      summary: 'Bob asks to remind Alice',
      datetime: futureIso(),
    });
    expect(
      store.db
        .prepare<[string]>(
          "SELECT created_by_user_id, json_extract(payload_json, '$.target_user_id') AS target_user_id FROM long_tasks WHERE id = ?",
        )
        .get(created.details.id),
    ).toEqual({ created_by_user_id: 99n, target_user_id: '42' });
  });

  test('tools fail closed without a reliable caller', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'seed'), at);
    const first = processOne(scheduler, new Date(at.getTime() + 1_000));
    finishInvocation(store, first, new Date(at.getTime() + 2_000).toISOString());
    store.db
      .prepare(
        "INSERT INTO senders(telegram_type, telegram_id, is_bot, display_name, updated_at) VALUES ('sender_chat', 777, 0, 'Channel', ?)",
      )
      .run(at.toISOString());
    ingestion.ingest(update(2, 'anonymous'), new Date(at.getTime() + 3_000));
    store.db
      .prepare(
        "UPDATE message_revisions SET sender_id = (SELECT id FROM senders WHERE telegram_type = 'sender_chat' LIMIT 1) WHERE message_id = (SELECT id FROM messages WHERE telegram_message_id = 2)",
      )
      .run();
    const context = build(processOne(scheduler, new Date(at.getTime() + 4_000)));
    expect(context.callerUserId).toBeNull();
    const tools = alarmTools(store, config, context);
    await expect(
      tools.alarm.execute('create', { target_user_id: '42', summary: 'x', datetime: futureIso() }),
    ).rejects.toThrow('caller identity');
    await expect(tools.list_alarm.execute('list', {})).rejects.toThrow('caller identity');
    await expect(tools.delete_alarm.execute('delete', { id: '1' })).rejects.toThrow('caller identity');
    expect(toolCallAudits(store)).toEqual(
      ['alarm', 'list_alarm', 'delete_alarm'].map((tool_name) => ({
        tool_name,
        state: 'error',
        error_code: 'alarm_caller_not_available',
      })),
    );
  });

  test('legacy alarms with nullable creator are invisible and cannot be deleted', async () => {
    const { store, config, ingestion, scheduler, build } = await authFixture();
    const at = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 'list'), at);
    const context = build(processOne(scheduler, new Date(at.getTime() + 1_000)));
    const legacy = insertAlarmTask(store, context.conversationId, 42n, 'legacy', futureIso(), null);
    const tools = alarmTools(store, config, context);
    expect((await tools.list_alarm.execute('legacy-list', {})).details.items).toEqual([]);
    await expect(tools.delete_alarm.execute('legacy-delete', { id: legacy.toString() })).rejects.toThrow(
      'alarm not found',
    );
    expect(getAlarmTask(store, legacy)?.task_state).toBe('waiting');
  });
});
