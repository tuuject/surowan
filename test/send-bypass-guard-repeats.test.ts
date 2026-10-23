import { describe, expect, test } from 'vitest';
import {
  conversationContext,
  installSendBypassGuardHooks,
  makeTools,
  recordingApi,
  setup,
  toolAudit,
} from './send-bypass-guard-fixtures.ts';

installSendBypassGuardHooks();

describe('reply-policy content burn', () => {
  test('an exact repeat of a published reply burns its content', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('repeat', { text: 'first answer', reply_to_message_id: '11' })).rejects.toThrow(
        'send_duplicate',
      );
      await expect(send.execute('omit-target', { text: 'first answer' })).rejects.toThrow('send_bypass');
      await expect(send.execute('retarget', { text: 'first answer', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(rejections).toBe(3);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'send_duplicate',
        'send_bypass',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });

  test('a send_reply repeating a published reply in part 1 burns that part', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send, sendReply } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        sendReply.execute('bundle', { reply_to_message_id: '11', parts: [{ text: 'first answer' }, { text: 'coda' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed. Not sent: send_duplicate');
      await expect(send.execute('omit-target', { text: 'first answer' })).rejects.toThrow('send_bypass');
      expect(rejections).toBe(2);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['answered', null],
        ['bundle', 'send_duplicate'],
        ['bundle:1', 'send_duplicate'],
        ['omit-target', 'send_bypass'],
      ]);
    } finally {
      fixture.close();
    }
  });

  test('an exact repeat does not burn when replies may repeat', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true, allowReplyMessageMultipleTimes: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('repeat', { text: 'first answer', reply_to_message_id: '11' })).rejects.toThrow(
        'send_duplicate',
      );
      // Something else in between, so retargeting is no longer a repeat of the last message.
      await send.execute('interlude', { text: 'by the way' });
      await send.execute('retarget', { text: 'first answer', reply_to_message_id: '10' });
      expect(api.calls).toEqual(['first answer', 'by the way', 'first answer']);
    } finally {
      fixture.close();
    }
  });
});
