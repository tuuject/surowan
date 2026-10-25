import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSchema } from '@surowan/image-service';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { createSendTool } from '../../src/capabilities/send/index.ts';
import type { TelegramTransport } from '../../src/adapters/local-monolith/telegram/host.ts';
import { invocations, media, messages, hostSends, toolCalls } from '../../src/store/schema/index.ts';
import { testSendToolEnv } from '../helpers.ts';
import { installImageAgentHooks, fixture, submitFixtureWork, waitFor } from './agent-fixtures.ts';

// ---------------------------------------------------------------------------
// M4 (delivery): the send tool delivers the pictures of a generation that
// belongs to the asking conversation — and only that one.
// ---------------------------------------------------------------------------

installImageAgentHooks();

test('send kind:image delivers finished outputs of a generation owned by this conversation', async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef);
  const db = drizzle(fixtureRef.store.db, { schema: imageSchema });
  await waitFor(() => {
    const row = db.select().from(imageSchema.generations).where(eq(imageSchema.generations.id, generationId)).get();
    return row?.status === 'succeeded' ? true : null;
  });
  const outputs = fixtureRef.bridge.sendableOutputs(generationId, 42n);
  expect(outputs).toHaveLength(1);
  expect(fixtureRef.bridge.assetContent(outputs?.[0]?.asset_id ?? '')?.mime).toBe('image/png');

  const sent: { chatId: string; fileName: string }[] = [];
  const api: TelegramTransport = {
    sendMessage: async () => ({ message_id: 1, date: 0, chat: { id: 100 } }),
    sendSticker: async () => ({ message_id: 2, date: 0, chat: { id: 100 } }),
    sendGeneratedPhoto: async (chatId, _bytes, fileName) => {
      sent.push({ chatId, fileName });
      return {
        message_id: 500,
        date: 0,
        chat: { id: 100 },
        photo: [{ file_id: 'sent-photo-1', file_unique_id: 'uniq-1', width: 512, height: 512 }],
      };
    },
    sendGeneratedPhotoGroup: async (chatId, pictures) => {
      pictures.forEach((picture) => {
        sent.push({ chatId, fileName: picture.fileName });
      });
      return [
        {
          message_id: 500,
          date: 0,
          chat: { id: 100 },
          photo: [{ file_id: 'sent-photo-1', file_unique_id: 'uniq-1', width: 512, height: 512 }],
        },
      ];
    },
  };
  const sendContext = {
    invocationId: 7n,
    conversationId: 42n,
    hostKind: 'telegram' as const,
    chatId: 100n,
    threadId: 0n,
    systemPrompt: '',
    userPrompt: '',
    directImages: [],
    visibleSenders: new Map(),
    callerUserId: 1n,
    completion: null,
    omittedNewMessages: 0,
  } as Parameters<typeof createSendTool>[0]['context'];
  const send = createSendTool({
    store: fixtureRef.store,
    ...testSendToolEnv(api, sendContext),
    context: sendContext,
    capabilities: {
      resolveMedia: () => undefined,
      resolveStickerRef: () => undefined,
      resolveReplyTarget: () => undefined,
      registerStickerRef: () => 'stk_x',
    },
    sendRateLimit: { sendsPerWindow: 10, windowSeconds: 60 },
    maxTextLength: 4096,
    disallowBlankLines: false,
    deadline: Date.now() + 60_000,
    bot: { id: 777n, displayName: 'bot', username: 'bot' },
    imageGeneration: {
      resolve: (id, conversationId) => {
        const out = fixtureRef.bridge.sendableOutputs(id, conversationId)?.map((output) => {
          const content = fixtureRef.bridge.assetContent(output.asset_id);
          return { assetId: output.asset_id, bytes: content.bytes, fileName: output.file_name, mime: content.mime };
        });
        return out;
      },
    },
  });
  const result = await send.execute?.(
    'call-send-1',
    { kind: 'image', image_generation_id: generationId, text: '画好了' },
    new AbortController().signal,
  );
  expect(sent).toHaveLength(1);
  expect(result?.details.telegramMessageId).toBe('500');

  // Delivery is audited: kind image, the owning conversation, and a bot photo
  // media row so later rounds can reference the delivered picture.
  const db2 = drizzle(fixtureRef.store.db, { schema: imageSchema });
  const sendRow = db2.select().from(hostSends).where(eq(hostSends.kind, 'image')).get();
  expect(sendRow?.state).toBe('success');
  const messageRow = fixtureRef.store.orm.select().from(messages).where(eq(messages.sentByBot, true)).get();
  expect(messageRow).toBeDefined();
  const mediaRow = fixtureRef.store.orm.select().from(media).where(eq(media.kind, 'photo')).get();
  expect(mediaRow).toBeDefined();

  // A later output whose file disappeared must not be silently omitted, making
  // the already-delivered first picture look like the whole generation.
  const missing = await fixtureRef.service.core.images.create({
    name: 'later-output',
    base64: (
      await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer()
    ).toString('base64'),
    mime: 'image/png',
    description: '',
    category: '',
    source: 'generation',
    generationId,
    outputIndex: 1,
  });
  const missingRow = db.select().from(imageSchema.images).where(eq(imageSchema.images.id, missing.id)).get();
  if (missingRow === undefined) {
    throw new Error('Expected stored output');
  }
  await rm(join(fixtureRef.service.imageDir, missingRow.fileName));
  expect(fixtureRef.bridge.sendableOutputs(generationId, 42n)).toHaveLength(2);
  await expect(send.execute('call-send-missing', { kind: 'image', image_generation_id: generationId })).rejects.toThrow(
    'image_generation_unavailable',
  );
  expect(sent).toHaveLength(1);
  expect(fixtureRef.store.orm.select().from(hostSends).all()).toHaveLength(1);
  expect(
    fixtureRef.store.orm.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'call-send-missing')).get(),
  ).toMatchObject({
    state: 'error',
    errorCode: 'image_generation_unavailable',
  });
  expect(fixtureRef.store.orm.select({ sendsUsed: invocations.sendsUsed }).from(invocations).get()).toEqual({
    sendsUsed: 1n,
  });
});

test("a foreign conversation cannot deliver another conversation's generation", async () => {
  const fixtureRef = await fixture();
  const generationId = await submitFixtureWork(fixtureRef, { conversationId: 42n });
  await waitFor(() => {
    const row = drizzle(fixtureRef.store.db, { schema: imageSchema })
      .select()
      .from(imageSchema.generations)
      .where(eq(imageSchema.generations.id, generationId))
      .get();
    return row?.status === 'succeeded' ? true : null;
  });
  expect(fixtureRef.bridge.sendableOutputs(generationId, 99n)).toBeUndefined();
  expect(fixtureRef.bridge.sendableOutputs(generationId, 42n)).not.toBeUndefined();
});
