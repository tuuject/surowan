import { invocations, buckets } from '../../src/store/schema/index.ts';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { sql, eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import { TelegramIngestion } from '../../src/ingress/telegram-ingestion/index.ts';
import { AgentRuntime } from '../../src/orchestration/agent-runtime/index.ts';
import { BucketScheduler } from '../../src/orchestration/scheduler/index.ts';
import { SecretStore } from '../../src/platform/secrets.ts';
import { emptySystemResources } from '../../src/platform/system-resources.ts';
import { fauxRegistry, testConfigStore, testTelegramRuntime } from '../helpers.ts';
import { imageFixture } from '../mcp/image-fixtures.ts';

/** Real runtime + stdio MCP + disk history; no Telegram sends or paid model calls. */
test('runtime reloads MCP pixels from disk after cache recreation and preserves error/call audit', async () => {
  const f = await imageFixture();
  const faux = fauxProvider({
    provider: 'agent',
    models: [{ id: 'agent-model', input: ['text', 'image'], contextWindow: 200_000, maxTokens: 32_768 }],
  });
  const configStore = await testConfigStore(f.loaded, fauxRegistry(faux));
  const runtimeFor = (store: SqliteStore) =>
    new AgentRuntime({
      store,
      configStore,
      secrets: new SecretStore(),
      ...testTelegramRuntime({
        sendMessage: async () => {
          throw new Error('No external sends in this test');
        },
        sendSticker: async () => {
          throw new Error('No external sends in this test');
        },
      }),
      bot: { id: 999n, displayName: 'Surowan', username: 'surowan' },
      systemResources: emptySystemResources(),
      additionalTools: (context, deadline) => f.manager.createTools(context, deadline),
    });
  const nextInvocation = (store: SqliteStore, id: number) => {
    const received = new Date(Date.now() + id * 30_000);
    new TelegramIngestion(store, configStore, { id: 999 }).ingest(
      {
        update_id: id + 100,
        message: {
          message_id: id + 100,
          date: Math.floor(received.getTime() / 1000),
          chat: { id: 123456789, type: 'private', first_name: 'Test' },
          from: { id: 42, is_bot: false, first_name: 'Test' },
          text: 'Use the tool image; do not send any messages.',
        },
      },
      received,
    );
    const scheduler = new BucketScheduler(store, configStore, async () => ({ state: 'completed', reason: 'done' }));
    const [invocationId] = scheduler.processDue(new Date(received.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected invocation');
    }
    return invocationId;
  };
  let imageData: string[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('local__images', { error: true }, { id: 'runtime_image_call' }), {
      stopReason: 'toolUse',
    }),
    (context) => {
      const result = context.messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === 'runtime_image_call',
      );
      if (result?.role !== 'toolResult') {
        throw new Error('Missing MCP result');
      }
      expect(result.isError).toBe(true);
      imageData = result.content.filter((block) => block.type === 'image').map((block) => block.data);
      expect(imageData).toHaveLength(2);
      return fauxAssistantMessage('');
    },
  ]);
  const firstId = nextInvocation(f.store, 1);
  expect(await runtimeFor(f.store).run(firstId, configStore.beginInvocation(), new AbortController().signal)).toEqual({
    state: 'completed',
    reason: 'completed',
  });
  // In production the scheduler commits this outcome after AgentRuntime returns.
  const firstRow = f.store.orm.select().from(invocations).where(eq(invocations.id, firstId)).get()!;
  f.store.orm
    .update(invocations)
    .set({ state: 'completed', finishedAt: new Date().toISOString() })
    .where(eq(invocations.id, firstId))
    .run();
  f.store.orm.update(buckets).set({ state: 'completed' }).where(eq(buckets.id, firstRow.bucketId)).run();
  const stored = f.store.orm.all<{ payload_json: string }>(
    sql`SELECT payload_json FROM context_messages WHERE role = 'toolResult'`,
  );
  expect(stored).toHaveLength(1);
  for (const data of imageData) {
    expect(stored[0]?.payload_json).not.toContain(data);
  }
  expect(
    f.store.orm.get<{ tool_call_id: string }>(
      sql`SELECT tool_call_id FROM agent_messages WHERE role = 'tool_result' ORDER BY id DESC LIMIT 1`,
    )?.tool_call_id,
  ).toBe('runtime_image_call');
  await f.manager.stop();
  await f.server.stop();
  f.store.close();
  const reopened = await SqliteStore.open(f.loaded.config);
  try {
    faux.setResponses([
      (context) => {
        const result = context.messages.find(
          (message) => message.role === 'toolResult' && message.toolCallId === 'runtime_image_call',
        );
        if (result?.role !== 'toolResult') {
          throw new Error('Restart lost the result');
        }
        expect(result.content.filter((block) => block.type === 'image').map((block) => block.data)).toEqual(imageData);
        return fauxAssistantMessage('');
      },
    ]);
    await runtimeFor(reopened).run(
      nextInvocation(reopened, 2),
      configStore.beginInvocation(),
      new AbortController().signal,
    );
    expect(faux.state.callCount).toBe(3);
  } finally {
    reopened.close();
  }
});
