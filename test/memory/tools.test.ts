import { afterAll, expect, test } from 'vitest';
import Compile from 'typebox/compile';
import {
  AddMemoryInputSchema,
  createMemoryTools,
  DeleteMemoryInputSchema,
  MemoryStore,
} from '../../src/context/memory.ts';
import { renderInvocationContext } from '../helpers.ts';
import { cleanupDirectories, fixture, secondConversation } from './helpers.ts';

afterAll(cleanupDirectories);

test('add_memory and delete_memory audit tool calls and respect conversation scope', async () => {
  const { store, loaded, conversationId, invocationId } = await fixture();
  try {
    const memory = new MemoryStore(store.orm);
    const context = renderInvocationContext(store, loaded.config, invocationId, {
      contextWindow: 200_000,
      maxOutputTokens: 32768,
    });
    expect(context.conversationId).toBe(conversationId);
    const [addTool, deleteTool] = createMemoryTools(memory, context);
    if (addTool === undefined || deleteTool === undefined) {
      throw new Error('Expected both memory tools');
    }

    const added = await addTool.execute(
      'call-1',
      { content: 'Alice prefers short replies' },
      new AbortController().signal,
    );
    const id = added.details.id;
    expect(id).toMatch(/^mem_[a-f0-9]{32}$/);
    const row = store.db
      .prepare<
        [],
        { tool_name: string; state: string; side_effect: bigint; result_text: string; arguments_json: string }
      >(
        "SELECT tool_name, state, side_effect, result_text, arguments_json FROM tool_calls WHERE tool_call_id = 'call-1'",
      )
      .get();
    expect(row).toMatchObject({
      tool_name: 'add_memory',
      state: 'success',
      side_effect: 1n,
    });
    expect(row?.arguments_json).toContain('Alice prefers short replies');
    expect(row?.result_text).toContain(`memory_id=${id}`);

    const custom = await addTool.execute(
      'call-2',
      { content: 'short-lived', ttl_seconds: 3_600 },
      new AbortController().signal,
    );
    const stored = store.db
      .prepare<[string], { created_at: string; expires_at: string }>(
        'SELECT created_at, expires_at FROM memories WHERE id = ?',
      )
      .get(custom.details.id);
    expect(stored?.expires_at).toBe(new Date(Date.parse(stored!.created_at) + 3_600_000).toISOString());

    // delete_memory removes only its own conversation's memory.
    const foreignConversation = secondConversation(store, conversationId);
    const foreign = new MemoryStore(store.orm).add(foreignConversation, 'foreign note', 86_400);
    const foreignDelete = await deleteTool.execute('call-3', { id: foreign.id }, new AbortController().signal);
    expect(foreignDelete.details.id).toBe(foreign.id);
    expect(
      store.db
        .prepare<[string], { count: bigint }>('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(foreign.id)?.count,
    ).toBe(1n);
    const deleted = await deleteTool.execute('call-4', { id }, new AbortController().signal);
    expect(deleted.details.id).toBe(id);
    expect(
      store.db.prepare<[string], { count: bigint }>('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(id)
        ?.count,
    ).toBe(0n);
    const audit = store.db
      .prepare<[], { state: string; result_text: string }>(
        "SELECT state, result_text FROM tool_calls WHERE tool_call_id = 'call-4'",
      )
      .get();
    expect(audit).toMatchObject({ state: 'success' });
    expect(audit?.result_text).toContain('deleted');

    // Tool-layer hard limits live in the schemas.
    expect(Compile(AddMemoryInputSchema).Check({ content: 'x'.repeat(151) })).toBe(false);
    expect(Compile(AddMemoryInputSchema).Check({ content: 'x'.repeat(150) })).toBe(true);
    expect(Compile(DeleteMemoryInputSchema).Check({ id: 'mem_zzzz' })).toBe(false);
  } finally {
    store.close();
  }
});
