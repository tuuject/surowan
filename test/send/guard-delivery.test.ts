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
  test('reply_delivery_unknown burns the content as well', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const gate = Promise.withResolvers<void>();
      const api = recordingApi(gate.promise);
      const { send } = makeTools(fixture, api, context, { guard: true });
      // execute() runs synchronously up to the gated API call, leaving a
      // committed pending row on reply target 11.
      const pending = send.execute('held', { text: 'held answer', reply_to_message_id: '11' });
      await expect(send.execute('unsure', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_delivery_unknown',
      );
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      gate.resolve();
      await pending;
      expect(api.calls).toEqual(['held answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'reply_delivery_unknown',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });

  test('the send barrier does not burn content', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let held = true;
      const { send } = makeTools(fixture, api, context, { guard: true, holdForNewMessages: () => held });
      await expect(send.execute('held-back', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'new messages arrived',
      );
      held = false;
      await send.execute('released', { text: 'second take', reply_to_message_id: '11' });
      expect(api.calls).toEqual(['second take']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual(['send_barrier', null]);
    } finally {
      fixture.close();
    }
  });
});
