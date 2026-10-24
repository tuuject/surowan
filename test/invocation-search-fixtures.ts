import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { AdminQueryError, type ListQuery } from '../src/ingress/admin/audit.ts';
import type { RawConfig } from '../src/platform/config.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { seed } from './invocation-search-seed.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';
import { listInvocations } from '../src/ingress/admin/audit/invocations.ts';

/**
 * Shared fixture for the `invocation-search` suite: a temp SQLite store holding
 * the synthetic corpus from `invocation-search-seed.ts`, plus the query helpers
 * the split test files share.
 */

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
}

export interface MatchedMessage {
  readonly source: string;
  readonly telegram_message_id: string | null;
  readonly room_seq: string | null;
  readonly telegram_send_id: string | null;
  readonly at: string;
  readonly text: string | null;
}

export interface Item {
  readonly id: string;
  readonly matched_messages?: readonly MatchedMessage[];
}

let fixture: Fixture | undefined;
let directory: string;

export function useInvocationSearchFixture(): void {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'surowan-invocation-search-'));
    const configPath = join(directory, 'config.jsonc');
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory, (config) => {
        config.timezone = 'UTC';
        config.telegram.chats = [
          { id: -100111, timezone: 'Asia/Shanghai', instructions_file: 'chat-instructions.md' },
          { id: -100222, timezone: 'America/New_York', instructions_file: 'chat-instructions.md' },
        ];
      }),
    );
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    seed(store);
    fixture = { store, config };
  });

  afterEach(async () => {
    fixture?.store.close();
    await rm(directory, { recursive: true, force: true });
  });
}

export function current(): Fixture {
  if (fixture === undefined) {
    throw new Error('fixture was not initialized');
  }
  return fixture;
}

export function list(query: ListQuery): Item[] {
  return listInvocations(current().store.orm, query, current().config).items as unknown as Item[];
}

export function ids(query: ListQuery): string[] {
  return list(query).map((item) => item.id);
}

export function matched(item: Item): readonly MatchedMessage[] {
  expect(item.matched_messages).toBeDefined();
  return item.matched_messages ?? [];
}

export function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AdminQueryError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected an AdminQueryError');
}
