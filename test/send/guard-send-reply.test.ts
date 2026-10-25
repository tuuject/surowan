import { describe, expect, test } from 'vitest';
import {
  conversationContext,
  installSendBypassGuardHooks,
  makeTools,
  recordingApi,
  setup,
  toolAudit,
} from './guard-fixtures.ts';

installSendBypassGuardHooks();

describe('reply-policy content burn', () => {
  test('send_reply pre-flight rejects a burned part before anything goes out', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send, sendReply } = makeTools(fixture, api, context, {
        guard: true,
        onRejected: () => (rejections += 1),
      });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      await expect(sendReply.execute('bundle', { parts: [{ text: 'second take' }, { text: 'coda' }] })).rejects.toThrow(
        'Nothing was sent: part 1 was already rejected by the reply policy',
      );
      expect(rejections).toBe(1);
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).at(-1)).toEqual({
        tool_call_id: 'bundle',
        tool_name: 'send_reply',
        state: 'error',
        error_code: 'send_bypass',
      });
    } finally {
      fixture.close();
    }
  });

  test('a part rejected mid-delivery burns its content for the rest of the run', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, sendReply } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        sendReply.execute('bundle', { reply_to_message_id: '11', parts: [{ text: 'part one' }, { text: 'coda' }] }),
      ).rejects.toThrow('Nothing was sent: part 1 failed');
      await expect(send.execute('retarget', { text: 'part one', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => [row.tool_call_id, row.error_code])).toEqual([
        ['answered', null],
        ['bundle', 'reply_already_sent'],
        ['bundle:1', 'reply_already_sent'],
        ['retarget', 'send_bypass'],
      ]);
    } finally {
      fixture.close();
    }
  });
});
