import { afterAll, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { createToolAudit } from '../../src/store/tool-audit.ts';
import { capability, createExecuteTool } from '../../src/capabilities/execute-tool.ts';
import { createMemoryTools, MemoryStore } from '../../src/context/memory.ts';
import { fauxRegistry } from '../helpers.ts';
import {
  cleanupSkillDirectories,
  lastToolResult,
  setupInvocation,
  skillAgentRuntime,
  toolResultText,
} from './fixtures.ts';

afterAll(cleanupSkillDirectories);

test('execute refuses primitives and unknown capabilities while memory calls still work', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('surowan-skills-memory-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('execute', { action: 'call', tool: 'send', input: { kind: 'text', text: 'nope' } }),
      { stopReason: 'toolUse' },
    ),
    (context) => {
      const rejected = lastToolResult(context.messages);
      expect(rejected.isError).toBe(true);
      expect(toolResultText(rejected)).toContain('runtime primitive send');
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'owner likes cats' } }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const saved = lastToolResult(context.messages);
      expect(saved.isError).toBe(false);
      expect(toolResultText(saved)).toContain('Saved memory');
      return fauxAssistantMessage(
        fauxToolCall('execute', { action: 'call', tool: 'generate_image', input: { prompt: 'x' } }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      const unknown = lastToolResult(context.messages);
      expect(unknown.isError).toBe(true);
      expect(toolResultText(unknown)).toContain('no capability named generate_image');
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'saved' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage('done'),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = await skillAgentRuntime(store, setup.configStore, (context) => [
    ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
  ]);
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'error', error_code: 'execute_primitive_rejected' },
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'add_memory', state: 'success', error_code: null },
    { tool_name: 'execute', state: 'error', error_code: 'unknown_capability' },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  const memories = store.db
    .prepare<[], { content: string }>('SELECT content FROM memories')
    .all()
    .map((row) => row.content);
  expect(memories).toEqual(['owner likes cats']);
  store.close();
});

test('execute rejects a half-filled action before dispatch and audits the rejection', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('surowan-skills-invalid-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  agentFaux.setResponses([
    // The flattened provider schema cannot require `input` for call alone, so a
    // lenient endpoint can hand this over; the runtime must reject it.
    fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'add_memory' }), { stopReason: 'toolUse' }),
    (context) => {
      const missingInput = lastToolResult(context.messages);
      expect(missingInput.isError).toBe(true);
      expect(toolResultText(missingInput)).toContain('execute.call requires an input object');
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'search' }), { stopReason: 'toolUse' });
    },
    (context) => {
      const missingQuery = lastToolResult(context.messages);
      expect(missingQuery.isError).toBe(true);
      expect(toolResultText(missingQuery)).toContain('execute.search requires a query string');
      return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'add_memory' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      const help = lastToolResult(context.messages);
      expect(help.isError).toBe(false);
      expect(toolResultText(help)).toContain('add_memory');
      return fauxAssistantMessage(fauxToolCall('send', { kind: 'text', text: 'nothing to save' }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('done'),
  ]);
  const memoryStore = new MemoryStore(store.orm);
  const runtime = await skillAgentRuntime(store, setup.configStore, (context) => [
    ...createMemoryTools(memoryStore, context).map((tool) => capability(tool, true)),
  ]);
  expect(
    await runtime.run(setup.invocationId, setup.configStore.beginInvocation(), new AbortController().signal),
  ).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  const rows = store.db
    .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
      'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    { tool_name: 'execute', state: 'error', error_code: 'invalid_arguments' },
    { tool_name: 'execute', state: 'error', error_code: 'invalid_arguments' },
    { tool_name: 'execute', state: 'success', error_code: null },
    { tool_name: 'send', state: 'success', error_code: null },
  ]);
  expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM memories').get()?.count).toBe(0n);
  store.close();
});

test('execute does not dispatch a capability once the run is aborted', async () => {
  const agentFaux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const setup = await setupInvocation('surowan-skills-aborted-', false, fauxRegistry(agentFaux));
  const { store } = setup;
  let dispatched = 0;
  // Like the alarm capability, this side effect ignores its signal.
  const sideEffect = capability(
    {
      name: 'record_note',
      label: 'Record a note',
      description: 'Records a note.',
      parameters: Type.Object({ note: Type.String() }),
      execute: async () => {
        dispatched += 1;
        return { content: [{ type: 'text', text: 'recorded' }], details: {} };
      },
    },
    true,
  );
  const tool = createExecuteTool({
    audit: createToolAudit(store, setup.invocationId),
    capabilities: [sideEffect],
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    tool.execute('aborted-call', { action: 'call', tool: 'record_note', input: { note: 'x' } }, controller.signal),
  ).rejects.toThrow('execute.call record_note failed');
  expect(dispatched).toBe(0);
  expect(
    store.db
      .prepare<[], { tool_name: string; state: string; error_code: string | null }>(
        'SELECT tool_name, state, error_code FROM tool_calls ORDER BY id',
      )
      .all(),
  ).toEqual([{ tool_name: 'execute', state: 'error', error_code: 'aborted' }]);
  store.close();
});
