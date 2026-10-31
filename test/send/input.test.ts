import { expect, test } from 'vitest';
import { conversationContext, countingApi, makeTool, sendAudit, sendsUsed, setup, toolAudit } from './fixtures.ts';

test('a send carrying only a reply target is refused with where the words go, and the corrected send goes out', async () => {
  const fixture = await setup();
  const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
  const api = countingApi();
  const { tool } = makeTool(fixture.store, fixture.config, context, { api });
  // Invocation 7729 in production: kind and text both omitted, retried unchanged.
  const error = await tool.execute('bare-1', { reply_to_message_id: '10' }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain('text is missing');
  expect(message).toContain('put the message itself in text (kind defaults to text)');
  expect(message).toContain('sticker_ref or image_generation_id');
  expect(message).toContain('Plain assistant text is never published');
  const result = await tool.execute('bare-2', { kind: 'text', text: 'hello', reply_to_message_id: '10' });
  expect(result.details).toEqual({ telegramMessageId: '501' });
  expect(api.calls).toBe(1);
  expect(toolAudit(fixture.store)).toEqual([
    { tool_call_id: 'bare-1', state: 'error', error_code: 'send_input_invalid' },
    { tool_call_id: 'bare-2', state: 'success', error_code: null },
  ]);
  expect(sendAudit(fixture.store)).toEqual([{ state: 'success', error_code: null, request_json: expect.any(String) }]);
  expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
  fixture.close();
});
