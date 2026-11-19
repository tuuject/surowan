/**
 * Strict `host_kind` parsing.
 *
 * `chats.host_kind` is a CHECK-constrained enumeration, but storage is a file
 * another build may have written first: a kind this build does not know must
 * be rejected where it is read, never coerced into a known host. The sites
 * below are every place a stored kind decides scheduling, delivery, model
 * accounting or media access — each one fails loudly on an unknown value for
 * a single operation, while batch paths answer "not served here" so one bad
 * row can never stall the rows that are this build's work.
 */

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';

import type { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { resolveConversation } from '../../src/adapters/local-monolith/runtime/support.ts';
import type { MediaImageInputDeps } from '../../src/capabilities/media/image-input.ts';
import { prepareRowImage } from '../../src/capabilities/media/image-input.ts';
import { readOriginalFile } from '../../src/capabilities/media/original-file.ts';
import { ContextBuilder } from '../../src/context/builder/index.ts';
import { ContextRefStore } from '../../src/context/refs.ts';
import { generationEligibilityForHosts } from '../../src/image/host-eligibility.ts';
import { InvocationQueueService } from '../../src/orchestration/invocation-queue/index.ts';
import { invocationsLeavingModel, withAgentModel } from '../../src/orchestration/model-switch.ts';
import { identityConversation, parseHostKind } from '../../src/platform/im-host/identity.ts';
import { previewContext } from '../../src/platform/invocation-context.ts';
import { deliveryBlockReason } from '../../src/store/delivery-target.ts';
import { LongTaskService } from '../../src/store/long-tasks/index.ts';
import { fauxRegistry, testConfigStore } from '../helpers.ts';
import {
  corruptHostKind,
  openTestStore,
  seedInvocation,
  seedMedia,
  seedPlaygroundConversation,
  seedTelegramConversation,
} from './fixtures.ts';

test('parseHostKind accepts known kinds and rejects everything else by name', () => {
  expect(parseHostKind('telegram')).toBe('telegram');
  expect(parseHostKind('playground')).toBe('playground');
  for (const value of ['discord', '', 'Telegram', null, undefined, 7]) {
    expect(() => parseHostKind(value)).toThrow(/host kind/i);
  }
});

test('a Telegram target without a native id never yields a ref on the internal id', async () => {
  const { store } = await openTestStore();
  const seed = seedTelegramConversation(store, { chatId: 7n, telegramChatId: 424242n });
  // Stored-row path: the ref carries the native id.
  const resolved = resolveConversation(store, {
    hostKind: 'telegram',
    hostChatId: 424242n,
    internalChatId: seed.chatId,
    threadId: 0n,
    conversationId: seed.conversationId,
  });
  expect(resolved.chatId).toBe('424242');
  // Synthetic path (no stored row, no native id): the ref is the explicit
  // non-delivery '0', never the internal row id on the wire.
  const synthetic = resolveConversation(store, {
    hostKind: 'telegram',
    hostChatId: null,
    internalChatId: 7n,
    threadId: 0n,
    conversationId: 0n,
  });
  expect(synthetic.chatId).toBe('0');
  expect(synthetic.chatId).not.toBe('7');
  // A stored Telegram row missing its native id is a data bug: loud, not internal.
  store.db
    .prepare(
      "INSERT INTO chats(id, host_kind, host_chat_id, canonical_chat_id, type, updated_at) VALUES (8, 'telegram', NULL, NULL, 'group', '2025-01-01T00:00:00.000Z')",
    )
    .run();
  store.db
    .prepare(
      'INSERT INTO conversations(id, chat_id, message_thread_id, created_at, updated_at) VALUES (55, 8, 0, ?, ?)',
    )
    .run('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  expect(() =>
    resolveConversation(store, {
      hostKind: 'telegram',
      hostChatId: null,
      internalChatId: 8n,
      threadId: 0n,
      conversationId: 55n,
    }),
  ).toThrow(/no host chat id/);
});

test('identityConversation refuses to put an internal id on a config-host wire', () => {
  expect(() =>
    identityConversation(
      { hostChatId: null, internalChatId: 7n, threadId: 0n, conversationId: 1n },
      'telegram',
      'group',
    ),
  ).toThrow(/no host chat id/);
  // A room host is addressed internally: the internal id IS the wire id.
  const room = identityConversation(
    { hostChatId: null, internalChatId: 7n, threadId: 0n, conversationId: 1n },
    'playground',
    'group',
  );
  expect(room.chatId).toBe('7');
});

test('stored-conversation resolution rejects an unknown host_kind', async () => {
  const { store } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store);
  corruptHostKind(store, chatId);
  // Before the fix this resolved the conversation as Telegram and delivered.
  expect(() =>
    resolveConversation(store, {
      hostKind: 'telegram',
      hostChatId: 123456789n,
      internalChatId: 123456789n,
      threadId: 0n,
      conversationId,
    }),
  ).toThrow(/host kind/i);
});

