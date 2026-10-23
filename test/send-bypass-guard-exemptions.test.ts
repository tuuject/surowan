import { describe, expect, test } from 'vitest';
import {
  conversationContext,
  imageGeneration,
  installSendBypassGuardHooks,
  makeTools,
  recordingApi,
  setup,
  toolAudit,
} from './send-bypass-guard-fixtures.ts';

installSendBypassGuardHooks();

describe('reply-policy content burn', () => {
  test('image sends stay exempt from the burn', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true, imageGeneration });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(
        send.execute('blocked', { kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '11' }),
      ).rejects.toThrow('reply_already_sent');
      // A generation was never delivered by the rejected attempt, so sending it
      // to another target is a first delivery, not a bypass.
      await send.execute('retarget', { kind: 'image', image_generation_id: 'gen-1', reply_to_message_id: '10' });
      expect(api.calls).toEqual(['first answer', 'pic.png']);
    } finally {
      fixture.close();
    }
  });

  test('the burn applies with the duplicate send guard turned off', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: false });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      await expect(send.execute('retarget', { text: 'second take', reply_to_message_id: '10' })).rejects.toThrow(
        'send_bypass',
      );
      expect(api.calls).toEqual(['first answer']);
    } finally {
      fixture.close();
    }
  });

  test('the burn expires with the invocation while reply dedup persists', async () => {
    const fixture = await setup();
    try {
      conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const context = conversationContext(fixture, 2, 11, new Date('2026-08-15T00:01:00.000Z'));
      const api = recordingApi();
      const { send } = makeTools(fixture, api, context, { guard: true });
      await send.execute('answered', { text: 'first answer', reply_to_message_id: '11' });
      await expect(send.execute('blocked', { text: 'second take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      toolAudit(fixture.store); // burn lives on inv2's rows
      const next = conversationContext(fixture, 3, 12, new Date('2026-08-15T00:02:00.000Z'));
      const tools = makeTools(fixture, api, next, { guard: true });
      // A fresh run may say the same words to a fresh message...
      await tools.send.execute('new-run', { text: 'second take', reply_to_message_id: '12' });
      // ...while the old reply target is still claimed, by reply dedup rather
      // than the expired burn.
      await expect(tools.send.execute('old-run', { text: 'third take', reply_to_message_id: '11' })).rejects.toThrow(
        'reply_already_sent',
      );
      expect(api.calls).toEqual(['first answer', 'second take']);
    } finally {
      fixture.close();
    }
  });
});
