import { afterAll, describe, expect, test } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { KeyedSemaphore } from '../src/platform/concurrency.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { cleanupTestDirectories, insertAlarm, setup, update } from './alarm-fixtures.ts';
import { fauxRegistry, testTelegramRuntime } from './helpers.ts';

afterAll(async () => {
  await cleanupTestDirectories();
}, 30_000);

describe('alarm runtime budget bypass', () => {
  test('an alarm invocation bypasses the daily token gate while an ordinary invocation still blocks', async () => {
    const faux = fauxProvider({
      provider: 'agent',
      models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
    });
    const { store, ingestion, scheduler, loaded, configStore } = await setup(fauxRegistry(faux));
    // Real-clock-relative dates: the runtime anchors a batch's collection window
    // to the instant the agent becomes free, so a test that drives ingestion with
    // frozen dates in the past would compare fake instants against real ones.
    const start = Date.now();
    const received = new Date(start);
    ingestion.ingest(update(1, 10, 'hello'), received);
    const conversation = store.db.prepare<[], { id: bigint }>('SELECT id FROM conversations').get();
    if (conversation === undefined) {
      throw new Error('Expected conversation');
    }
    // Exhaust the daily token budget for the real UTC date.
    const today = new Date().toISOString().slice(0, 10);
    store.db
      .prepare(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', ?, ?) ON CONFLICT(utc_date, scope, resource, metric) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at",
      )
      .run(today, '123456789', BigInt(loaded.config.agent!.daily_budget!.max_tokens), new Date().toISOString());

    insertAlarm(store, conversation.id, new Date(start - 60_000).toISOString());
    const [alarmInvocation] = scheduler.processTasksDue(new Date(start));
    if (alarmInvocation === undefined) {
      throw new Error('Expected alarm invocation');
    }

    faux.setResponses([
      fauxAssistantMessage('followed up'),
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
      bot: { id: 999n, displayName: 'Plastic Wan', username: 'plasticwan' },
      modelGate: new KeyedSemaphore(),
      systemResources: emptySystemResources(),
    });
    expect(await runtime.run(alarmInvocation, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'completed',
      reason: 'completed',
    });

    // Release the alarm invocation so the same chat can schedule a normal bucket.
    store.db
      .prepare("UPDATE invocations SET state = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), alarmInvocation);
    store.db
      .prepare(
        "UPDATE buckets SET state = 'completed', finished_at = ? WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)",
      )
      .run(new Date().toISOString(), alarmInvocation);
    ingestion.ingest(update(2, 11, 'next'), new Date(start));
    // The alarm run re-anchored the collecting batch to its round end, so the
    // batch is due one bucket window after that: ask for a moment past it.
    const [normalInvocation] = scheduler.processDue(
      new Date(Math.max(Date.now(), start) + loaded.config.telegram.bucket_window_seconds * 1_000 + 1_000),
    );
    if (normalInvocation === undefined) {
      throw new Error('Expected normal invocation');
    }
    expect(await runtime.run(normalInvocation, configStore.beginInvocation(), new AbortController().signal)).toEqual({
      state: 'failed',
      reason: 'daily_token_budget',
    });
    store.close();
  });
});
