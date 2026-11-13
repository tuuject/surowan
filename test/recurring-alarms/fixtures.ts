import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { CronerScheduleEngine } from '../../src/adapters/local-monolith/recurring-schedule.ts';
import type { HostKind } from '../../src/platform/im-host/identity.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { RecurringAlarmService } from '../../src/store/recurring-alarms/index.ts';
import type { RecurringAlarmDraft } from '../../src/store/recurring-alarms/records.ts';
import { type FixtureConfig, testConfigJsonc, writeTestConfig } from '../helpers.ts';

export const CHAT_ID = 123456789;

const directories: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A minute-aligned instant derived from the real clock, so no fixture time can expire. */
export function minuteNow(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

export function plus(date: Date | string, milliseconds: number): Date {
  return new Date(new Date(date).getTime() + milliseconds);
}

export function draft(overrides: Partial<RecurringAlarmDraft> = {}): RecurringAlarmDraft {
  return {
    title: 'Morning greeting',
    prompt: 'Say good morning to everyone.',
    rules: ['*/5 * * * *'],
    inputMode: 'cron',
    timeZone: 'UTC',
    enabled: true,
    ...overrides,
  };
}

export async function setup(
  options: {
    transform?: (config: FixtureConfig) => void;
    hosts?: HostKind[];
    isHostReady?: (host: HostKind) => boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-recurring-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, options.transform));
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  stores.push(store);
  const at = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO chats(id, telegram_chat_id, canonical_chat_id, type, title, updated_at) VALUES (1, ?, ?, 'private', 'Owner', ?)",
    )
    .run(CHAT_ID, CHAT_ID, at);
  store.db
    .prepare('INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (1, 1, 0, ?, ?)')
    .run(at, at);
  const tasks = new LongTaskService(store.orm, undefined, options.hosts);
  const recurring = new RecurringAlarmService({
    store,
    engine: new CronerScheduleEngine(),
    tasks,
    config: () => loaded.config,
    ...(options.isHostReady === undefined ? {} : { isHostReady: options.isHostReady }),
  });
  tasks.addTimerSource(recurring);
  return { directory, store, config: loaded.config, tasks, recurring, playground: new PlaygroundStore(store.orm) };
}

export function firings(store: SqliteStore, alarmId: bigint) {
  return store.db
    .prepare<
      [bigint],
      {
        source: string;
        occurrence_at: string;
        outcome: string;
        skip_reason: string | null;
        coalesced: bigint;
        task_id: bigint | null;
        triggered_by: string | null;
      }
    >(
      `SELECT source, occurrence_at, outcome, skip_reason, coalesced, task_id, triggered_by
       FROM recurring_alarm_firings WHERE recurring_alarm_id = ? ORDER BY id`,
    )
    .all(alarmId);
}

export function taskRows(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        id: bigint;
        plugin_id: string;
        state: string;
        scheduled_at: string | null;
        payload_json: string;
        delivery_json: string;
        receipt_state: string | null;
        cancel_reason: string | null;
      }
    >(
      `SELECT t.id, t.plugin_id, t.state, t.scheduled_at, t.payload_json, t.delivery_json,
              r.state AS receipt_state, r.cancel_reason
       FROM long_tasks t LEFT JOIN task_receipts r ON r.task_id = t.id ORDER BY t.id`,
    )
    .all();
}