test('a task scope is never built for an unknown or missing conversation host', async () => {
  const { store } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store);
  corruptHostKind(store, chatId);
  const tasks = new LongTaskService(store.orm);
  const context = { ...previewContext('telegram'), conversationId };
  // 'discord' used to read as 'telegram' here, so the plugin check passed.
  expect(() => tasks.invocationScope('alarm', context, ['telegram', 'playground'])).toThrow(/host kind/i);
  // A missing conversation row must not default to a host either.
  expect(() =>
    tasks.invocationScope('alarm', { ...context, conversationId: 9999n }, ['telegram', 'playground']),
  ).toThrow();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM long_tasks').get() as { n: bigint }).toEqual({ n: 0n });
});

test('a conversation id reused by another host is re-read, not trusted from a stale cache', async () => {
  const { store } = await openTestStore();
  const seeded = seedTelegramConversation(store);
  const tasks = new LongTaskService(store.orm);
  const context = { ...previewContext('telegram'), conversationId: seeded.conversationId };
  // Populates the conversation→host cache inside the service.
  tasks.invocationScope('alarm', context, ['telegram']);
  // An Admin deletion frees the id; the next conversation to take it may live
  // on a different host.
  store.db.prepare('DELETE FROM conversations WHERE id = ?').run(seeded.conversationId);
  store.db.prepare('DELETE FROM chats WHERE id = ?').run(seeded.chatId);
  seedPlaygroundConversation(store, { chatId: seeded.chatId, conversationId: seeded.conversationId });
  // The stale cache answered 'telegram' here and let a Telegram-only plugin in.
  expect(() => tasks.invocationScope('alarm', context, ['telegram'])).toThrow(/playground/);
});

test('an unknown host kind is ineligible work for the image worker but never blocks valid rows', async () => {
  const { store } = await openTestStore();
  const valid = seedTelegramConversation(store);
  const corrupt = seedTelegramConversation(store, { chatId: 2n, conversationId: 300n, telegramChatId: 987654321n });
  corruptHostKind(store, corrupt.chatId);
  const eligible = generationEligibilityForHosts(store, ['telegram', 'playground'], () => true);
  // The worker asks this per generation while loading its queue and while
  // reconciling; one unknown row used to throw through the whole batch.
  expect(eligible({ id: 'gen-bad', actorId: `agent:${corrupt.conversationId.toString()}` })).toBe(false);
  expect(eligible({ id: 'gen-ok', actorId: `agent:${valid.conversationId.toString()}` })).toBe(true);
});

test('model-switch accounting skips an unknown host_kind instead of aborting the pass', async () => {
  const { store, config } = await openTestStore();
  const valid = seedTelegramConversation(store);
  const corrupt = seedTelegramConversation(store, { chatId: 2n, conversationId: 300n, telegramChatId: 987654321n });
  corruptHostKind(store, corrupt.chatId);
  seedInvocation(store, 5n, valid.conversationId);
  seedInvocation(store, 6n, corrupt.conversationId);
  const after = withAgentModel(config, 'agent', 'other-model');
  // The pass runs over every running invocation; the unknown-host row must
  // affect only itself while the valid run is still counted.
  expect(invocationsLeavingModel(store.orm, config, after, undefined)).toEqual([5n]);
});

