import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, test, vi } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { groupMemoryRuns, modelCalls } from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test.each(['commit', 'success_audit', 'error_audit'] as const)(
  '%s failure keeps the real call count and never labels committed memories as errors',
  async (failure) => {
    const f = await groupMemoryFixture({ faux: true });
    try {
      const now = new Date();
      seedMessage(f.store, f, {
        telegramMessageId: 101,
        date: new Date(now.getTime() - 86_400_000),
        text: 'an event',
      });
      if (f.faux === undefined) {
        throw new Error('Missing Faux provider');
      }
      f.faux.setResponses(
        failure === 'error_audit'
          ? [fauxAssistantMessage('invalid JSON'), fauxAssistantMessage('invalid JSON')]
          : [fauxAssistantMessage('{"events":[{"summary":"an event","first_message_id":101,"last_message_id":101}]}')],
      );
      if (failure === 'commit') {
        vi.spyOn(GroupMemoryStore.prototype, 'commit').mockImplementationOnce(() => {
          throw new Error('commit unavailable');
        });
      } else {
        vi.spyOn(GroupMemoryStore.prototype, 'finishRun').mockImplementationOnce(() => {
          throw new Error('audit finalization unavailable');
        });
      }
      const service = new SleepingService({
        store: f.store,
        configStore: f.configStore,
        secrets: f.secrets,
        isHostReady: () => true,
      });
      expect(await service.tick(now)).toBe(0);
      const calls = failure === 'error_audit' ? 2 : 1;
      expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(calls);
      expect(f.store.orm.select().from(groupMemoryRuns).all()).toEqual([
        expect.objectContaining({
          state: 'error',
          firstMessageId: 101n,
          throughMessageId: 101n,
          messages: 1n,
          modelCalls: BigInt(calls),
        }),
      ]);
      expect(f.groupMemory.list(f.chatId)).toEqual([]);
      expect(f.groupMemory.lane(f.chatId, 'live')).toMatchObject({
        state: 'idle',
        claimedAt: null,
        throughMessageId: 0n,
      });
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
