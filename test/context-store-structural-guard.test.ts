import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { isRenderable } from '../src/context/context-gc.ts';
import { assistantText } from './context-store-fixtures.ts';

describe('structural guard', () => {
  test('accepts a segment that starts with user and closes its tool calls', () => {
    const user: AgentMessage = { role: 'user', content: 'hi', timestamp: 1 };
    const call = assistantText('');
    if (call.role !== 'assistant') {
      throw new Error('Fixture is not an assistant message');
    }
    const withCall: AgentMessage = {
      ...call,
      content: [{ type: 'toolCall', id: 'c1', name: 'send', arguments: {} }],
      stopReason: 'toolUse',
    };
    const result: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'send',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 2,
    };
    expect(isRenderable([user, withCall, result])).toBe(true);
    // A dangling tool call is fine: pi-ai synthesizes a "No result provided".
    expect(isRenderable([user, withCall])).toBe(true);
  });

  test('rejects an orphan tool result and a non-user head', () => {
    const orphan: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'missing',
      toolName: 'send',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 2,
    };
    expect(isRenderable([orphan])).toBe(false);
    expect(isRenderable([assistantText('hello')])).toBe(false);
  });
});
