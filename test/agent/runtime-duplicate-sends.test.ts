import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, expect, test } from 'vitest';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';

import {
  type FixtureConfig,
  fauxRegistry,
  testConfigJsonc,
  testConfigStore,
  testTelegramRuntime,
  writeTestConfig,
} from '../helpers.ts';
import { cleanupAgentRuntimeDirectories, directories } from './runtime-fixtures.ts';

afterAll(cleanupAgentRuntimeDirectories);

test('a placeholder-filled send goes out, and a send repeated unchanged after failing stops the run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-agent-repeated-failure-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  // Some models fill every optional field with placeholders. Fields of another
  // kind are ignored, an inert resend:false included; resend:true on text is
  // still rejected, and retrying it unchanged ends the run on the third turn
  // instead of exhausting turns_per_injection.
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('send', {
          kind: 'text',
          resend: false,
          text: 'hi',
          sticker_ref: 'unused',
          image_generation_id: '00000000-0000-0000-0000-000000000000',
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    ...Array.from({ length: 5 }, () =>
      fauxAssistantMessage([fauxToolCall('send', { kind: 'text', text: 'again', resend: true })], {
        stopReason: 'toolUse',
      }),
    ),
    fauxAssistantMessage(''),
  ]);
  const sentTexts: string[] = [];
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
        return { message_id: 1, date: 1, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
  });
  const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
  expect(outcome).toEqual({ state: 'completed', reason: 'repeated_tool_failure' });
  expect(sentTexts).toEqual(['hi']);
  expect(
    store.db
      .prepare<[bigint], { state: string; error_code: string | null }>(
        'SELECT state, error_code FROM tool_calls WHERE invocation_id = ? ORDER BY id',
      )
      .all(invocationId),
  ).toEqual([
    { state: 'success', error_code: null },
    ...Array.from({ length: 3 }, () => ({ state: 'error', error_code: 'send_input_invalid' })),
  ]);
  expect(
    store.db
      .prepare<[bigint], { turns_used: bigint }>('SELECT turns_used FROM invocations WHERE id = ?')
      .get(invocationId)?.turns_used,
  ).toBe(4n);
  const toolResults = store.db
    .prepare<[bigint], { text: string }>(
      "SELECT text FROM agent_messages WHERE invocation_id = ? AND role = 'tool_result' ORDER BY sequence_no",
    )
    .all(invocationId);
  expect(toolResults.at(-1)?.text).toBe(
    'send input does not match its kind: resend applies only to kind:image; omit it for kind:text',
  );
  store.close();
});

async function duplicateSendRun(
  name: string,
  responses: readonly string[],
  transform?: (config: FixtureConfig) => void,
): Promise<{
  readonly outcome: unknown;
  readonly sentTexts: readonly string[];
  readonly errorCodes: readonly (string | null)[];
  readonly lastToolResult: string | undefined;
}> {
  const directory = await mkdtemp(join(tmpdir(), `surowan-agent-${name}-`));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const received = new Date('2026-08-15T00:00:00.000Z');
  ingestion.ingest(
    {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'look at the sunrise',
      },
    },
    received,
  );
  const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
  const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
  if (invocationId === undefined) {
    throw new Error('Expected a due invocation');
  }
  faux.setResponses([
    ...responses.map((text) => fauxAssistantMessage([fauxToolCall('send', { text })], { stopReason: 'toolUse' })),
    fauxAssistantMessage(''),
  ]);
  const sentTexts: string[] = [];
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    ...testTelegramRuntime({
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
        return { message_id: sentTexts.length, date: 1, chat: { id: 123456789 } };
      },
      sendSticker: async () => ({ message_id: 1, date: 1, chat: { id: 123456789 } }),
    }),
    bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
    systemResources: emptySystemResources(),
  });
  try {
    const outcome = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    const errorCodes = store.db
      .prepare<[bigint], { error_code: string | null }>(
        'SELECT error_code FROM tool_calls WHERE invocation_id = ? ORDER BY id',
      )
      .all(invocationId)
      .map((row) => row.error_code);
    const lastToolResult = store.db
      .prepare<[bigint], { text: string }>(
        "SELECT text FROM agent_messages WHERE invocation_id = ? AND role = 'tool_result' ORDER BY sequence_no DESC",
      )
      .get(invocationId)?.text;
    return { outcome, sentTexts, errorCodes, lastToolResult };
  } finally {
    store.close();
  }
}

test('a model repeating a sent message publishes it once and the run stops', async () => {
  // The shape of a real loop: the same send, accepted every time, until turns_per_injection.
  const run = await duplicateSendRun(
    'duplicate-loop',
    Array.from({ length: 10 }, () => 'sunrise'),
  );
  expect(run.sentTexts).toEqual(['sunrise']);
  // Three identical rejections in a row trip the repeated failure breaker first.
  expect(run.outcome).toEqual({ state: 'completed', reason: 'repeated_tool_failure' });
  expect(run.errorCodes).toEqual([null, 'send_duplicate', 'send_duplicate', 'send_duplicate']);
  expect(run.lastToolResult).toContain('Not sent: send_duplicate');
});

test('more than three duplicate rejections stop the run even when they alternate', async () => {
  const run = await duplicateSendRun('duplicate-alternate', ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
  expect(run.outcome).toEqual({ state: 'completed', reason: 'duplicate_send' });
  expect(run.sentTexts).toEqual(['a', 'b']);
  expect(run.errorCodes).toEqual([null, null, ...Array.from({ length: 4 }, () => 'send_duplicate')]);
});

test('with the duplicate send guard off, a repeated message is sent again', async () => {
  const run = await duplicateSendRun('duplicate-off', ['same', 'same'], (config) => {
    config.agent!.send_duplicate_guard_enabled = false;
  });
  expect(run.outcome).toEqual({ state: 'completed', reason: 'completed' });
  expect(run.sentTexts).toEqual(['same', 'same']);
  expect(run.errorCodes).toEqual([null, null]);
});
