/**
 * The group-memory read tools are runtime primitives: `execute` must neither
 * register a capability under their names nor dispatch them.
 */
import { expect, test } from 'vitest';
import { createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { createGroupMemoryReadTools } from '../../src/context/group-memory/tools/read.ts';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { auditRows, seedInvocation } from '../memo/fixtures.ts';
import { groupMemoryContext as context, groupMemoryFixture } from './fixtures.ts';

// Ways the group-memory read primitives can leak through `execute`: a
// capability registered under either name gives the model a second copy that
// skips the Chat's `group_memory.enabled` gate, and a model that asks execute
// for one is told it does not exist instead of to call it directly.
test('execute refuses the group-memory read primitives by name', async () => {
  const f = await groupMemoryFixture();
  try {
    const invocationId = seedInvocation(f.store, f.conversationId);
    const tools = createGroupMemoryReadTools({
      store: f.store,
      configStore: f.configStore,
      context: context(f, invocationId),
    });
    expect(tools.map((tool) => tool.name)).toEqual(['search_group_memory', 'read_group_messages']);
    const audit = createToolAudit(f.store, invocationId);
    for (const tool of tools) {
      expect(() => createExecuteTool({ audit, capabilities: [{ tool, sideEffect: false }] })).toThrow(
        /cannot be registered/,
      );
    }

    const execute = createExecuteTool({ audit, capabilities: [] });
    await expect(
      execute.execute('call-search', { action: 'call', tool: 'search_group_memory', input: {} }),
    ).rejects.toThrow(/call it directly/);
    await expect(
      execute.execute('call-range', {
        action: 'call',
        tool: 'read_group_messages',
        input: { first_message_id: 1, last_message_id: 2 },
      }),
    ).rejects.toThrow(/call it directly/);
    expect(auditRows(f.store, invocationId)).toEqual([
      { toolCallId: 'call-search', toolName: 'execute', state: 'error', errorCode: 'execute_primitive_rejected' },
      { toolCallId: 'call-range', toolName: 'execute', state: 'error', errorCode: 'execute_primitive_rejected' },
    ]);
  } finally {
    await f.close();
  }
});
