import type { Agent } from '@earendil-works/pi-agent-core';
import { expect, test } from 'vitest';
import type { ContextHeader } from '../src/context/store.ts';
import { ConversationRuntime } from '../src/orchestration/conversation-runtime.ts';

function remember(runtime: ConversationRuntime, conversationId: bigint): void {
  runtime.remember({
    conversationId,
    agent: {} as Agent,
    header: {} as ContextHeader,
    transcriptSeqs: [],
    systemPromptHash: 'hash',
    lastUsedAt: 0,
  });
}

test('the agent cache bound is read on every eviction pass', () => {
  let size = 3;
  const runtime = new ConversationRuntime({ agentCacheSize: () => size });
  for (const id of [1n, 2n, 3n]) {
    remember(runtime, id);
  }
  expect(runtime.cachedAgentCount).toBe(3);
  // A reloaded, smaller bound evicts down to it on the next cached agent.
  size = 1;
  remember(runtime, 4n);
  expect(runtime.cachedAgentCount).toBe(1);
  expect(runtime.cachedAgent(4n)).toBeDefined();
  expect(runtime.evictedAgentCount).toBe(3);
});
