import { afterAll, describe, expect, test } from 'vitest';
import { encodeContextMessage } from '../../src/context/codec.ts';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import { listConversationContexts } from '../../src/context/store/queries.ts';
import { StaleContextError } from '../../src/context/store/types.ts';
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

  test('memo write failure rolls back the checkpoint and live header, then retries at the same seq', async () => {
    const { store } = await fixture();
    try {
      const contexts = new ConversationContextStore(store);
      const conversation = conversationId(store);
      const { header } = contexts.open(conversation, 'hash-a');
      const before = { ...header };
      const checkpoint = {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: '<memo_list>first</memo_list>', timestamp: 1 }),
        role: 'user' as const,
        memoState: { refresh: true, refreshSeq: 99n, stateJson: '[{"id":"first"}]', pending: false },
      };
      store.db.exec(`CREATE TRIGGER fail_memo_state BEFORE UPDATE OF memo_state_json ON conversation_contexts
        BEGIN SELECT RAISE(ABORT, 'memo state write failed'); END;`);
      expect(() => contexts.append(header, checkpoint)).toThrow();
      expect(header).toEqual(before);
      expect(contexts.header(conversation)).toEqual(before);
      expect(contexts.retained(header)).toEqual([]);
      expect(
        store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM context_messages').get()?.count,
      ).toBe(0n);

      store.db.exec('DROP TRIGGER fail_memo_state');
      expect(contexts.append(header, checkpoint)).toBe(1n);
      expect(header.nextSeq).toBe(2n);
      expect(header.memoRefreshSeq).toBe(1n);
      expect(header.memoStateJson).toBe(checkpoint.memoState.stateJson);
      expect(header.memoRefreshPending).toBe(false);
      expect(contexts.header(conversation)).toEqual(header);
      expect(contexts.window(header).map((row) => [row.seq, row.isCheckpoint])).toEqual([[1n, true]]);

      contexts.append(header, {
        ...checkpoint,
        memoState: { ...checkpoint.memoState, refresh: false, stateJson: '[]' },
      });
      expect(header.nextSeq).toBe(3n);
      expect(header.memoRefreshSeq).toBe(1n);
      expect(contexts.header(conversation)).toEqual(header);
    } finally {
      store.close();
    }
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
    // The generation bump fences the pre-cut writer: its late message cannot
    // append into the cleared history or move its head back.
    expect(() =>
      contexts.append(stale, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'after the cut', timestamp: 9 }),
        role: 'user',
      }),
    ).toThrow(StaleContextError);
    expect(() => contexts.advanceHead(stale, 2n)).toThrow(StaleContextError);
    expect(contexts.retained(contexts.header(conversation)!)).toEqual([]);
    // A header reopened after the cut starts from the new generation and writes
    // normally.
    const reopened = contexts.header(conversation);
    if (reopened === undefined) {
      throw new Error('Expected a reopened context header');
    }
    contexts.append(reopened, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'after the cut', timestamp: 9 }),
      role: 'user',
    });
    expect(contexts.retained(reopened).map((row) => row.seq)).toEqual([5n]);
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

  test('a lowered model budget rebuilds an oversized Context and keeps a fitting one', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const first = contexts.open(conversation, 'hash-a', {
      budget: { contextWindow: 1_048_576, maxOutputTokens: 32_768, maxRetainedTokens: 700_000 },
    });
    expect(first.rebuilt).toBe(false);
    contexts.append(first.header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 500_000,
      json: JSON.stringify({ role: 'user', content: 'a very long history', timestamp: 1 }),
      role: 'user',
    });

    // The hot-reloaded window is smaller and the retained transcript no longer
    // fits: the canonical transcript goes, the persisted chat messages stay.
    const lowered = contexts.open(conversation, 'hash-a', {
      budget: { contextWindow: 262_144, maxOutputTokens: 32_768, maxRetainedTokens: 100_000 },
    });
    expect(lowered.rebuilt).toBe(true);
    expect(lowered.reason).toBe('context_window');
    expect(lowered.header.headSeq).toBe(1n);
    expect(lowered.header.nextSeq).toBe(1n);
    expect(lowered.header.contextWindow).toBe(262_144n);
    expect(lowered.header.maxOutputTokens).toBe(32_768n);
    expect(contexts.retained(lowered.header)).toEqual([]);
    expect(lowered.header.generation).toBeGreaterThan(first.header.generation);

    // A transcript that still fits the new budget keeps its continuity and only
    // records the budget it now runs under.
    contexts.append(lowered.header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'recent', timestamp: 2 }),
      role: 'user',
    });
    const raised = contexts.open(conversation, 'hash-a', {
      budget: { contextWindow: 300_000, maxOutputTokens: 16_384, maxRetainedTokens: 200_000 },
    });
    expect(raised.rebuilt).toBe(false);
    expect(raised.reason).toBeNull();
    expect(raised.header.contextWindow).toBe(300_000n);
    expect(raised.header.maxOutputTokens).toBe(16_384n);
    expect(contexts.retained(raised.header)).toHaveLength(1);
    store.close();
  });

  test('a pre-052 Context adopts the current budget without discarding history', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 10,
      json: JSON.stringify({ role: 'user', content: 'old row', timestamp: 1 }),
      role: 'user',
    });
    // Migration 052 leaves the columns NULL on rows that predate it.
    store.db.prepare('UPDATE conversation_contexts SET context_window = NULL, max_output_tokens = NULL').run();

    const adopted = contexts.open(conversation, 'hash-a', {
      budget: { contextWindow: 262_144, maxOutputTokens: 32_768, maxRetainedTokens: 100_000 },
    });
    expect(adopted.rebuilt).toBe(false);
    expect(adopted.header.contextWindow).toBe(262_144n);
    expect(adopted.header.maxOutputTokens).toBe(32_768n);
    expect(contexts.retained(adopted.header)).toHaveLength(1);

    // The same upgrade path must still protect a window lowered before the
    // upgrade: an oversized pre-052 transcript is rebuilt, not adopted.
    contexts.append(adopted.header, {
      invocationId: null,
      isCheckpoint: false,
      estTokens: 500_000,
      json: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'huge' }], timestamp: 2 }),
      role: 'assistant',
    });
    store.db.prepare('UPDATE conversation_contexts SET context_window = NULL, max_output_tokens = NULL').run();
    const oversized = contexts.open(conversation, 'hash-a', {
      budget: { contextWindow: 262_144, maxOutputTokens: 32_768, maxRetainedTokens: 100_000 },
    });
    expect(oversized.rebuilt).toBe(true);
    expect(oversized.reason).toBe('context_window');
    expect(contexts.retained(oversized.header)).toEqual([]);
    store.close();
  });

  test('a rebuilt Context refuses every late write from the old header', async () => {
    const { store } = await fixture();
    const contexts = new ConversationContextStore(store);
    const conversation = conversationId(store);
    const { header } = contexts.open(conversation, 'hash-a');
    for (let index = 0; index < 3; index += 1) {
      contexts.append(header, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: `message ${index}`, timestamp: index }),
        role: 'user',
      });
    }
    const stale = { ...header };
    expect(contexts.rebuildForConversations([conversation])).toBe(1);
    expect(contexts.header(conversation)?.generation).toBe(stale.generation + 1n);

    expect(() =>
      contexts.append(stale, {
        invocationId: null,
        isCheckpoint: true,
        estTokens: 10,
        json: JSON.stringify({ role: 'user', content: 'late', timestamp: 9 }),
        role: 'user',
      }),
    ).toThrow(StaleContextError);
    expect(() => contexts.advanceHead(stale, 2n)).toThrow(StaleContextError);
    expect(() => contexts.clear(stale)).toThrow(StaleContextError);
    // `touch` is best-effort cleanup in a dying run: it must not throw, but it
    // must not write either.
    contexts.touch(stale, 99n);
    expect(
      store.db
        .prepare<[], { active_invocation_id: bigint | null }>('SELECT active_invocation_id FROM conversation_contexts')
        .get()?.active_invocation_id,
    ).toBeNull();
    expect(contexts.retained(contexts.header(conversation)!)).toEqual([]);
    store.close();
  });
});
