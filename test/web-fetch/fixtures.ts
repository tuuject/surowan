import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import type { RawConfig } from '../../src/platform/config/index.ts';
import type { InvocationContext } from '../../src/platform/invocation-context.ts';
import {
  type FixtureConfig,
  renderInvocationContext,
  testConfigJsonc,
  testConfigStore,
  writeTestConfig,
} from '../helpers.ts';

/**
 * One store with one due Telegram invocation, for tools that audit against
 * a real invocation id. Each test file registers the cleanup in `afterAll`.
 */
const directories: string[] = [];

export async function cleanupWebFetchDirectories(): Promise<void> {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
}

export interface Fixture {
  readonly store: SqliteStore;
  readonly config: RawConfig;
  readonly context: InvocationContext;
}

export async function fixture(transform?: (config: FixtureConfig) => void): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-web-fetch-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded);
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const scheduler = new BucketScheduler(store, configStore, async () => ({
    state: 'completed',
    reason: 'done',
  }));
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'fetch the page',
      },
    },
    received,
  );
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  const context = renderInvocationContext(store, loaded.config, invocationId, {
    contextWindow: 200_000,
    maxOutputTokens: 32768,
  });
  return { store, config: loaded.config, context };
}

export function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
