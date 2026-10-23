import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import {
  ALREADY_DELIVERED,
  detailsOf,
  FIRST_PHOTO_MESSAGE_ID,
  finished,
  fixture,
  installImageDeliveryHooks,
  queryImageSends,
  queryReceipts,
  querySendToolCalls,
  RECEIPT_MARKER,
  retainedContext,
  sendImage,
  textOf,
  update,
} from './image-delivery-runtime-fixtures.ts';

installImageDeliveryHooks();

test('a completion receipt round rejects resend:true and replays the delivered generation instead', async () => {
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
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      // Receipt round: resend:true is a user-resolved action, not a
      // receipt-driven retry, so it must not deliver the picture again.
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-resend', { resend: true });
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return sendImage('call-send-2');
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
  expect(queryImageSends(f.store)).toHaveLength(1);
  const calls = querySendToolCalls(f.store);
  expect(calls.map(({ tool_call_id, state }) => ({ tool_call_id, state }))).toEqual([
    { tool_call_id: 'call-send-1', state: 'success' },
    { tool_call_id: 'call-send-resend', state: 'error' },
    { tool_call_id: 'call-send-2', state: 'success' },
  ]);
  expect(calls[0]!.side_effect).toBe(1n);
  expect(calls[1]!.error_code).not.toBeNull();
  expect(calls[2]!.side_effect).toBe(0n);
  expect(calls[2]!.result_text ?? '').toMatch(ALREADY_DELIVERED);

  const context = retainedContext(f.store, 1n);
  const results = context.messages.flatMap(({ seq, message }) =>
    message.role === 'toolResult' && message.toolName === 'send' ? [{ seq, message }] : [],
  );
  expect(results).toHaveLength(3);
  expect(results[1]!.message.isError).toBe(true);
  expect(textOf(results[1]!.message.content)).toMatch(/resend/i);
  expect(detailsOf(results[2]!.message)).toMatchObject({ replayed: true });
  expect(
    f.store.db
      .prepare<[], { send_count_total: bigint }>(
        'SELECT send_count_total FROM conversation_contexts WHERE conversation_id = 1',
      )
      .get(),
  ).toEqual({ send_count_total: 1n });
  expect(
    f.store.db
      .prepare<[], { seq: bigint; send_seq: bigint }>(
        'SELECT seq, send_seq FROM context_messages WHERE send_seq IS NOT NULL ORDER BY seq',
      )
      .all(),
  ).toEqual([{ seq: results[0]!.seq, send_seq: 1n }]);
});

test('an ordinary completion receipt does not carry image_delivery', async () => {
  const f = await fixture();
  f.faux.setResponses([
    () => {
      const scope = f.tasks.scoped('exporter', 1n);
      const task = scope.create({ payload: { name: 'Alice' } });
      scope.complete(task.taskId, { result: 'ordinary-result' });
      f.scheduler.processTasksDue();
      return fauxAssistantMessage('ordinary round done');
    },
    (context) => {
      f.requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('receipt round done');
    },
  ]);
  f.ingestion.ingest(update(1, 'ordinary request'));
  f.scheduler.start();
  await finished(f, 1n);

  expect(f.faux.getPendingResponseCount()).toBe(0);
  const receipts = queryReceipts(f.store);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ state: 'handled', invocation_outcome: 'completed' });
  const context = retainedContext(f.store, 1n);
  const receiptTexts = context.messages.flatMap(({ message }) =>
    message.role === 'user' && textOf(message.content).includes(RECEIPT_MARKER) ? [textOf(message.content)] : [],
  );
  expect(receiptTexts).toHaveLength(1);
  expect(receiptTexts[0]).toContain('ordinary-result');
  expect(receiptTexts[0]).not.toContain('image_delivery');
});