test('the context builder refuses an invocation on an unknown host_kind', async () => {
  const { store, config } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store);
  corruptHostKind(store, chatId);
  seedInvocation(store, 5n, conversationId);
  const builder = new ContextBuilder(store, new ContextRefStore(store, { ttlHours: () => 72 }));
  // The declared row type made 'discord' a HostKind without a runtime check.
  expect(() => builder.identity(config, 5n)).toThrow(/host kind/i);
});

test('a delivery target with an unknown host_kind is rejected, not delivered as Telegram', async () => {
  const { store, config } = await openTestStore();
  // The row would look deliverable today: configured chat, live agent.
  expect(() =>
    deliveryBlockReason(store.orm, config, {
      conversationId: 1n,
      chatId: 1n,
      hostKind: 'discord',
      hostChatId: 123456789n,
      messageThreadId: 0n,
    }),
  ).toThrow(/host kind/i);
});

function mediaDeps(store: SqliteStore): MediaImageInputDeps {
  return {
    store,
    configStore: undefined,
    mediaClient: undefined,
    localAssets: undefined,
  } as unknown as MediaImageInputDeps;
}

test('media reads reject an unknown host_kind instead of downloading as Telegram', async () => {
  const { store } = await openTestStore();
  const { chatId, conversationId } = seedTelegramConversation(store);
  const mediaId = seedMedia(store, { mediaId: 9n, conversationId, chatId, hostKind: 'discord' });
  // Used to fall into the Telegram downloader for any non-'playground' kind.
  await expect(readOriginalFile(mediaDeps(store), mediaId, new AbortController().signal)).rejects.toThrow(/host kind/i);
  await expect(
    prepareRowImage(
      mediaDeps(store),
      {
        id: mediaId,
        kind: 'photo',
        fileId: 'file-1',
        fileUniqueId: 'unique-1',
        mimeType: null,
        fileSize: null,
        telegramJson: '{}',
        hostKind: 'discord',
        localAssetId: null,
      },
      'input',
      'workdir',
      new AbortController().signal,
    ),
  ).rejects.toThrow(/host kind/i);
});

test('an unknown-host receipt stays pending while a valid one is claimed in the same pass', async () => {
  const { store, loaded } = await openTestStore();
  const valid = seedTelegramConversation(store);
  const corrupt = seedTelegramConversation(store, { chatId: 2n, conversationId: 300n, telegramChatId: 987654321n });
  corruptHostKind(store, corrupt.chatId);
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const tasks = new LongTaskService(store.orm);
  const queue = new InvocationQueueService(store, configStore, undefined, tasks);
  const validTask = tasks.scoped('test-plugin', valid.conversationId).create({ payload: { ok: true } });
  const corruptTask = tasks.scoped('test-plugin', corrupt.conversationId).create({ payload: { ok: false } });
  tasks.scoped('test-plugin', valid.conversationId).complete(validTask.taskId, { done: true });
  tasks.scoped('test-plugin', corrupt.conversationId).complete(corruptTask.taskId, { done: false });
  // The receipts query used to select every pending receipt whenever all known
  // hosts were served, so this one bad row threw inside the shared transaction
  // and rolled the valid claim back on every tick, forever.
  const claimed = queue.processTasksDue(new Date('2026-08-15T00:00:00.000Z'));
  expect(claimed).toHaveLength(1);
  const stateOf = (taskId: bigint) =>
    store.db.prepare('SELECT state, cancel_reason FROM task_receipts WHERE task_id = ?').get(taskId) as {
      state: string;
      cancel_reason: string | null;
    };
  expect(stateOf(validTask.taskId)).toEqual({ state: 'claimed', cancel_reason: null });
  expect(stateOf(corruptTask.taskId)).toEqual({ state: 'pending', cancel_reason: null });
});
