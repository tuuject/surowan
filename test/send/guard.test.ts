import { describe, expect, test } from 'vitest';
import {
  conversationContext,
  installSendBypassGuardHooks,
  makeTools,
  recordingApi,
  sendCounts,
  setup,
  toolAudit,
} from './guard-fixtures.ts';

installSendBypassGuardHooks();

describe('reply-policy content burn', () => {
  test('rejected text stays unsendable under a changed, omitted or restyled reply target', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      let rejections = 0;
      const { send } = makeTools(fixture, api, context, { onRejected: () => (rejections += 1) });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      // The rejected call carries the placeholder junk a degenerating model
      // fills every optional field with; narrowing keeps the key stable.
      await expect(
        send.execute('blocked', {
          kind: 'text',
          text: 'second take',
          reply_to_message_id: '11',
          sticker_ref: 'unused',
          image_generation_id: '00000000-0000-0000-0000-000000000000',
          resend: false,
        }),
      ).rejects.toThrow('reply_already_sent');
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'Not sent: send_bypass',
      );
      await expect(send.execute('omit-target', { text: 'second take' })).rejects.toThrow('send_bypass');
      await expect(
        send.execute('restyle', { text: 'second take', parse_mode: 'MarkdownV2', reply_to_message_id: '10' }),
      ).rejects.toThrow('send_bypass');
      // Fresh content on a fresh target is unaffected.
      await send.execute('fresh', { text: 'something else', reply_to_message_id: '10' });
      // reply_already_sent itself is not a guard rejection; the three bypasses are.
      expect(rejections).toBe(3);
      expect(api.calls).toEqual(['first answer', 'something else']);
      expect(toolAudit(fixture.store)).toEqual([
        { tool_call_id: 'answered', tool_name: 'send', state: 'success', error_code: null },
        { tool_call_id: 'blocked', tool_name: 'send', state: 'error', error_code: 'reply_already_sent' },
        { tool_call_id: 'retarget', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'omit-target', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'restyle', tool_name: 'send', state: 'error', error_code: 'send_bypass' },
        { tool_call_id: 'fresh', tool_name: 'send', state: 'success', error_code: null },
      ]);
      // Burn rejections spend no send budget and write no host_sends row.
      expect(sendCounts(fixture.store, context.invocationId)).toEqual({ host_sends: 2n, sends_used: 2n });
    } finally {
      fixture.close();
    }
  });

  test('rejected sticker content burns the same way', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, capabilities } = makeTools(fixture, api, context, { guard: true });
      const first = capabilities.registerStickerRef('CAAD-first-sticker');
      const second = capabilities.registerStickerRef('CAAD-second-sticker');
      await send.execute('sticker', { kind: 'sticker', sticker_ref: first, reply_to_message_id: '11' });
      await expect(
        send.execute('blocked', { kind: 'sticker', sticker_ref: second, reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      await expect(
        send.execute('retarget', { kind: 'sticker', sticker_ref: second, reply_to_message_id: '10' }),
      ).rejects.toThrow('send_bypass');
      expect(api.calls).toEqual(['CAAD-first-sticker']);
    } finally {
      fixture.close();
    }
  });

  test('a fresh sticker ref for the same sticker stays burned', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send, capabilities } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      const searched = capabilities.registerStickerRef('CAAD-same-sticker');
      await expect(
        send.execute('blocked', { kind: 'sticker', sticker_ref: searched, reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      // Searching again mints a new stk_ ref for the very same sticker file.
      const searchedAgain = capabilities.registerStickerRef('CAAD-same-sticker');
      expect(searchedAgain).not.toBe(searched);
      await expect(send.execute('re-searched', { kind: 'sticker', sticker_ref: searchedAgain })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
      expect(toolAudit(fixture.store).map((row) => row.error_code)).toEqual([
        null,
        'reply_already_sent',
        'send_bypass',
      ]);
    } finally {
      fixture.close();
    }
  });
});
