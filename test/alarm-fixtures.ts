import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from 'grammy/types';
import { loadPlugins } from '../src/plugins/plugin.ts';
import alarmPlugin from '../src/plugins/alarm/index.ts';
import type { RawConfig } from '../src/platform/config.ts';
import type { InvocationContext } from '../src/platform/invocation-context.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import type { RuntimeConfigurationStore } from '../src/platform/runtime-config.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import {
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  type TestContextOptions,
  type TestRegistry,
  writeTestConfig,
} from './helpers.ts';

export function alarmTools(store: SqliteStore, config: RawConfig, context: InvocationContext) {
  const capabilities = loadPlugins([alarmPlugin]).capabilities(
    store,
    config,
    context,
    Date.now() + 60_000,
    new LongTaskService(store.orm),
  );
  const alarm = capabilities.find((entry) => entry.tool.name === 'alarm')?.tool;
  const listAlarm = capabilities.find((entry) => entry.tool.name === 'list_alarm')?.tool;
  const deleteAlarm = capabilities.find((entry) => entry.tool.name === 'delete_alarm')?.tool;
  if (alarm === undefined || listAlarm === undefined || deleteAlarm === undefined) {
    throw new Error('Alarm plugin tools are missing');
  }
  return { alarm, list_alarm: listAlarm, delete_alarm: deleteAlarm };
}

export interface AlarmTaskProjection {
  readonly id: bigint;
  readonly task_state: string;
  readonly receipt_state: string | null;
  readonly state: string;
  readonly invocation_id: bigint | null;
  readonly invocation_outcome: string | null;
  readonly completion_reason: string | null;
  readonly cancel_reason: string | null;
  readonly admin_cancelled: bigint | null;
}

export function getAlarmTask(store: SqliteStore, taskId: bigint): AlarmTaskProjection | undefined {
  return store.db
    .prepare<[bigint], AlarmTaskProjection>(
      `SELECT lt.id, lt.state AS task_state, tr.state AS receipt_state,
            CASE
              WHEN lt.state = 'cancelled' OR tr.state = 'suppressed' THEN 'cancelled'
              WHEN tr.state = 'claimed' THEN 'firing'
              WHEN tr.state = 'handled' THEN 'fired'
              ELSE 'pending'
            END AS state,
            tr.invocation_id, tr.invocation_outcome, tr.completion_reason,
            tr.cancel_reason, tr.admin_cancelled
       FROM long_tasks lt
       LEFT JOIN task_receipts tr ON tr.task_id = lt.id
      WHERE lt.plugin_id = 'alarm' AND lt.id = ?`,
    )
    .get(taskId);
}

export function insertAlarmTask(
  store: SqliteStore,
  conversationId: bigint,
  targetUserId: bigint,
  summary: string,
  scheduledAt: string,
  createdByUserId: bigint | null = targetUserId,
): bigint {
  const at = '2026-08-15T00:00:00.000Z';
  const payload = JSON.stringify({
    target_user_id: targetUserId.toString(),
    target_display_name: targetUserId === 42n ? 'Alice' : 'Bob',
    summary,
  });
  const created = store.db
    .prepare(
      `INSERT INTO long_tasks(plugin_id, conversation_id, created_by_user_id, payload_json, state,
                            scheduled_at, timer_result_json, delivery_json, created_at, updated_at)
     VALUES ('alarm', ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`,
    )
    .run(
      conversationId,
      createdByUserId,
      payload,
      scheduledAt,
      payload,
      JSON.stringify({
        bypassDailyBudget: true,
        mentionUser: { userId: targetUserId.toString(), displayName: targetUserId === 42n ? 'Alice' : 'Bob' },
      }),
      at,
      at,
    );
  return BigInt(created.lastInsertRowid);
}

