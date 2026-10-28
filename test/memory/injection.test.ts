import { afterAll, expect, test } from 'vitest';
import { MemoryStore } from '../../src/context/memory.ts';
import { renderInvocationContext } from '../helpers.ts';
import { cleanupDirectories, fixture, secondConversation } from './helpers.ts';

afterAll(cleanupDirectories);

test('the injected batch carries active memories in creation order', async () => {
  const { store, loaded, conversationId, invocationId } = await fixture();
  try {
    const memory = new MemoryStore(store.orm);
    // Relative to the real clock: rendering filters memories against the current
    // time, so a fixed calendar date made this test fail once that date plus the TTL
    // passed (it started failing exactly 30 days after 2026-08-15).
    const now = new Date(Date.now() - 120_000);
    const first = memory.add(conversationId, 'first note <escaped> & "quoted" \'single\'', 30 * 86_400, now);
    const second = memory.add(conversationId, 'second note', 30 * 86_400, new Date(now.getTime() + 5_000));
    // Created two minutes ago with a one-minute TTL: already expired.
    memory.add(conversationId, 'short note', 60, now);
    memory.add(secondConversation(store, conversationId), 'other conversation note', 30 * 86_400, now);

    const context = renderInvocationContext(store, loaded.config, invocationId, {
      contextWindow: 200_000,
      maxOutputTokens: 32768,
    });
    // Memories change per invocation, so they travel with the injected batch:
    // the system prompt has to stay byte-identical for the whole context.
    expect(context.systemPrompt).not.toContain('<memory_list>');
    expect(context.userPrompt).toContain('<memory_list>');
    const firstIndex = context.userPrompt.indexOf(
      `- ${first.id}: first note &lt;escaped&gt; &amp; &quot;quoted&quot; &apos;single&apos;`,
    );
    const secondIndex = context.userPrompt.indexOf(`- ${second.id}: second note`);
    expect(firstIndex).toBeGreaterThan(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(context.userPrompt).not.toContain('short note');
    expect(context.userPrompt).not.toContain('other conversation note');
    // The current time is per-batch state too, and the untrusted batch follows
    // the trusted runtime_state block.
    expect(context.userPrompt.indexOf('current_time: ')).toBeGreaterThan(0);
    expect(context.userPrompt.indexOf('current_time: ')).toBeLessThan(
      context.userPrompt.indexOf('<untrusted_new_messages>'),
    );
  } finally {
    store.close();
  }
});
