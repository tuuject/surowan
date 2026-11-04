import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { ConversationContextStore } from '../../src/context/store/index.ts';
import { AGENT_MODEL, SECOND_MODEL, contextRows, logEvents, runDirect, setup, textUpdate } from './reload-fixtures.ts';

/**
 * The reported production failure: lowering a model's `context_window` in the
 * Admin Panel left the existing continuous Context in place, so the next run
 * seeded a transcript that no longer fit the new window and kept going until
 * `/cut_topic` truncated the chat history. The budget is persisted with the
 * Context, and a run that finds it changed rebuilds from the stored chat
 * messages instead.
 */
test('a lowered context window rebuilds the oversized Context from chat history', async () => {
  const fixture = await setup({
    transform: (config) => {
      const provider = config.providers.faux;
      if (provider?.kind !== 'builtin') {
        throw new Error('Expected the faux builtin provider fixture');
      }
      const agent = provider.models.find((entry) => entry.id === AGENT_MODEL);
      if (agent === undefined) {
        throw new Error('Expected the agent model fixture');
      }
      agent.context_window = 1_048_576;
      agent.max_tokens = 32_768;
    },
  });
  try {
    const faux = fauxProvider({
      provider: 'faux',
      models: [
        {
          id: AGENT_MODEL,
          input: ['text', 'image'],
          contextWindow: 1_048_576,
          maxTokens: 32_768,
          reasoning: true,
        },
        { id: SECOND_MODEL, input: ['text'], contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
      ],
    });
    faux.setResponses([fauxAssistantMessage('first answer')]);
    const runtime = fixture.runtimeWith(faux);
    fixture.ingestion.ingest(textUpdate(1, 10, 'first'), new Date());
    const [first] = fixture.scheduler.processDue(new Date(Date.now() + 60_000));
    if (first === undefined) {
      throw new Error('Expected the first invocation');
    }
    expect(await runDirect(fixture, runtime, first)).toEqual({ state: 'completed', reason: 'completed' });

    const conversationId = fixture.store.db
      .prepare<[bigint], { conversation_id: bigint }>('SELECT conversation_id FROM invocations WHERE id = ?')
      .get(first)?.conversation_id;
    if (conversationId === undefined) {
      throw new Error('Expected a conversation');
    }
    const contexts = new ConversationContextStore(fixture.store);
    const header = contexts.header(conversationId);
    if (header === undefined) {
      throw new Error('Expected a context header');
    }
    expect(header.contextWindow).toBe(1_048_576n);
    // Simulate a long accumulation under the old window. This row exists only
    // in the canonical transcript; the chat history does not contain it.
    contexts.append(header, {
      invocationId: null,
      isCheckpoint: true,
      estTokens: 500_000,
      json: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'ancient retained history' }] }),
      role: 'user',
    });

    await fixture.patch((config) => {
      const provider = config.providers.faux;
      if (provider?.kind !== 'builtin') {
        throw new Error('Expected the faux builtin provider fixture');
      }
      const agent = provider.models.find((entry) => entry.id === AGENT_MODEL);
      if (agent === undefined) {
        throw new Error('Expected the agent model fixture');
      }
      agent.context_window = 262_144;
      agent.max_tokens = 32_768;
    });
    const reloaded = await fixture.reloader.reloadFromFile();
    expect(reloaded.ok).toBe(true);
    expect(fixture.configStore.current().models.getModel('faux', AGENT_MODEL)?.contextWindow).toBe(262_144);

    let secondPrompt = '';
    faux.setResponses([
      (context) => {
        secondPrompt = JSON.stringify(context.messages);
        return fauxAssistantMessage('second answer');
      },
    ]);
    fixture.ingestion.ingest(textUpdate(2, 11, 'second'), new Date(Date.now() + 120_000));
    const [second] = fixture.scheduler.processDue(new Date(Date.now() + 180_000));
    if (second === undefined) {
      throw new Error('Expected the second invocation');
    }
    expect(await runDirect(fixture, runtime, second)).toEqual({ state: 'completed', reason: 'completed' });

    expect(logEvents('context_rebuilt').some((event) => event.reason === 'context_window')).toBe(true);
    // The oversized transcript is gone, the persisted chat history is not.
    expect(secondPrompt).not.toContain('ancient retained history');
    expect(secondPrompt).toContain('first');
    expect(secondPrompt).toContain('second');
    expect(contextRows(fixture.store).some((row) => row.payload_json.includes('ancient retained history'))).toBe(false);
    expect(contexts.header(conversationId)?.contextWindow).toBe(262_144n);
  } finally {
    fixture.store.close();
  }
}, 30_000);
