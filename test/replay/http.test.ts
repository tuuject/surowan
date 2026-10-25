import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  withoutInitialSystemMessage,
} from '@earendil-works/pi-ai';
import { afterEach, expect, test } from 'vitest';
import { composeAgentPrompt } from '../../src/platform/agent-prompt.ts';
import {
  OVERRIDE_PROMPT,
  apiKeyRow,
  cleanupFixtures,
  fixture,
  productionTables,
  runCli,
  setupAdminSession,
  stringifyRows,
} from './http-fixtures.ts';

/**
 * The paid path: CLI -> real HTTP AdminServer -> ReplayRunner, with a faux
 * provider so every asserted side effect is synthetic.
 */

interface ReplayResult {
  readonly version: number;
  readonly source_invocation_id: string;
  readonly conversation_id: string;
  readonly chat_id: string;
  readonly thread_id: string;
  readonly model: { readonly provider: string; readonly id: string; readonly thinking_level: string };
  readonly overrides: {
    readonly global_prompt: boolean;
    readonly group_prompt: boolean;
    readonly provider: boolean;
    readonly model: boolean;
    readonly thinking_level: boolean;
  };
  readonly completion_reason: string;
  readonly responded: boolean;
  readonly send_count: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly outputs: readonly { readonly tool_name: string; readonly arguments: Record<string, unknown> }[];
  readonly tool_calls: readonly {
    readonly tool_name: string;
    readonly is_error: boolean;
    readonly arguments: Record<string, unknown>;
    readonly result: unknown;
  }[];
  readonly usage: { readonly model_calls: number; readonly total_tokens: number };
  readonly fidelity: {
    readonly model_selection: string;
    readonly side_effects: string;
    readonly external_tools: string;
    readonly memory_and_alarms: string;
    readonly send_nudge: string;
    readonly production_budgets: string;
    readonly dispatches: readonly { readonly tool_name: string; readonly mode: string; readonly capability?: string }[];
  };
}

afterEach(cleanupFixtures);

