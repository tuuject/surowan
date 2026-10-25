import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { decodeContextMessage, encodeContextMessage, estimateMessageTokens } from '../../src/context/codec.ts';
import { assistantText } from './store-fixtures.ts';

describe('context codec', () => {
  test('round-trips a tool call with its arguments and thinking signature', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning here', thinkingSignature: 'sig-1' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'send',
          arguments: { kind: 'text', text: 'hello', nested: { a: [1, 2] } },
        },
      ],
      api: 'openai-responses',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
      stopReason: 'toolUse',
      timestamp: 1_700_000_000_000,
    };
    const encoded = encodeContextMessage(message);
    expect(encoded?.role).toBe('assistant');
    const decoded = decodeContextMessage(encoded?.json ?? '');
    expect(decoded).toEqual(message);
    expect(estimateMessageTokens(message)).toBeGreaterThan(0);
  });

  test('round-trips provider usage counters the schema does not enumerate', () => {
    // Regression: the decoder used to accept only five usage counters, so the
    // moment a provider reported another one (OpenRouter sends `reasoning`, and
    // Anthropic a `cacheWrite1h` split) every stored assistant message of that
    // conversation became undecodable. Seeding then threw before the first model
    // call, and each later invocation failed within milliseconds until a human
    // cleared the history.
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'as reported by the provider' }],
      api: 'openai-completions',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 3,
        output: 40,
        cacheRead: 0,
        cacheWrite: 15565,
        cacheWrite1h: 12,
        reasoning: 0,
        totalTokens: 15608,
        cost: { input: 0.0000003, output: 0.000024, cacheRead: 0, cacheWrite: 0.001945625, total: 0.001969925 },
      },
      stopReason: 'stop',
      timestamp: 1_700_000_000_000,
    };
    const json = encodeContextMessage(message)?.json ?? '';
    expect(json).toContain('"reasoning":0');
    expect(decodeContextMessage(json)).toEqual(message);
  });

  test('rejects a stored row whose shape really is broken', () => {
    // The tolerance above is limited to provider-reported metadata: a row that is
    // missing what the transcript needs must still fail loudly.
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'agent-api',
      provider: 'agent',
      model: 'agent-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    };
    const parsed = JSON.parse(encodeContextMessage(message)?.json ?? '{}') as Record<string, unknown>;
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, timestamp: undefined }))).toThrow(
      'does not match its schema',
    );
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, role: 'assistant' }))).not.toThrow();
    expect(() => decodeContextMessage(JSON.stringify({ ...parsed, content: [{ type: 'image', data: 'AA' }] }))).toThrow(
      'does not match its schema',
    );
  });

  test('round-trips a tool result and drops inline image blocks', () => {
    const message: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read_image',
      content: [
        { type: 'text', text: 'A cat.' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      details: { cached: true },
      isError: false,
      timestamp: 1_700_000_000_500,
    };
    const decoded = decodeContextMessage(encodeContextMessage(message)?.json ?? '');
    expect(decoded.role).toBe('toolResult');
    if (decoded.role !== 'toolResult') {
      throw new Error('Expected a tool result');
    }
    // Attachments are batch-scoped; replaying base64 on every request would
    // blow up the context and contradict on-demand history reads.
    expect(decoded.content).toEqual([{ type: 'text', text: 'A cat.' }]);
    expect(decoded.details).toEqual({ cached: true });
  });

  test('filters aborted, error, and empty assistant messages', () => {
    const aborted = assistantText('partial');
    if (aborted.role !== 'assistant') {
      throw new Error('Fixture is not an assistant message');
    }
    expect(encodeContextMessage({ ...aborted, stopReason: 'aborted' })).toBeUndefined();
    expect(encodeContextMessage({ ...aborted, stopReason: 'error' })).toBeUndefined();
    expect(encodeContextMessage(assistantText('   '))).toBeUndefined();
    expect(encodeContextMessage({ role: 'user', content: [], timestamp: 1 })).toBeUndefined();
    expect(encodeContextMessage({ role: 'user', content: 'hello', timestamp: 1 })?.role).toBe('user');
  });
});