export function completeAlarmTask(
  store: SqliteStore,
  taskId: bigint,
  state: 'pending' | 'claimed' | 'handled' | 'suppressed' = 'handled',
  at = '2026-08-16T04:31:00.000Z',
): void {
  store.db
    .prepare("UPDATE long_tasks SET state = 'completed', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, taskId);
  store.db
    .prepare(
      `INSERT INTO task_receipts(task_id, status, result_json, state, created_at, updated_at, claimed_at, handled_at)
     SELECT id, 'completed', timer_result_json, ?, ?, ?, ?, ? FROM long_tasks WHERE id = ?`,
    )
    .run(
      state,
      at,
      at,
      state === 'claimed' || state === 'handled' ? at : null,
      state === 'handled' ? at : null,
      taskId,
    );
}

const directories: string[] = [];

export async function cleanupTestDirectories(): Promise<void> {
  const pending = directories.splice(0, directories.length);
  for (const directory of pending) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

export async function setup(registry?: TestRegistry, recordPayloads = false) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.developer = { record_model_payloads: recordPayloads };
      config.telegram.admins = [42];
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, registry);
  const store = await SqliteStore.open(loaded.config);
  return {
    directory,
    configPath,
    loaded,
    configStore,
    config: loaded.config,
    store,
    ingestion: new TelegramIngestion(store, configStore, { id: 999 }),
    scheduler: new BucketScheduler(store, configStore, async () => ({
      state: 'completed',
      reason: 'done',
    })),
    build: (invocationId: bigint, options: TestContextOptions = {}) =>
      renderInvocationContext(store, loaded.config, invocationId, options),
  };
}

export async function setupAdmin(): Promise<{
  store: SqliteStore;
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  configStore: RuntimeConfigurationStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-alarm-admin-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.admin = {
        enabled: true,
        host: '127.0.0.1',
        port: 8899,
        session_ttl_hours: 12,
      };
    }),
  );
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded, configStore };
}

export function update(updateId: number, messageId: number, text: string, userId = 42): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: userId, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function processDue(scheduler: BucketScheduler, at: Date): bigint {
  const [invocationId] = scheduler.processDue(at);
  if (invocationId === undefined) {
    throw new Error('Expected one due invocation');
  }
  return invocationId;
}

export function futureIso(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

export function ensureConversation(store: SqliteStore): bigint {
  const existing = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations LIMIT 1').get();
  if (existing !== undefined) {
    return existing.id;
  }
  const chat = store.db
    .prepare<[string], { id: bigint }>(
      "INSERT INTO chats(telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (123456789, 123456789, 'private', 'Owner', ?) RETURNING id",
    )
    .get(new Date().toISOString());
  const conversation = store.db
    .prepare<[bigint, string, string], { id: bigint }>(
      'INSERT INTO conversations(chat_id, message_thread_id, created_at, updated_at) VALUES (?, 0, ?, ?) RETURNING id',
    )
    .get(chat?.id ?? 0n, new Date().toISOString(), new Date().toISOString());
  return conversation?.id ?? 0n;
}

export function insertAlarm(
  store: SqliteStore,
  conversationId: bigint,
  scheduledAt: string,
  options: {
    targetUserId?: bigint;
    displayName?: string;
    summary?: string;
    state?: string;
    invocationId?: bigint;
  } = {},
): bigint {
  const targetUserId = options.targetUserId ?? 42n;
  const displayName = options.displayName ?? 'Alice';
  const payload = {
    target_user_id: targetUserId.toString(),
    target_display_name: displayName,
    summary: options.summary ?? 'test alarm',
  };
  const createdAt = new Date(Date.parse(scheduledAt) - 60_000).toISOString();
  const taskId = new LongTaskService(store.orm).scoped('alarm', conversationId).create(
    {
      payload,
      scheduledAt,
      timerResult: payload,
      delivery: { bypassDailyBudget: true, mentionUser: { userId: targetUserId, displayName } },
    },
    new Date(createdAt),
  ).taskId;
  const state = options.state ?? 'pending';
  if (state !== 'pending') {
    new LongTaskService(store.orm).processDue(new Date(scheduledAt));
    if (state === 'firing' || state === 'fired') {
      store.db
        .prepare(
          `UPDATE task_receipts SET state = ?, invocation_id = ?, claimed_at = ?, handled_at = ?, updated_at = ? WHERE task_id = ?`,
        )
        .run(
          state === 'firing' ? 'claimed' : 'handled',
          options.invocationId ?? null,
          scheduledAt,
          state === 'fired' ? scheduledAt : null,
          scheduledAt,
          taskId,
        );
    } else if (state === 'cancelled') {
      store.db
        .prepare(`UPDATE long_tasks SET state = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?`)
        .run(scheduledAt, scheduledAt, taskId);
      store.db
        .prepare(
          `UPDATE task_receipts SET status = 'cancelled', result_json = NULL, state = 'suppressed', cancelled_at = ?, updated_at = ? WHERE task_id = ?`,
        )
        .run(scheduledAt, scheduledAt, taskId);
    }
  }
  return taskId;
}
