/**
 * A released room drives the real AgentRuntime against the Playground host.
 *
 * These tests run the whole invocation (context, provider, tool hooks, send)
 * so a check that only one branch of the runtime honours the host profile is
 * caught here rather than in a unit test of that branch.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { createPlaygroundHost } from '../src/adapters/local-monolith/playground-host.ts';
import { AdminQueryError, getInvocation, listInvocations } from '../src/ingress/admin/audit.ts';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { identityConversation } from '../src/platform/im-host.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { PlaygroundStore } from '../src/store/playground.ts';
import { contextMessages, hostSends, toolCalls } from '../src/store/schema.ts';
import { activeSleepUntil, enterSleep } from '../src/store/sleep.ts';
import { fauxRegistry, testConfigStore, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function released() {
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-runtime-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const configStore = await testConfigStore(loaded, fauxRegistry(faux));
  const store = await SqliteStore.open(loaded.config);
  const playground = new PlaygroundStore(store.orm);
  // Another room speaks first, so this room's message rows are not numbered
  // like its sequence: an id that leaks across the host seam names the wrong
  // message instead of passing by coincidence.
  const decoy = playground.createRoom({ title: 'Decoy Room', members: [{ name: 'Bob' }] });
  playground.submit(decoy.chatId, { requestKey: 'decoy-1', senderId: decoy.members[0]!.senderId, text: 'decoy' });
  const room = playground.createRoom({ title: 'Runtime Room', members: [{ name: 'Alice' }] });
  playground.submit(room.chatId, { requestKey: 'req-1', senderId: room.members[0]!.senderId, text: 'hello' });
  const release = playground.release(room.chatId, {
    releaseKey: 'rel-1',
    revision: playground.room(room.chatId).revision,
  });
  if (release.invocationId === null) {
    throw new Error('expected a queued invocation');
  }
  const runtime = new AgentRuntime({
    store,
    configStore,
    secrets: new SecretStore(),
    hosts: {
      playground: createPlaygroundHost({
        store,
        self: { displayName: 'Plastic Wan' },
        sendRate: () => ({ sendsPerWindow: 20, windowSeconds: 60 }),
      }),
    },
    conversation: (target) => identityConversation(target, 'playground', 'group'),
    bot: { id: 999n, displayName: 'Plastic Wan', username: null },
    systemResources: emptySystemResources(),
  });
  return { store, configStore, runtime, faux, playground, invocationId: release.invocationId, roomId: room.chatId };
}

describe('playground runtime', () => {
  test('a room keeps talking while the Telegram host sleeps', async () => {
    const { store, configStore, runtime, faux, invocationId } = await released();
    enterSleep(store.orm);
    const sleepUntil = activeSleepUntil(store.orm);
    expect(sleepUntil).not.toBeNull();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'awake in the room' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('   '),
    ]);

    const result = await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);

    expect(result.reason).not.toBe('sleep');
    const sends = store.orm.select({ state: hostSends.state }).from(hostSends).all();
    expect(sends).toEqual([{ state: 'success' }]);
    // The room neither read nor ended the global window.
    expect(activeSleepUntil(store.orm)).toBe(sleepUntil);
    store.close();
  });

  test('a room invocation is audited next to Telegram ones, under its own identity', async () => {
    const { store, configStore, runtime, faux, invocationId, roomId } = await released();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'hi from the room' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('   '),
    ]);
    await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);
    const id = invocationId.toString();
    const chat = {
      host_kind: 'playground',
      telegram_chat_id: null,
      room_id: roomId.toString(),
      type: 'group',
      title: 'Runtime Room',
      username: null,
      message_thread_id: 0,
    };

    const listed = listInvocations(store.orm, {});
    expect(listed.items.map((item) => [item.id, item.chat])).toEqual([[id, chat]]);
    expect(listInvocations(store.orm, { host: 'playground' }).items.map((item) => item.id)).toEqual([id]);
    expect(listInvocations(store.orm, { host: 'telegram' }).items).toEqual([]);
    expect(() => listInvocations(store.orm, { host: 'irc' })).toThrow(AdminQueryError);

    const detail = getInvocation(store.orm, invocationId);
    expect(detail?.chat).toEqual(chat);
    // The room's own sequence names the delivered message; there is no
    // Telegram message id to report.
    expect(detail?.telegram_sends).toEqual([
      expect.objectContaining({ state: 'success', telegram_message_id: null, room_seq: '2' }),
    ]);
    expect(detail?.context_messages).toEqual([expect.objectContaining({ section: 'new' })]);

    // Search reads room snapshots and room deliveries, with their times.
    const incoming = listInvocations(store.orm, { search: 'hello', from: '2000-01-01T00:00:00Z' }).items;
    expect(incoming.map((item) => item.matched_messages)).toEqual([
      [expect.objectContaining({ source: 'incoming', telegram_message_id: null, room_seq: '1', text: 'hello' })],
    ]);
    const outgoing = listInvocations(store.orm, { search: 'from the room', from: '2000-01-01T00:00:00Z' }).items;
    expect(outgoing.map((item) => item.matched_messages)).toEqual([
      [expect.objectContaining({ source: 'bot', telegram_message_id: null, room_seq: '2', text: 'hi from the room' })],
    ]);
    store.close();
  });

  test('a reply names the room sequence the model was shown, never a stored row id', async () => {
    const { store, configStore, runtime, faux, playground, invocationId, roomId } = await released();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'hi Alice', reply_to_message_id: '1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('   '),
    ]);

    await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal);

    expect(store.orm.select({ state: hostSends.state, errorCode: hostSends.errorCode }).from(hostSends).all()).toEqual([
      { state: 'success', errorCode: null },
    ]);
    // The reply lands in this room, under the next sequence, pointing at the
    // member message the model saw as `1`.
    const [reply] = playground.timeline(roomId, { limit: 10 }).items;
    expect(reply).toMatchObject({ seq: 2n, sentByBot: true, text: 'hi Alice', replyToSeq: 1n });
    // What the model is told about its own message is the same room sequence,
    // so it can name that message later the way the room shows it.
    expect(store.orm.select({ resultText: toolCalls.resultText }).from(toolCalls).all()).toEqual([
      { resultText: 'message_id=2' },
    ]);
    const told = store.orm
      .select({ payloadJson: contextMessages.payloadJson })
      .from(contextMessages)
      .where(eq(contextMessages.role, 'toolResult'))
      .all()
      .map((row) => JSON.parse(row.payloadJson) as unknown);
    expect(told).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: 'Sent message 2' }], details: { messageId: '2' } }),
    ]);
    store.close();
  });
});
