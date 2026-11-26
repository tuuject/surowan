import { describe, expect, test } from 'vitest';
import type { ContextMessageEntry } from './api/contexts.ts';
import type {
  AgentMessageEntry,
  InvocationBucketEntry,
  InvocationDetail,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from './api/invocations.ts';
import { buildInvocationChat, type ChatItem, type InvocationChat } from './invocation-chat.ts';

const t = (second: number): string => new Date(Date.UTC(2026, 8, 15, 10, 0, second)).toISOString();

function message(
  sequence: number,
  text: string,
  overrides: Partial<ContextMessageEntry> & { readonly fromBot?: boolean } = {},
): ContextMessageEntry {
  const { fromBot = false, ...rest } = overrides;
  return {
    section: 'new',
    sequence_no: sequence,
    message_id: String(7000 + sequence),
    revision_id: String(8000 + sequence),
    source_bucket_id: '42',
    omitted_before: 0,
    snapshot_json: JSON.stringify({
      sender: { username: 'alice', name: 'Alice' },
      kind: 'text',
      text,
      telegram_date: t(0),
      message_id: String(900 + sequence),
      sent_by_bot: fromBot,
    }),
    ...rest,
  };
}

function model(id: string, at: string, overrides: Partial<ModelCallEntry> = {}): ModelCallEntry {
  return {
    id,
    role: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    attempt: 1,
    state: 'success',
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: 2,
    provider_total_tokens: 2,
    cost: null,
    duration_ms: 1,
    error_code: null,
    error_detail: null,
    request_json: null,
    response_json: null,
    created_at: at,
    finished_at: at,
    tools: null,
    ...overrides,
  };
}

function tool(
  id: string,
  name: string,
  args: unknown,
  at: string,
  overrides: Partial<ToolCallEntry> = {},
): ToolCallEntry {
  return {
    id,
    tool_call_id: `call_${id}`,
    tool_name: name,
    arguments_json: typeof args === 'string' ? args : JSON.stringify(args),
    result_text: 'ok',
    state: 'success',
    side_effect: name === 'send' || name === 'send_reply',
    error_code: null,
    duration_ms: 1,
    created_at: at,
    finished_at: at,
    ...overrides,
  };
}

function agent(sequence: number, role: string, text: string, at: string, thinking = ''): AgentMessageEntry {
  return { sequence_no: sequence, role, text, thinking_text: thinking, created_at: at };
}

function send(id: string, toolCallId: string, messageNo: string, state = 'success'): TelegramSendEntry {
  return {
    id,
    tool_call_id: toolCallId,
    kind: 'text',
    request_json: '{}',
    state,
    telegram_message_id: messageNo,
    room_seq: null,
    error_code: null,
    created_at: t(0),
    finished_at: t(0),
  };
}

function bucket(id: string, attached: string, injected: string | null): InvocationBucketEntry {
  return { bucket_id: id, attached_at: attached, injected_at: injected };
}

function invocation(overrides: Partial<InvocationDetail> = {}): InvocationDetail {
  return {
    id: '9001',
    state: 'completed',
    created_at: t(0),
    started_at: t(1),
    finished_at: t(59),
    completion_reason: 'turn_limit_reached',
    error_code: null,
    sends_used: 0,
    tool_calls_used: 0,
    turns_used: 1,
    side_effect_started: false,
    config_hash: 'cfg',
    chat: {
      host_kind: 'telegram',
      telegram_chat_id: '123',
      room_id: null,
      type: 'supergroup',
      title: 'Group',
      username: null,
      message_thread_id: 0,
    },
    tool_call_count: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_cost: null,
    bucket_id: '42',
    prompt_version: 7,
    tool_registry_hash: null,
    tool_registry: null,
    tool_calls: [],
    model_calls: [],
    agent_messages: [],
    telegram_sends: [],
    context_messages: [],
    buckets: [],
    resumed_from_invocation_id: null,
    resumed_by_invocation_id: null,
    resume: { available: false, reason: 'resume_not_failed' },
    ...overrides,
  };
}

/** One line per item, so a whole conversation reads as one assertion. */
function outline(chat: InvocationChat): string[] {
  const describe = (item: ChatItem): string => {
    switch (item.kind) {
      case 'member':
        return `${item.position} member ${item.message.text ?? ''}${item.message.fromBot ? ' (bot)' : ''}`;
      case 'reply':
        return `${item.position} reply ${item.parts.map((part) => part.text ?? part.sticker_ref ?? '?').join(' + ')}`;
      case 'steps':
        return `steps[${item.steps.map((step) => `${step.position}:${step.action.kind}${step.secondary ? '?' : ''}`).join(',')}]`;
    }
  };
  return [
    ...chat.history.map(describe),
    ...chat.batches.flatMap((batch) => [
      `-- ${batch.bucketId} ${batch.status} ${batch.at}`,
      ...batch.items.map(describe),
    ]),
  ];
}

describe('buildInvocationChat', () => {
  test('old runs without batch rows still show every new message as one batch after the history', () => {
    const chat = buildInvocationChat(
      invocation({
        context_messages: [
          message(1, 'earlier', { section: 'history', source_bucket_id: null }),
          message(2, 'my own earlier reply', { section: 'history', source_bucket_id: null, fromBot: true }),
          message(3, 'question', { source_bucket_id: null }),
        ],
        tool_calls: [tool('1', 'send', { text: 'answer' }, t(5))],
      }),
    );
    expect(outline(chat)).toEqual([
      '0 member earlier',
      '1 member my own earlier reply (bot)',
      `-- 42 injected ${t(1)}`,
      '2 member question',
      '3 reply answer',
    ]);
  });

  test('attached batches split messages by source batch and activity by injection time', () => {
    const chat = buildInvocationChat(
      invocation({
        buckets: [bucket('42', t(0), t(1)), bucket('43', t(10), t(20))],
        context_messages: [message(1, 'first'), message(2, 'second', { source_bucket_id: '43' })],
        model_calls: [model('m1', t(2)), model('m2', t(20))],
        agent_messages: [agent(1, 'assistant', 'plan', t(3)), agent(2, 'assistant', '', t(21))],
        tool_calls: [
          tool('1', 'read', { uri: 'system:///skills/web-fetch/SKILL.md' }, t(4)),
          tool('2', 'execute', { action: 'call', tool: 'web_fetch', input: { url: 'https://example.com' } }, t(5)),
          tool('3', 'send', { text: 'one' }, t(6)),
          // Exactly at the second injection: it belongs to the batch the model just read.
          tool('4', 'send', { text: 'two' }, t(20)),
        ],
      }),
    );
    expect(outline(chat)).toEqual([
      `-- 42 injected ${t(1)}`,
      '0 member first',
      'steps[1:model_call?,2:private_text,3:skill,4:tool]',
      '5 reply one',
      `-- 43 injected ${t(20)}`,
      '6 member second',
      'steps[7:model_call?]',
      '8 reply two',
      'steps[9:private_text?]',
    ]);
    const steps = chat.batches[0]?.items[1];
    expect(steps?.kind === 'steps' ? steps.summary : null).toEqual({
      tools: 1,
      skills: 1,
      failedModelCalls: 0,
      privateTexts: 1,
    });
  });

  test('a message from an unknown batch falls back to the opening batch instead of disappearing', () => {
    const chat = buildInvocationChat(
      invocation({
        buckets: [bucket('42', t(0), t(1))],
        context_messages: [
          message(1, 'orphan', { source_bucket_id: '999' }),
          message(2, 'unlabelled', { source_bucket_id: null }),
        ],
      }),
    );
    expect(outline(chat)).toEqual([`-- 42 injected ${t(1)}`, '0 member orphan', '1 member unlabelled']);
  });

  test('a batch the model never read is marked and gets no activity', () => {
    const finished = buildInvocationChat(
      invocation({
        buckets: [bucket('42', t(0), t(1)), bucket('44', t(30), null)],
        context_messages: [message(1, 'first'), message(2, 'late', { source_bucket_id: '44' })],
        tool_calls: [tool('1', 'send', { text: 'reply' }, t(40))],
      }),
    );
    expect(outline(finished)).toEqual([
      `-- 42 injected ${t(1)}`,
      '0 member first',
      '1 reply reply',
      `-- 44 skipped ${t(30)}`,
      '2 member late',
    ]);
    const running = buildInvocationChat(
      invocation({
        state: 'running',
        finished_at: null,
        buckets: [bucket('42', t(0), t(1)), bucket('44', t(30), null)],
        context_messages: [message(2, 'late', { source_bucket_id: '44' })],
      }),
    );
    expect(running.batches.map((batch) => batch.status)).toEqual(['injected', 'pending']);
    const queued = buildInvocationChat(invocation({ state: 'queued', started_at: null, finished_at: null }));
    expect(queued.batches.map((batch) => [batch.status, batch.at])).toEqual([['pending', t(0)]]);
  });

  test('send_reply is one reply with every part and every delivery; a rejected send still shows', () => {
    const chat = buildInvocationChat(
      invocation({
        tool_calls: [
          tool(
            '1',
            'send_reply',
            { parts: [{ kind: 'sticker', sticker_ref: 'stk_1' }, { text: 'and words' }], reply_to_message_id: 901 },
            t(5),
          ),
          tool('2', 'send', { text: 'blocked' }, t(6), { state: 'error', error_code: 'send_rate_limited' }),
        ],
        telegram_sends: [send('s1', 'call_1', '902'), send('s9', 'call_9', '950'), send('s2', 'call_1', '903')],
      }),
    );
    const replies = chat.batches[0]?.items.filter((item) => item.kind === 'reply') ?? [];
    expect(replies.map((item) => (item.kind === 'reply' ? item.sends.map((entry) => entry.id) : null))).toEqual([
      ['s1', 's2'],
      [],
    ]);
    expect(outline(chat).slice(1)).toEqual(['0 reply stk_1 + and words', '1 reply blocked']);
    const first = replies[0];
    expect(first?.kind === 'reply' ? first.parts[0] : null).toMatchObject({
      kind: 'sticker',
      reply_to_message_id: '901',
    });
  });

  test('steps name skills and capabilities; malformed arguments degrade to the tool name', () => {
    const chat = buildInvocationChat(
      invocation({
        model_calls: [model('m1', t(2), { state: 'error', error_code: 'provider_timeout' })],
        agent_messages: [
          agent(1, 'assistant', '', t(3), 'chain of thought'),
          agent(2, 'harness_nudge', 'use send', t(4)),
          agent(3, 'tool_result', 'result', t(5)),
        ],
        tool_calls: [
          tool('1', 'read', { uri: 'mcp-skill://docs/search/SKILL.md' }, t(6)),
          tool('2', 'read', { uri: 'system:///manual/index.md' }, t(7)),
          tool('3', 'execute', { action: 'search', query: 'weather' }, t(8)),
          tool('4', 'execute', { action: 'help', tool: 'web_fetch' }, t(9)),
          tool('5', 'execute', 'not json{', t(10)),
          tool('6', 'docs__lookup', {}, t(11)),
        ],
      }),
    );
    const steps = chat.batches[0]?.items[0];
    if (steps?.kind !== 'steps') {
      throw new Error('expected one step group');
    }
    expect(steps.steps.map((step) => [step.action, step.secondary])).toEqual([
      [{ kind: 'model_call', failed: true }, false],
      [{ kind: 'private_text' }, false],
      [{ kind: 'nudge' }, false],
      [{ kind: 'tool_result' }, true],
      [{ kind: 'skill', name: 'docs/search' }, false],
      [{ kind: 'tool', name: 'read' }, false],
      [{ kind: 'tool_search', query: 'weather' }, false],
      [{ kind: 'tool_help', name: 'web_fetch' }, false],
      [{ kind: 'tool', name: 'execute' }, false],
      [{ kind: 'tool', name: 'docs__lookup' }, false],
    ]);
    expect(steps.summary).toEqual({ tools: 5, skills: 1, failedModelCalls: 1, privateTexts: 1 });
  });

  test('a step group keeps its key while a running invocation appends to it', () => {
    const base = {
      model_calls: [model('m1', t(2))],
      tool_calls: [tool('1', 'read', { uri: 'system:///skills/a/SKILL.md' }, t(3))],
    };
    const before = buildInvocationChat(invocation(base));
    const after = buildInvocationChat(
      invocation({ ...base, tool_calls: [...base.tool_calls, tool('2', 'zzz', {}, t(4))] }),
    );
    const key = (chat: InvocationChat): string | null => {
      const item = chat.batches[0]?.items[0];
      return item?.kind === 'steps' ? item.key : null;
    };
    expect(key(before)).not.toBeNull();
    expect(key(after)).toBe(key(before));
  });

  test('unparseable timestamps never throw and keep activity in the opening batch', () => {
    const chat = buildInvocationChat(
      invocation({
        buckets: [bucket('42', 'garbage', 'garbage'), bucket('43', t(10), t(20))],
        tool_calls: [tool('1', 'send', { text: 'when?' }, 'not a date')],
      }),
    );
    expect(chat.batches[0]?.bucketId).toBe('42');
    expect(chat.batches[0]?.items.map((item) => item.kind)).toEqual(['reply']);
  });
});
