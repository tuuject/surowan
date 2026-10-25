import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import {
  ASSET_ID,
  FIRST_PHOTO_MESSAGE_ID,
  finished,
  fixture,
  imageDeliveryOf,
  installImageDeliveryHooks,
  queryImageSends,
  RECEIPT_MARKER,
  RESENT_PHOTO_MESSAGE_ID,
  retainedContext,
  sendImage,
  textOf,
  UNSENT_ASSET_ID,
  update,
} from './delivery-runtime-fixtures.ts';

installImageDeliveryHooks();

test('a success and an unknown attempt on one asset stay mutually exclusive in the receipt, and an unsent output stays pending', async () => {
  const f = await fixture({ unsentOutputs: [UNSENT_ASSET_ID] });
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      // A user-requested resend starts before the receipt reaches the model and
      // Telegram never confirms it: the asset now has one success and one
      // unknown attempt in the same delivery ledger.
      f.requests.push(JSON.stringify(context.messages));
      f.failNextPhoto();
      return sendImage('call-send-2', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt boundary');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID]);
  expect(queryImageSends(f.store).map(({ state, telegram_message_id }) => ({ state, telegram_message_id }))).toEqual([
    { state: 'success', telegram_message_id: BigInt(FIRST_PHOTO_MESSAGE_ID) },
    { state: 'outcome_unknown', telegram_message_id: null },
  ]);
  expect(JSON.parse(queryImageSends(f.store)[1]!.request_json)).toMatchObject({ asset_ids: [ASSET_ID] });

  // The receipt the model actually read: unknown wins over the earlier success,
  // and the output nothing ever tried to send is still pending.
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(imageDeliveryOf(receiptTexts[0]!)).toEqual({
    delivered_asset_ids: [],
    pending_asset_ids: [UNSENT_ASSET_ID],
    unknown_asset_ids: [ASSET_ID],
  });
  expect(f.requests[4]).toContain(UNSENT_ASSET_ID);
});

test('an unprovable legacy delivery set makes the whole generation unknown instead of delivered', async () => {
  const f = await fixture();
  f.faux.setResponses([
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall('image_generate', { prompt: 'a quiet harbor at dusk' }, { id: 'call-image-1' }),
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-1');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2', { resend: true });
    },
    () => {
      // Migration 027 leaves `asset_ids_unknown` on a pre-`asset_ids` send whose
      // shipped set could not be proven. That uncertainty covers the whole
      // generation, so the earlier success must not read as delivered.
      const legacy = queryImageSends(f.store)[1]!;
      f.store.db
        .prepare(
          "UPDATE host_sends SET request_json = json_set(request_json, '$.asset_ids_unknown', json('true')) WHERE id = ?",
        )
        .run(legacy.id);
      return fauxAssistantMessage('receipt boundary');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'draw me a quiet harbor at dusk'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  expect(f.photoMessageIds).toEqual([FIRST_PHOTO_MESSAGE_ID, RESENT_PHOTO_MESSAGE_ID]);
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(imageDeliveryOf(receiptTexts[0]!)).toEqual({
    delivered_asset_ids: [],
    pending_asset_ids: [],
    unknown_asset_ids: [ASSET_ID],
  });
});
