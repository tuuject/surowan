import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Type from 'typebox';
import { expect, test } from 'vitest';
import { SendInputSchema } from '../src/capabilities/send-tool.ts';
import { AddMemoryInputSchema } from '../src/context/memory.ts';
import { createReplayTools } from '../src/orchestration/replay-tools.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { ReadParameters, callCapability, definition, replayInput, textOf, toolOf } from './replay-tools-fixtures.ts';

test('unknown top-level tools and MCP tools are blocked', async () => {
  const replay = createReplayTools(
    replayInput({ tools: [definition('send_file'), definition('mcp__demo__search')] }),
    emptySystemResources(),
  );
  await expect(toolOf(replay.tools, 'send_file').execute('call-1', { path: 'x' })).rejects.toThrow(
    'scene test blocks tool send_file',
  );
  await expect(toolOf(replay.tools, 'mcp__demo__search').execute('call-2', { query: 'x' })).rejects.toThrow(
    'scene test blocks tool mcp__demo__search',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'call-1', tool_name: 'send_file', mode: 'blocked' },
    { tool_call_id: 'call-2', tool_name: 'mcp__demo__search', mode: 'blocked' },
  ]);
  expect(replay.outputs).toEqual([]);
});

test('execute denies primitives, unknown names, and side-effect-free production capabilities', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [definition('web_fetch', Type.Object({ url: Type.String() })), definition('search_stickers')],
    }),
    emptySystemResources(),
  );
  await expect(callCapability(replay, 'exec-1', 'web_fetch', { url: 'https://example.com' })).rejects.toThrow(
    'execute.call web_fetch failed: replay blocks capability web_fetch',
  );
  await expect(callCapability(replay, 'exec-2', 'search_stickers', {})).rejects.toThrow(
    'replay blocks capability search_stickers',
  );
  await expect(callCapability(replay, 'exec-3', 'read', { uri: 'system:///skills/x/SKILL.md' })).rejects.toThrow(
    'execute cannot dispatch the runtime primitive read; call it directly',
  );
  await expect(callCapability(replay, 'exec-4', 'not_a_capability', {})).rejects.toThrow(
    'execute has no capability named not_a_capability',
  );
  // A known synthetic name is still blocked when the snapshot never listed it.
  await expect(callCapability(replay, 'exec-5', 'add_memory', { content: 'x' })).rejects.toThrow(
    'execute has no capability named add_memory',
  );
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-1', tool_name: 'execute', mode: 'blocked', capability: 'web_fetch' },
    { tool_call_id: 'exec-2', tool_name: 'execute', mode: 'blocked', capability: 'search_stickers' },
    { tool_call_id: 'exec-3', tool_name: 'execute', mode: 'blocked', capability: 'read' },
    { tool_call_id: 'exec-4', tool_name: 'execute', mode: 'blocked', capability: 'not_a_capability' },
    { tool_call_id: 'exec-5', tool_name: 'execute', mode: 'blocked', capability: 'add_memory' },
  ]);
  expect(replay.outputs).toEqual([]);
});

test('execute search and help stay inside the current registry', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('execute')],
      capabilities: [
        definition('web_fetch', Type.Object({ url: Type.String() })),
        definition('add_memory', AddMemoryInputSchema),
      ],
    }),
    emptySystemResources(),
  );
  const execute = toolOf(replay.tools, 'execute');
  const search = await execute.execute('exec-5', { action: 'search', query: 'fetch a web page' });
  expect(JSON.parse(textOf(search))).toEqual([{ name: 'web_fetch', summary: 'web_fetch' }]);
  const help = await execute.execute('exec-6', { action: 'help', tool: 'add_memory' });
  expect(JSON.parse(textOf(help))).toMatchObject({ name: 'add_memory', description: 'add_memory current definition' });
  expect(replay.dispatches).toEqual([
    { tool_call_id: 'exec-5', tool_name: 'execute', mode: 'synthetic' },
    { tool_call_id: 'exec-6', tool_name: 'execute', mode: 'synthetic' },
  ]);
});

test('an aborted signal stops every replay tool before dispatch', async () => {
  const replay = createReplayTools(
    replayInput({
      tools: [definition('send', SendInputSchema), definition('read', ReadParameters), definition('execute')],
      capabilities: [definition('add_memory', AddMemoryInputSchema)],
    }),
    emptySystemResources(),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    toolOf(replay.tools, 'send').execute('abort-1', { kind: 'text', text: 'hi' }, controller.signal),
  ).rejects.toThrow();
  await expect(
    toolOf(replay.tools, 'read').execute('abort-2', { uri: 'system:///skills/memory/SKILL.md' }, controller.signal),
  ).rejects.toThrow();
  await expect(
    toolOf(replay.tools, 'execute').execute(
      'abort-3',
      { action: 'call', tool: 'add_memory', input: { content: 'x' } },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(replay.outputs).toEqual([]);
  expect(replay.dispatches).toEqual([]);
});

test('replay tools import no production wiring and need no store', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'orchestration', 'replay-tools.ts'), 'utf8');
  for (const banned of [
    'store/database.ts',
    'store/schema.ts',
    'store/long-tasks.ts',
    'drizzle-orm',
    'platform/config.ts',
    'orchestration/agent-runtime',
    'application.ts',
    'capabilities/mcp.ts',
  ]) {
    expect(source).not.toContain(banned);
  }
  expect(source).not.toMatch(/\bSqliteStore\b/);
});
