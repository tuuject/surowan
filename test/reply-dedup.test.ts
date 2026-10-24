import { getCurrentTools, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { AgentRuntime } from '../src/orchestration/agent-runtime.ts';
import { invocations } from '../src/store/schema.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { emptySystemResources } from '../src/platform/system-resources.ts';
import { fauxRegistry, testTelegramRuntime } from './helpers.ts';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  imageGeneration,
  makeTool,
  processOne,
  sendAudit,
  sendsUsed,
  setup,
  toolAudit,
  update,
  type SendArgs,
} from './reply-dedup-fixtures.ts';

describe('reply deduplication', () => {
  const matrix: {
    readonly name: string;
    readonly first: (stickerRef: string) => SendArgs;
    readonly second: (stickerRef: string) => SendArgs;
  }[] = [
    {
      name: 'changed text content',
      first: () => ({ kind: 'text', text: 'first answer', reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'a different answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a sticker after a text reply',
      first: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
      second: (stickerRef) => ({ kind: 'sticker', sticker_ref: stickerRef, reply_to_message_id: '10' }),
    },
    {
      name: 'a text after a sticker reply',
      first: (stickerRef) => ({ kind: 'sticker', sticker_ref: stickerRef, reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a generated image after a text reply',
      first: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
      second: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
    },
    {
      name: 'a text after a generated image reply',
      first: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
      second: () => ({ kind: 'text', text: 'answer', reply_to_message_id: '10' }),
    },
    {
      name: 'a resend:true image after an image reply to the same message',
      first: () => ({ kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' }),
      second: () => ({ kind: 'image', image_generation_id: 'gen-2', resend: true, reply_to_message_id: '10' }),
    },
  ];

  test.each(matrix.flatMap((entry) => [undefined, false, true].map((allow) => ({ ...entry, allow }))))(
    'applies allow_reply_message_multiple_times=$allow to $name',
    async ({ first, second, allow }) => {
      const fixture = await setup(undefined, allow);
      try {
        const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
        const api = countingApi();
        const { tool, capabilities } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
        expect(tool.description.includes('at most one reply')).toBe(allow !== true);
        const stickerRef = capabilities.registerStickerRef('CAAD-fake-sticker');
        const firstResult = await tool.execute('first', first(stickerRef));
        expect(firstResult.details.telegramMessageId).toBeTruthy();
        if (allow === true) {
          await tool.execute('second', second(stickerRef));
          expect(toolAudit(fixture.store)).toEqual([
            { tool_call_id: 'first', state: 'success', error_code: null },
            { tool_call_id: 'second', state: 'success', error_code: null },
          ]);
        } else {
          await expectRejected(tool, 'second', second(stickerRef));
          expect(errorCodeOf(fixture.store, 'second')).toBe('reply_already_sent');
        }
        const expectedSends = allow === true ? 2 : 1;
        expect(api.calls).toBe(expectedSends);
        expect(sendAudit(fixture.store)).toEqual(
          Array.from({ length: expectedSends }, () => ({
            state: 'success',
            error_code: null,
            request_json: expect.stringContaining('"10"'),
          })),
        );
        expect(sendsUsed(fixture.store, context.invocationId)).toBe(BigInt(expectedSends));
      } finally {
        fixture.close();
      }
    },
  );

  test('runtime freezes reply policy per invocation and applies changes to the next one', async () => {
    const fixture = await setup(undefined, false);
    try {
      const faux = fauxProvider({
        provider: 'agent',
        models: [{ id: 'agent-model', input: ['text'], contextWindow: 200_000, maxTokens: 128 }],
      });
      fixture.configStore.publish({ ...fixture.configStore.current(), ...fauxRegistry(faux) });
      const api = countingApi();
      const runtime = new AgentRuntime({
        store: fixture.store,
        configStore: fixture.configStore,
        secrets: new SecretStore(),
        ...testTelegramRuntime(api),
        bot: { id: 999n, displayName: 'Surowan', username: 'plasticwan' },
        systemResources: emptySystemResources(),
      });
      const t0 = new Date('2026-08-15T00:00:00.000Z');
      fixture.ingestion.ingest(update(1, 10, 'hello'), t0);
      const first = processOne(fixture.scheduler, new Date(t0.getTime() + 15_000));
      faux.setResponses([
        (context) => {
          expect(getCurrentTools(context.messages).find((tool) => tool.name === 'send')?.description).toContain(
            'at most one reply',
          );
          const current = fixture.configStore.current();
          fixture.configStore.publish({
            ...current,
            config: { ...current.config, agent: { ...current.config.agent, allow_reply_message_multiple_times: true } },
          });
          return fauxAssistantMessage(fauxToolCall('send', { text: 'first', reply_to_message_id: '10' }), {
            stopReason: 'toolUse',
          });
        },
        fauxAssistantMessage(fauxToolCall('send', { text: 'duplicate', reply_to_message_id: '10' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ]);
      await runtime.run(first, fixture.configStore.beginInvocation(), new AbortController().signal);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([null, 'reply_already_sent']);
      expect(api.calls).toBe(1);
      fixture.store.db
        .prepare("UPDATE buckets SET state = 'completed' WHERE id = (SELECT bucket_id FROM invocations WHERE id = ?)")
        .run(first);
      fixture.store.orm.update(invocations).set({ state: 'completed' }).where(eq(invocations.id, first)).run();
      const t1 = new Date(t0.getTime() + 60_000);
      fixture.ingestion.ingest(update(2, 11, 'anything else?'), t1);
      const second = processOne(fixture.scheduler, new Date(t1.getTime() + 15_000));
      faux.setResponses([
        (context) => {
          expect(getCurrentTools(context.messages).find((tool) => tool.name === 'send')?.description).toContain(
            'permits multiple replies',
          );
          return fauxAssistantMessage(fauxToolCall('send', { text: 'follow up', reply_to_message_id: '10' }), {
            stopReason: 'toolUse',
          });
        },
        fauxAssistantMessage('done'),
      ]);
      await runtime.run(second, fixture.configStore.beginInvocation(), new AbortController().signal);
      expect(api.calls).toBe(2);
      expect(sendAudit(fixture.store).map((row) => row.state)).toEqual(['success', 'success']);
      expect(sendsUsed(fixture.store, first)).toBe(1n);
      expect(sendsUsed(fixture.store, second)).toBe(1n);
      const identity = fixture.build(second);
      expect(
        runtime
          .sceneToolDefinitions(identity, fixture.configStore.current().config)
          .tools.find((tool) => tool.name === 'send')?.description,
      ).toContain('permits multiple replies');
    } finally {
      fixture.close();
    }
  });
});
