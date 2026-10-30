import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type Tool } from '@earendil-works/pi-ai';
import { getJsonSchemaToolParameters } from '@earendil-works/pi-ai/api/constrained-sampling';
import { Compile } from 'typebox/compile';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { AlarmInputSchema } from '../../src/plugins/alarm/alarm.ts';
import { KeyedSemaphore } from '../../src/platform/concurrency.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { capability } from '../../src/capabilities/execute-tool.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { alarmTools, cleanupTestDirectories, futureIso, processDue, setup, update } from './fixtures.ts';
import { fauxRegistry, testTelegramRuntime } from '../helpers.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

describe('alarm tool', () => {
  test('validates schema boundaries and persists a pending alarm with UTC deadline', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });

    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      true,
    );
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '42', summary: '', datetime: futureIso(3600_000) })).toBe(
      false,
    );
    expect(
      Compile(AlarmInputSchema).Check({
        target_user_id: '42',
        summary: 'x'.repeat(501),
        datetime: futureIso(3600_000),
      }),
    ).toBe(false);
    expect(Compile(AlarmInputSchema).Check({ target_user_id: '0', summary: 'x', datetime: futureIso(3600_000) })).toBe(
      false,
    );

    const scheduled = futureIso(3_600_000);
    const tool = alarmTools(store, config, context).alarm;
    const result = await tool.execute('call-1', {
      target_user_id: '42',
      summary: 'follow up on the hospital visit',
      datetime: scheduled,
    });
    expect(result.details.scheduled_at).toBe(scheduled);
    const row = store.db
      .prepare<
        [string],
        { state: string; target_user_id: string; created_by_user_id: bigint | null; scheduled_at: string }
      >(`SELECT state, json_extract(payload_json, '$.target_user_id') AS target_user_id,
                created_by_user_id, scheduled_at FROM long_tasks WHERE id = ?`)
      .get(result.details.id);
    expect(row).toEqual({ state: 'waiting', target_user_id: '42', created_by_user_id: 42n, scheduled_at: scheduled });
    const audit = store.db
      .prepare<[], { state: string; error_code: string | null; result_text: string | null }>(
        'SELECT state, error_code, result_text FROM tool_calls',
      )
      .get();
    expect(audit?.state).toBe('success');
    expect(audit?.error_code).toBe(null);
    expect(audit?.result_text).toContain('alarm_id=');
    store.close();
  });

  test('rejects unauthorized targets, bad datetimes, and enforces a per-invocation quota', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello', 42), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const tool = alarmTools(store, config, context).alarm;

    await expect(
      tool.execute('unauthorized', { target_user_id: '999', summary: 'x', datetime: futureIso(3600_000) }),
    ).rejects.toThrow('not visible');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>(
          "SELECT error_code FROM tool_calls WHERE tool_call_id = 'unauthorized'",
        )
        .get()?.error_code,
    ).toBe('alarm_target_not_authorized');

    await expect(
      tool.execute('past', { target_user_id: '42', summary: 'x', datetime: futureIso(-1000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'past'")
        .get()?.error_code,
    ).toBe('alarm_datetime_not_future');

    await expect(
      tool.execute('far', { target_user_id: '42', summary: 'x', datetime: futureIso(366 * 86_400_000) }),
    ).rejects.toThrow('datetime is invalid');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'far'")
        .get()?.error_code,
    ).toBe('alarm_datetime_too_far');

    for (let index = 0; index < 3; index += 1) {
      await tool.execute(`quota-${index}`, {
        target_user_id: '42',
        summary: `alarm ${index}`,
        datetime: futureIso((index + 1) * 3_600_000),
      });
    }
    await expect(
      tool.execute('quota-3', { target_user_id: '42', summary: 'fourth', datetime: futureIso(5 * 3_600_000) }),
    ).rejects.toThrow('quota');
    expect(
      store.db
        .prepare<[], { error_code: string | null }>("SELECT error_code FROM tool_calls WHERE tool_call_id = 'quota-3'")
        .get()?.error_code,
    ).toBe('alarm_quota_exceeded');
    expect(
      store.db
        .prepare<[], { count: bigint }>("SELECT COUNT(*) AS count FROM long_tasks WHERE plugin_id = 'alarm'")
        .get()?.count,
    ).toBe(3n);
    store.close();
  });

  test('list_alarm parameters schema is a strict empty object accepted by provider adapters', async () => {
    const { store, config, ingestion, scheduler, build } = await setup();
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, 'hello'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));
    const context = build(invocationId, { contextWindow: 200_000, maxOutputTokens: 32768 });
    const tool = alarmTools(store, config, context).list_alarm;

    // Regression: `Invalid schema for function 'list_alarm':
    // schema must be a JSON Schema of type object, got type null`.
    const schema = tool.parameters as unknown as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
    expect(schema.additionalProperties).toBe(false);
    // The same transformation provider adapters apply before sending tools.
    expect(getJsonSchemaToolParameters(tool as Tool, undefined)).toEqual(schema);
    expect(() => getJsonSchemaToolParameters(tool as Tool, true)).not.toThrow();
    const strictSchema = getJsonSchemaToolParameters(tool as Tool, true) as Record<string, unknown>;
    expect(strictSchema.type).toBe('object');
    expect(strictSchema.required).toEqual([]);
    expect(strictSchema.additionalProperties).toBe(false);

    // An empty-object tool call passes runtime argument validation, and the
    // audit trail records the empty-object arguments instead of null.
    const validator = Compile(tool.parameters);
    expect(validator.Check({})).toBe(true);
    expect(validator.Check({ user_id: '42' })).toBe(false);
    const result = await tool.execute('schema-call', {});
    expect(result.details.items).toEqual([]);
    const audit = store.db
      .prepare<[string], { arguments_json: string; state: string; error_code: string | null }>(
        'SELECT arguments_json, state, error_code FROM tool_calls WHERE tool_call_id = ?',
      )
      .get('schema-call');
    expect(audit?.state).toBe('success');
    expect(audit?.error_code).toBe(null);
    expect(audit?.arguments_json).toBe('{}');
    store.close();
  });

  test('the agent runtime presents list_alarm with an object schema to the model', async () => {
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const { store, config, ingestion, scheduler, configStore } = await setup(fauxRegistry(faux), true);
    const received = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(update(1, 10, '我有哪些闹钟'), received);
    const invocationId = processDue(scheduler, new Date(received.getTime() + 15_000));

    faux.setResponses([
      (context, options) => {
        // Mirror what real adapters do: capture the provider payload for audit.
        options?.onPayload?.(
          { model: 'agent-model', messages: context.messages, tools: getCurrentTools(context.messages) },
          faux.getModel(),
        );
        void options?.onResponse?.({ status: 200, headers: {} }, faux.getModel());
        // list_alarm is no longer directly exposed; its schema reaches the
        // model through the execute help action instead.
        return fauxAssistantMessage(fauxToolCall('execute', { action: 'help', tool: 'list_alarm' }), {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        const last = context.messages.filter((message) => message.role === 'toolResult').at(-1);
        const helpText =
          last === undefined
            ? ''
            : last.content
                .filter((entry) => entry.type === 'text')
                .map((entry) => entry.text)
                .join('');
        const helped = JSON.parse(helpText) as { name: string; parameters: unknown };
        expect(helped.name).toBe('list_alarm');
        expect(helped.parameters).toEqual({
          type: 'object',
          properties: {},
          additionalProperties: false,
        });
        return fauxAssistantMessage(fauxToolCall('execute', { action: 'call', tool: 'list_alarm', input: {} }), {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage('listed'),
      // Non-empty draft triggers the send nudge; the model then stays silent.
      fauxAssistantMessage(''),
    ]);
    const runtime = new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime({
        sendMessage: async () => ({ message_id: 500, date: 1_700_000_100, chat: { id: 123456789 } }),
        sendSticker: async () => ({ message_id: 501, date: 1_700_000_101, chat: { id: 123456789 } }),
      }),
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      modelGate: new KeyedSemaphore(),
      systemResources: emptySystemResources(),
      capabilityTools: (context) => [capability(alarmTools(store, config, context).list_alarm, false)],
    });
    expect(await runtime.run(invocationId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });

    const presented = store.db
      .prepare<[], { tools_json: string }>(
        "SELECT tools_json FROM model_calls WHERE role = 'agent' ORDER BY id LIMIT 1",
      )
      .get();
    expect(presented?.tools_json).toBe(
      JSON.stringify(['read', 'search_memory', 'read_memory', 'send', 'send_reply', 'execute']),
    );
    const auditPayload = store.db
      .prepare<[], { request_json: string | null }>(
        "SELECT request_json FROM model_calls WHERE role = 'agent' AND request_json IS NOT NULL ORDER BY id LIMIT 1",
      )
      .get();
    const payload = JSON.parse(auditPayload?.request_json ?? 'null') as { tools?: Array<Record<string, unknown>> };
    // The model-facing registry carries only the runtime primitives; the
    // list_alarm schema was served by the execute help action above.
    expect(payload.tools?.map((entry) => entry.name)).toEqual([
      'read',
      'search_memory',
      'read_memory',
      'send',
      'send_reply',
      'execute',
    ]);
    // The faux tool call id is generated; match by tool name instead.
    const listAudit = store.db
      .prepare<[], { arguments_json: string; state: string }>(
        "SELECT arguments_json, state FROM tool_calls WHERE tool_name = 'list_alarm' LIMIT 1",
      )
      .get();
    expect(listAudit?.state).toBe('success');
    expect(listAudit?.arguments_json).toBe('{}');
    store.close();
  });
});
