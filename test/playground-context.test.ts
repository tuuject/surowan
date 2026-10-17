import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/adapters/local-monolith/config.ts';
import { SqliteStore } from '../src/adapters/local-monolith/database.ts';
import { InjectionTooLargeError } from '../src/context/context-builder.ts';
import { ContextBuilder } from '../src/context/context-builder.ts';
import { ContextRefStore } from '../src/context/context-refs.ts';
import { invocationCapabilities, renderInvocationContext, writeTestConfig } from './helpers.ts';
import { seedPlaygroundRoom } from './fixtures/playground-room.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function fixture(): Promise<{ store: SqliteStore; loaded: Awaited<ReturnType<typeof loadConfig>> }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-playground-context-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  return { store, loaded };
}

describe('playground context projection', () => {
  test('a room invocation resolves an internal identity and policy without a chat entry', async () => {
    const { store, loaded } = await fixture();
    const room = seedPlaygroundRoom(store);
    const builder = new ContextBuilder(store, new ContextRefStore(store, { ttlHours: () => 24 }), []);

    const identity = builder.identity(loaded.config, room.invocationId);

    expect(identity.hostKind).toBe('playground');
    expect(identity.chatId).toBe(room.chatId);
    expect(identity.conversationId).toBe(room.conversationId);
    expect(identity.policy.gateKey).toBe(`playground:${room.chatId}`);
    // A room has no telegram.chats entry; it still needs agent settings.
    expect(identity.policy.agent.model).toBe(loaded.config.agent.model);
    expect(identity.policy.bucketWindowSeconds).toBe(0);
  });

  test('the room prompt uses room wording', async () => {
    const { store, loaded } = await fixture();
    const room = seedPlaygroundRoom(store);
    const context = renderInvocationContext(store, loaded.config, room.invocationId, {
      supportsImages: false,
    });

    expect(context.systemPrompt).toContain('Images posted in the room');
    expect(context.systemPrompt).not.toContain('Telegram images and Stickers');
  });

  test('room messages render room tokens and never a Telegram uid', async () => {
    const { store, loaded } = await fixture();
    const room = seedPlaygroundRoom(store);
    const context = renderInvocationContext(store, loaded.config, room.invocationId);

    expect(context.userPrompt).toContain('<untrusted_new_messages>');
    expect(context.userPrompt).toContain('member:member_1');
    expect(context.userPrompt).toContain('member:member_2');
    expect(context.userPrompt).not.toContain('uid:');
  });

  test('a room reply ref is opaque and authorizes the room conversation', async () => {
    const { store, loaded } = await fixture();
    const room = seedPlaygroundRoom(store);
    const context = renderInvocationContext(store, loaded.config, room.invocationId);
    const resolver = invocationCapabilities(store, loaded.config, context.header);

    expect([...context.replyTargets.keys()].sort()).toEqual(['11', '12']);
    expect(resolver.resolveReplyTarget('11')).toEqual({
      conversationId: room.conversationId,
      threadId: 0n,
    });
    // A non-registered token is refused without parsing it as a platform id.
    expect(resolver.resolveReplyTarget('not-a-message')).toBeUndefined();
  });

  test('a room batch that does not fit is refused before refs are registered', async () => {
    const { store, loaded } = await fixture();
    const room = seedPlaygroundRoom(store, {
      messages: [
        { seq: 21, text: 'x'.repeat(2_000), sender: 0 },
        { seq: 22, text: 'y'.repeat(2_000), sender: 1 },
      ],
    });

    expect(() =>
      renderInvocationContext(store, loaded.config, room.invocationId, {
        contextWindow: 2_048,
        maxOutputTokens: 1_024,
      }),
    ).toThrow(InjectionTooLargeError);

    // The refusal left no reply ref and no injected marker behind.
    const contextRow = store.db
      .prepare<[bigint], { id: bigint }>('SELECT id FROM conversation_contexts WHERE conversation_id = ?')
      .get(room.conversationId);
    expect(contextRow).toBeDefined();
    const contextId = contextRow?.id ?? 0n;
    const appended = store.db
      .prepare<[bigint], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages WHERE context_id = ?')
      .get(contextId);
    expect(Number(appended?.count ?? 0)).toBe(0);
    const refs = store.db
      .prepare<[bigint], { count: bigint }>(
        "SELECT COUNT(*) AS count FROM context_refs WHERE context_id = ? AND kind = 'reply'",
      )
      .get(contextId);
    expect(Number(refs?.count ?? 0)).toBe(0);
  });
});
