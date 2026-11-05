import { describe, expect, test } from 'vitest';

import {
  buildInvocationTimeline,
  parseSendArguments,
  sortTimelineEvents,
  timelineEventKey,
  type InvocationTimelineEvent,
} from './timeline.ts';
import type { AgentMessageEntry, InvocationDetail, ModelCallEntry, ToolCallEntry } from './api/invocations.ts';
import type { ContextMessageEntry } from './api/contexts.ts';

const AT = '2026-09-15T10:00:00.000Z';

function contextMessage(overrides: Partial<ContextMessageEntry> = {}): ContextMessageEntry {
  return {
    section: 'new',
    sequence_no: 1,
    message_id: '7001',
    revision_id: '8001',
    omitted_before: 0,
    snapshot_json:
      '{"sender":{"username":"alice","name":"Alice"},"kind":"text","text":"hello","telegram_date":"2026-09-15T09:59:00.000Z","message_id":"7001"}',
    ...overrides,
  };
}

function modelCall(overrides: Partial<ModelCallEntry> = {}): ModelCallEntry {
  return {
    id: '3001',
    role: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    attempt: 1,
    state: 'success',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: 150,
    provider_total_tokens: 150,
    cost: 0.0004,
    duration_ms: 320,
    error_code: null,
    error_detail: null,
    request_json: null,
    response_json: null,
    created_at: AT,
    finished_at: AT,
    tools: ['send', 'read'],
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: '2001',
    tool_call_id: 'call_1',
    tool_name: 'read',
    arguments_json: '{"path":"system:///skills/readme.md"}',
    result_text: 'ok',
    state: 'success',
    side_effect: false,
    error_code: null,
    duration_ms: 12,
    created_at: AT,
    finished_at: AT,
    ...overrides,
  };
}

function agentMessage(overrides: Partial<AgentMessageEntry> = {}): AgentMessageEntry {
  return {
    sequence_no: 1,
    role: 'assistant',
    text: 'thinking privately',
    thinking_text: '',
    created_at: AT,
    ...overrides,
  };
}

function invocation(overrides: Partial<InvocationDetail> = {}): InvocationDetail {
  return {
    id: '9001',
    state: 'completed',
    created_at: AT,
    started_at: AT,
    finished_at: AT,
    completion_reason: 'turn_limit_reached',
    error_code: null,
    sends_used: 1,
    tool_calls_used: 1,
    turns_used: 1,
    side_effect_started: true,
    config_hash: 'cfg-hash-1',
    chat: {
      host_kind: 'telegram',
      telegram_chat_id: '123456789',
      room_id: null,
      type: 'supergroup',
      title: 'Test Group',
      username: null,
      message_thread_id: 0,
    },
    tool_call_count: 1,
    total_tokens: 150,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_cost: 0.0004,
    bucket_id: '42',
    prompt_version: 7,
    tool_registry_hash: 'reg-1',
    tool_registry: null,
    tool_calls: [],
    model_calls: [],
    agent_messages: [],
    telegram_sends: [],
    context_messages: [],
    ...overrides,
  };
}

describe('parseSendArguments', () => {
  test('malformed JSON degrades to null fields, never throws', () => {
    expect(parseSendArguments('not json{')).toEqual({
      kind: null,
      text: null,
      sticker_ref: null,
      reply_to_message_id: null,
    });
    expect(parseSendArguments('')).toEqual({
      kind: null,
      text: null,
      sticker_ref: null,
      reply_to_message_id: null,
    });
  });
});

describe('sortTimelineEvents', () => {
  test('unparseable timestamps group by order instead of producing NaN sort', () => {
    const events: InvocationTimelineEvent[] = [
      { kind: 'queued', at: 'not-a-date', order: 2 },
      { kind: 'started', at: 'not-a-date', order: 1 },
    ];
    expect(sortTimelineEvents(events).map((event) => event.kind)).toEqual(['started', 'queued']);
  });
});

describe('buildInvocationTimeline', () => {
  test('timelineEventKey is unique per event', () => {
    const detail = invocation({
      tool_calls: [
        toolCall({ id: '2001', tool_call_id: 'call_send', tool_name: 'send' }),
        toolCall({ id: '2002', tool_call_id: 'call_read', tool_name: 'read' }),
      ],
      model_calls: [modelCall({ id: '3001' })],
      agent_messages: [agentMessage({ sequence_no: 1 })],
      context_messages: [contextMessage({ sequence_no: 1 })],
    });
    const events = buildInvocationTimeline(detail);
    const keys = events.map(timelineEventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('context-1');
    expect(keys).toContain('model-3001');
    expect(keys).toContain('tool-2001');
    expect(keys).toContain('agent-1');
  });
});
