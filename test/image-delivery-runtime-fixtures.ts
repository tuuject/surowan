import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import Type from 'typebox';
import { afterEach, expect } from 'vitest';
import { ConversationContextStore } from '../src/context/context-store.ts';
import { TelegramIngestion } from '../src/ingress/telegram-ingestion.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';
import { BucketScheduler } from '../src/orchestration/scheduler.ts';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import type { TelegramTransport } from '../src/adapters/local-monolith/telegram-host.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { LongTaskService } from '../src/store/long-tasks.ts';
import { fauxRegistry, testConfigJsonc, testConfigStore, testTelegramRuntime, writeTestConfig } from './helpers.ts';
import type { ToolFactory } from '../src/orchestration/agent-runtime-types.ts';

/**
 * Shared fixture for the image delivery runtime regression (audit 3486).
 *
 * Real store, AgentRuntime, ConversationRuntime, BucketScheduler and
 * LongTaskService; a Faux agent, mock picture bytes, and no network, real
 * config/key.json, `serve` or configuration reload.
 */

export const GENERATION_ID = '7b2f8f3a-9c4d-4e5f-8a6b-1c2d3e4f5a6b';
export const ASSET_ID = 'asset-3486';
export const UNSENT_ASSET_ID = 'asset-3486-unsent';
export const RECEIPT_MARKER = '<untrusted_task_receipt>';
export const FIRST_PHOTO_MESSAGE_ID = 900;
export const RESENT_PHOTO_MESSAGE_ID = 901;
// Tolerant to wording ("already been delivered", "already_delivered", ...).
export const ALREADY_DELIVERED = /already[\s_-]*(been[\s_-]*)?delivered/i;

const cleanups: (() => Promise<void>)[] = [];

/** Registers the teardown every image delivery file needs. */
export function installImageDeliveryHooks(): void {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });
}

export async function fixture(options: { readonly unsentOutputs?: readonly string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-image-delivery-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(
    directory,
    configPath,
    testConfigJsonc(directory, (config) => {
      config.telegram.bucket_window_seconds = 0;
      config.agent!.send_nudge_enabled = false;
      config.agent!.send_barrier_enabled = false;
      config.agent!.context!.idle_grace_seconds = 0;
      config.agent!.context!.retained_sends_target = 20;
      config.agent!.context!.retained_sends_max = 30;
    }),
  );
  const loaded = await loadConfig(configPath);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  cleanups.push(async () => {
    store.close();
  });
  const ingestion = new TelegramIngestion(store, configStore, { id: 999 });
  const tasks = new LongTaskService(store.orm);
  const conversationRuntime = new ConversationRuntime({ agentCacheSize: () => 8 });
  const photoMessageIds: number[] = [];
  let nextMessageId = FIRST_PHOTO_MESSAGE_ID;
  let photoFailures = 0;
  const telegramApi: TelegramTransport = {
    sendMessage: async () => ({ message_id: nextMessageId++, date: 1_700_000_000, chat: { id: 123456789 } }),
    sendSticker: async () => ({ message_id: nextMessageId++, date: 1_700_000_000, chat: { id: 123456789 } }),
    sendGeneratedPhoto: async () => {
      if (photoFailures > 0) {
        photoFailures -= 1;
        throw new HttpError('network failed', new Error('socket closed'));
      }
      const messageId = nextMessageId++;
      photoMessageIds.push(messageId);
      return {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 123456789 },
        photo: [{ file_id: `photo-${messageId}`, file_unique_id: `unique-${messageId}`, width: 512, height: 512 }],
      };
    },
    sendGeneratedPhotoGroup: async () => [],
  };
  // Mock worker: fixed bytes, only for the generation of the asking conversation.
  let activeConversationId: bigint | null = null;
  const imageGeneration = {
    resolve: (generationId: string, conversationId: bigint) =>
      generationId === GENERATION_ID && conversationId === activeConversationId
        ? [{ assetId: ASSET_ID, bytes: new Uint8Array([137, 80, 78, 71]), fileName: 'harbor.png', mime: 'image/png' }]
        : undefined,
  };
  const requests: string[] = [];
  const snapshots: Record<string, unknown> = {};
  let schedulerRef: BucketScheduler | null = null;
  // Stand-in for the image capability: submits the long task and lets the
  // generation settle while the tool chain is still open, exactly like a fast
  // provider finishing before the round reaches a no-tool turn.
  const additionalTools: ToolFactory = (context) => {
    activeConversationId = context.conversationId;
    return [
      {
        name: 'image_generate',
        label: 'Generate image',
        description: 'Submit an image generation request. Stand-in for the image capability in this regression.',
        parameters: Type.Object(
          { prompt: Type.String({ minLength: 1, maxLength: 8000 }) },
          { additionalProperties: false },
        ),
        executionMode: 'sequential',
        execute: async () => {
          const scope = tasks.scoped('image', context.conversationId);
          const task = scope.create({
            payload: {
              generation_id: GENERATION_ID,
              model_id: 'mock-image-model',
              prompt_preview: 'a quiet harbor at dusk',
              output_count: 1,
            },
          });
          scope.complete(task.taskId, {
            generation_id: GENERATION_ID,
            status: 'succeeded',
            model_id: 'mock-image-model',
            prompt_preview: 'a quiet harbor at dusk',
            outputs: [
              { asset_id: ASSET_ID, file_name: 'harbor.png', mime: 'image/png' },
              ...(options.unsentOutputs ?? []).map((assetId) => ({
                asset_id: assetId,
                file_name: `${assetId}.png`,
                mime: 'image/png',
              })),
            ],
            error: null,
          });
          if (schedulerRef === null) {
            throw new Error('scheduler is not wired');
          }
          schedulerRef.processTasksDue();
          snapshots.receiptStateWhileToolChainOpen = queryReceipts(store)[0]?.state;
          return {
            content: [
              {
                type: 'text',
                text: `Generation ${GENERATION_ID} submitted on model mock-image-model (1 output(s)). The result arrives as a completion receipt; do not claim the image exists before then.`,
              },
            ],
            details: { generation_id: GENERATION_ID, model_id: 'mock-image-model', output_count: 1, replayed: false },
          };
        },
      },
    ];
  };
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    conversationRuntime,
    bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
    systemResources: emptySystemResources(),
    ...testTelegramRuntime(telegramApi),
    additionalTools,
    imageGeneration,
  });
  const scheduler = new BucketScheduler(
    store,
    configStore,
    (id, snapshot, signal) => runtime.run(id, snapshot, signal),
    conversationRuntime,
    tasks,
  );
  schedulerRef = scheduler;
  cleanups.push(async () => {
    await scheduler.stop(0);
  });
  return {
    store,
    faux,
    scheduler,
    ingestion,
    tasks,
    requests,
    snapshots,
    photoMessageIds,
    failNextPhoto: (): void => {
      photoFailures += 1;
    },
  };
}

