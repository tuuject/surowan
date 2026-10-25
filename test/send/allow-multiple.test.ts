import { describe, expect, test } from 'vitest';
import { hostSends } from '../../src/store/schema/index.ts';
import {
  conversationContext,
  countingApi,
  errorCodeOf,
  expectRejected,
  imageGeneration,
  makeTool,
  sendAudit,
  sendsUsed,
  setup,
} from './fixtures.ts';

describe('reply deduplication', () => {
  test('allowing multiple replies preserves visibility, send barriers and rate limits', async () => {
    const fixture = await setup(undefined, true);
    try {
      const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const api = countingApi();
      let hold = false;
      const { tool } = makeTool(fixture.store, fixture.config, context, {
        api,
        sendsPerWindow: 1,
        holdForNewMessages: () => hold,
      });
      await tool.execute('first', { text: 'answer', reply_to_message_id: '10' });
      await expect(tool.execute('invisible', { text: 'answer', reply_to_message_id: '999' })).rejects.toThrow(
        'not visible',
      );
      expect(errorCodeOf(fixture.store, 'invisible')).toBe('reply_not_visible');
      hold = true;
      await expectRejected(tool, 'held', { text: 'answer again', reply_to_message_id: '10' });
      expect(errorCodeOf(fixture.store, 'held')).toBe('send_barrier');
      hold = false;
      await expectRejected(tool, 'limited', { text: 'answer again', reply_to_message_id: '10' });
      expect(errorCodeOf(fixture.store, 'limited')).toBe('send_rate_limited');
      expect(api.calls).toBe(1);
      expect(sendAudit(fixture.store)).toHaveLength(1);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });

  test('allowing multiple replies does not disable image delivery deduplication or unknown-outcome protection', async () => {
    const fixture = await setup(undefined, true);
    try {
      const context = await conversationContext(fixture, 1, 10, new Date('2026-08-15T00:00:00.000Z'));
      const api = countingApi();
      const { tool } = makeTool(fixture.store, fixture.config, context, { api, imageGeneration });
      const input = { kind: 'image' as const, image_generation_id: 'gen-1', reply_to_message_id: '10' };
      await tool.execute('first', input);
      const replay = await tool.execute('again', input);
      expect(replay.details.replayed).toBe(true);
      fixture.store.orm.update(hostSends).set({ state: 'outcome_unknown' }).run();
      await expect(tool.execute('unknown', { ...input, resend: true })).rejects.toThrow('unknown outcome');
      expect(errorCodeOf(fixture.store, 'unknown')).toBe('image_delivery_unknown');
      expect(api.calls).toBe(1);
      expect(sendAudit(fixture.store)).toHaveLength(1);
      expect(sendsUsed(fixture.store, context.invocationId)).toBe(1n);
    } finally {
      fixture.close();
    }
  });
});
