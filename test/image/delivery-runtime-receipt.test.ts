import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import {
  finished,
  fixture,
  installImageDeliveryHooks,
  queryReceipts,
  RECEIPT_MARKER,
  retainedContext,
  textOf,
  update,
} from './delivery-runtime-fixtures.ts';

installImageDeliveryHooks();

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