export function update(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

export function queryReceipts(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        task_id: bigint;
        bucket_id: bigint;
        invocation_id: bigint;
        state: string;
        invocation_outcome: string | null;
        completion_reason: string | null;
      }
    >(
      'SELECT task_id, bucket_id, invocation_id, state, invocation_outcome, completion_reason FROM task_receipts ORDER BY task_id',
    )
    .all();
}

export function queryInvocations(store: SqliteStore) {
  return store.db
    .prepare<[], { id: bigint; state: string; sends_used: bigint }>(
      'SELECT id, state, sends_used FROM invocations ORDER BY id',
    )
    .all();
}

export function querySendToolCalls(store: SqliteStore) {
  return store.db
    .prepare<
      [],
      {
        tool_call_id: string;
        invocation_id: bigint;
        state: string;
        side_effect: bigint;
        result_text: string | null;
        error_code: string | null;
      }
    >(
      "SELECT tool_call_id, invocation_id, state, side_effect, result_text, error_code FROM tool_calls WHERE tool_name = 'send' ORDER BY id",
    )
    .all();
}

export function queryImageSends(store: SqliteStore) {
  return store.db
    .prepare<[], { id: bigint; state: string; request_json: string; telegram_message_id: bigint | null }>(
      "SELECT id, state, request_json, telegram_message_id FROM host_sends WHERE kind = 'image' ORDER BY id",
    )
    .all();
}

export function retainedContext(store: SqliteStore, conversationId: bigint) {
  const contexts = new ConversationContextStore(store);
  const header = contexts.header(conversationId);
  if (header === undefined) {
    throw new Error('Conversation context is missing');
  }
  return { header, messages: contexts.retained(header) };
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

export function detailsOf(message: { readonly details?: unknown }): Record<string, unknown> {
  return (message.details ?? {}) as Record<string, unknown>;
}

export function imageDeliveryOf(text: string): Record<string, unknown> | undefined {
  const json = text.split('<untrusted_task_receipt>\n')[1]?.split('\n</untrusted_task_receipt>')[0];
  if (json === undefined) {
    throw new Error('Completion receipt JSON is missing');
  }
  return (JSON.parse(json) as { image_delivery?: Record<string, unknown> }).image_delivery;
}

export function sendImage(toolCallId: string, input: Record<string, unknown> = {}) {
  return fauxAssistantMessage(
    fauxToolCall(
      'send',
      { kind: 'image', image_generation_id: GENERATION_ID, text: 'harbor is ready', ...input },
      { id: toolCallId },
    ),
    { stopReason: 'toolUse' },
  );
}

export async function finished(f: Awaited<ReturnType<typeof fixture>>, count: bigint) {
  await expect
    .poll(
      () =>
        f.store.db
          .prepare<[], { count: bigint }>(
            "SELECT COUNT(*) AS count FROM invocations WHERE state NOT IN ('running', 'queued')",
          )
          .get()?.count,
    )
    .toBe(count);
}
