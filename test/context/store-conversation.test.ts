import { afterAll, describe, expect, test } from 'vitest';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { ConversationContextStore, listConversationContexts } from '../../src/context/store.ts';
import { ContextRefStore } from '../../src/context/refs.ts';
import { assistantText, cleanupContextStoreDirectories, conversationId, fixture, mediaId } from './store-fixtures.ts';

afterAll(cleanupContextStoreDirectories);

describe('conversation context store', () => {
  test('appends history, marks checkpoints, and counts sends', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header, rebuilt } = contexts.open(conversation, 'hash-a');
    expect(rebuilt).toBe(false);
    expect(header.headSeq).toBe(1n);

    const userSeq = contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const assistantSeq = contexts.append(header, {
      invocationId: null,
      isCheckpoint: false,
      estTokens: 5,
      json: encodeContextMessage(assistantText('published'))?.json ?? '',
      role: 'assistant',
    });
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: false,
      estTokens: 5,
      countedSend: true,
      json: JSON.stringify({
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'send',
        content: [{ type: 'text', text: 'Sent Telegram message 1' }],
        isError: false,
        timestamp: 2,
      }),
      role: 'toolResult',
    });
    expect([userSeq, assistantSeq]).toEqual([1n, 2n]);
    expect(header.nextSeq).toBe(4n);
    expect(header.sendCountTotal).toBe(1n);

    const retained = contexts.retained(header);
    expect(retained).toHaveLength(3);
    expect(retained[0]?.message.role).toBe('user');
    const stats = contexts.stats(header);
    expect(stats.retainedSends).toBe(1);
    expect(stats.messageCount).toBe(3);
    const rows = contexts.window(header);
    expect(rows.map((row) => row.isCheckpoint)).toEqual([true, false, false]);
    expect(rows.map((row) => row.sendSeq)).toEqual([null, null, 1n]);
    store.close();
  });

  test('rebuilds the history when the stable system prompt changes', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const first = contexts.open(conversation, 'hash-a');
    contexts.append(first.header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const second = contexts.open(conversation, 'hash-b');
    expect(second.rebuilt).toBe(true);
    expect(second.header.headSeq).toBe(1n);
    expect(second.header.nextSeq).toBe(1n);
    expect(contexts.retained(second.header)).toEqual([]);
    expect(second.header.sendCountTotal).toBe(0n);
    store.close();
  });

  test('advanceHead soft-evicts rows and revokes their references', async () => {
    const { store, loaded } = await fixture();
    const contexts = new ConversationContextStore(store);
    const refs = new ContextRefStore(store, { ttlHours: () => loaded.config.agent!.context!.ref_ttl_hours });
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    for (let index = 0; index < 4; index += 1) {
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: index % 2 === 0,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: `message ${index}`, timestamp: index }),
        role: 'user',
      });
    }
    const ref = refs.mediaRef(header, mediaId(store, 0), 1n);
    expect(refs.resolve(header, ref, 'media')?.mediaId).toBe(mediaId(store, 0));

    contexts.advanceHead(header, 3n);
    expect(header.headSeq).toBe(3n);
    expect(contexts.window(header).map((row) => row.seq)).toEqual([3n, 4n]);
    // The ref was carried by an evicted row, so it must stop resolving.
    expect(refs.resolve(header, ref, 'media')).toBeUndefined();
    const evicted = store.db
      .prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages WHERE evicted_at IS NOT NULL')
      .get();
    expect(evicted?.count).toBe(2n);
    expect(() => contexts.advanceHead(header, 2n)).toThrow('Refusing to advance');
    store.close();
  });

  test('clears the whole retained history on demand', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    contexts.clear(header);
    expect(header.headSeq).toBe(header.nextSeq);
    expect(contexts.retained(header)).toEqual([]);
    store.close();
  });

  test('a stale handle cannot resurrect history another handle dropped', async () => {
    // Regression: the retained window was a pure `seq >= head_seq` range read. A
    // handle taken before a concurrent `/cut_topic` keeps the old, lower `headSeq`,
    // so it both read the cut history back and could write that lower head over the
    // cut — the model kept quoting a topic the admin had just cut.
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    for (let index = 0; index < 4; index += 1) {
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: `message ${index}`, timestamp: index }),
        role: 'user',
      });
    }
    // The handle a running invocation is holding, taken before the cut.
    const stale = { ...header };
    const cutting = contexts.header(conversation);
    if (cutting === undefined) {
      throw new Error('Expected a context header');
    }
    contexts.clear(cutting);

    expect(stale.headSeq).toBe(1n);
    expect(contexts.retained(stale)).toEqual([]);
    expect(contexts.window(stale)).toEqual([]);
    expect(contexts.stats(stale).messageCount).toBe(0);
    // A row appended after the cut is still retained by both handles: eviction, not
    // the sequence number, is what decides.
    contexts.append(stale, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'after the cut', timestamp: 9 }),
      role: 'user',
    });
    expect(contexts.retained(stale).map((row) => row.seq)).toEqual([5n]);
    store.close();
  });

  test('lists the retained contexts for the admin projections', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'hello', timestamp: 1 }),
      role: 'user',
    });
    const listed = listConversationContexts(store, { conversationId: conversation });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.conversationId).toBe(conversation);
    expect(listed[0]?.messageCount).toBe(1n);
    expect(listed[0]?.headSeq).toBe(1n);
    store.close();
  });
});