test('CLI replay over real HTTP runs ReplayRunner with synthetic side effects and no production writes', async () => {
  const f = await fixture();
  expect(f.listening.hostname).toBe('127.0.0.1');
  expect(f.listening.port).toBeGreaterThan(0);
  const admin = await setupAdminSession(f.baseUrl);
  const promptFile = join(f.directory, 'override-prompt.txt');
  await writeFile(promptFile, OVERRIDE_PROMPT);

  f.faux.setResponses([
    (context, options) => {
      // Only the current global template is replaced; runtime and group remain.
      expect(getCurrentSystemPrompt(context.messages)).toBe(
        composeAgentPrompt({ ...f.stable.promptLayers, global: OVERRIDE_PROMPT }, f.stable.templateValues),
      );
      expect(withoutInitialSystemMessage(context.messages)).toHaveLength(1);
      expect(JSON.stringify(context.messages)).toContain('plain text message with a reply');
      expect(JSON.stringify(context.messages)).not.toContain('long payload fixture');
      expect(options).toMatchObject({ maxRetries: 0, maxTokens: 128 });
      return fauxAssistantMessage(
        [
          fauxToolCall('send', { text: 'synthetic CLI send' }),
          fauxToolCall('execute', { action: 'call', tool: 'add_memory', input: { content: 'synthetic CLI memory' } }),
          fauxToolCall('execute', {
            action: 'call',
            tool: 'alarm',
            input: { target_user_id: '42', datetime: '2099-01-01T00:00:00Z', summary: 'synthetic CLI alarm' },
          }),
          fauxToolCall('mcp_remote_write', {}),
        ],
        { stopReason: 'toolUse' },
      );
    },
    fauxAssistantMessage('private completion'),
  ]);

  const env = { SUROWAN_ENDPOINT: f.baseUrl, SUROWAN_API_KEY: admin.key };
  // Baseline before any key-authenticated CLI request: only the key's
  // last_used_at may move from here on.
  const before = f.rows();
  const keyBefore = apiKeyRow(f.store, admin.keyId);
  expect(keyBefore).toMatchObject({ last_used_at: null, revoked_at: null });

  const list = await runCli(['invocation', 'list', '--limit', '10', '--json'], env);
  expect(list.code).toBe(0);
  expect(list.stderr).toBe('');
  const listing = JSON.parse(list.stdout) as { items: { id: string }[]; next_cursor: string | null };
  expect(listing.items.map((item) => item.id)).toContain('4001');

  const get = await runCli(['invocation', 'get', '4001', '--json'], env);
  expect(get.code).toBe(0);
  expect(get.stderr).toBe('');
  expect(JSON.parse(get.stdout)).toMatchObject({ id: '4001', state: 'completed' });

  const replay = await runCli(['invocation', 'replay', '4001', '--global-prompt', promptFile, '--json'], env);
  expect(replay.code, replay.stderr).toBe(0);
  expect(replay.stderr).toBe('');
  const result = JSON.parse(replay.stdout) as ReplayResult;
  expect(result).toMatchObject({
    version: 2,
    source_invocation_id: '4001',
    scene: { source_bucket_id: '3001', message_count: 1, history_count: 0 },
    conversation_id: '2001',
    chat_id: '123456789',
    thread_id: '0',
    error: null,
    responded: true,
    send_count: 1,
    completion_reason: 'completed',
    model: { provider: 'agent', id: 'agent-model', thinking_level: 'low' },
    overrides: { global_prompt: true, group_prompt: false },
    usage: { model_calls: 2 },
    fidelity: {
      input: 'historical_public_chat',
      prompt_selection: 'current_chat_config',
      tool_selection: 'current_registry',
      model_selection: 'current_chat_config',
      side_effects: 'synthetic',
      external_tools: 'blocked',
      memory_and_alarms: 'empty_in_memory_overlay',
      send_nudge: 'disabled',
      production_budgets: 'not_charged',
    },
  });
  expect(result.usage.total_tokens).toBeGreaterThan(0);
  expect(result.outputs).toEqual([
    expect.objectContaining({ tool_name: 'send', arguments: expect.objectContaining({ text: 'synthetic CLI send' }) }),
  ]);
  const executeCalls = result.tool_calls.filter((call) => call.tool_name === 'execute');
  expect(executeCalls).toHaveLength(2);
  expect(executeCalls.every((call) => call.is_error === false)).toBe(true);
  const memoryCall = executeCalls.find((call) => JSON.stringify(call.arguments).includes('"add_memory"'));
  expect(memoryCall?.is_error).toBe(false);
  expect(JSON.stringify(memoryCall?.result)).toContain('Saved memory');
  const alarmCall = executeCalls.find((call) => JSON.stringify(call.arguments).includes('"alarm"'));
  expect(alarmCall?.is_error).toBe(false);
  expect(JSON.stringify(alarmCall?.result)).toContain('Scheduled alarm');
  // The blocked MCP tool never runs, and every dispatch is synthetic or blocked.
  const blocked = result.tool_calls.find((call) => call.tool_name === 'mcp_remote_write');
  expect(blocked?.is_error).toBe(true);
  expect(result.fidelity.dispatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool_name: 'send', mode: 'synthetic' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'add_memory' }),
      expect.objectContaining({ tool_name: 'execute', mode: 'synthetic', capability: 'alarm' }),
      expect.objectContaining({ tool_name: 'mcp_remote_write', mode: 'blocked' }),
    ]),
  );
  expect(f.faux.state.callCount).toBe(2);

  // Production state is untouched apart from the auth layer's last_used_at.
  const after = f.rows();
  expect(productionTables(after)).toEqual(productionTables(before));
  expect(after.host_sends).toEqual(before.host_sends);
  expect(before.host_sends).toHaveLength(1);
  expect(stringifyRows(after.host_sends)).not.toContain('synthetic CLI send');
  expect(after.model_calls).toEqual(before.model_calls);
  expect(after.context_messages).toEqual(before.context_messages);
  expect(after.long_tasks).toEqual(before.long_tasks);
  expect(after.daily_usage).toEqual(before.daily_usage);
  const keyAfter = apiKeyRow(f.store, admin.keyId);
  expect(keyAfter).toMatchObject({ token_hash: keyBefore?.token_hash, revoked_at: null });
  expect(keyAfter?.last_used_at).toEqual(expect.any(String));
}, 120_000);
