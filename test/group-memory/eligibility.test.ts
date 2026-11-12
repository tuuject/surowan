import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { appState, chatPause, groupMemoryRuns, modelCalls } from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test.each(['pause', 'sleep', 'disable', 'disconnect', 'claim_lost'] as const)(
  'a repair starts no model call after %s closes its gate',
  async (gate) => {
    const f = await groupMemoryFixture({ faux: true });
    let ready = true;
    try {
      const now = new Date();
      seedMessage(f.store, f, {
        telegramMessageId: 101,
        date: new Date(now.getTime() - 86_400_000),
        text: 'a pending event',
      });
      const service = new SleepingService({
        store: f.store,
        configStore: f.configStore,
        secrets: f.secrets,
        isHostReady: () => ready,
      });
      if (f.faux === undefined) {
        throw new Error('Missing Faux provider');
      }
      f.faux.setResponses([
        () => {
          if (gate === 'pause') {
            f.store.orm.insert(chatPause).values({ chatId: f.chatId, pausedAt: now.toISOString() }).run();
          } else if (gate === 'sleep') {
            f.store.orm
              .insert(appState)
              .values({
                key: 'bot_sleep_until',
                value: new Date(now.getTime() + 86_400_000).toISOString(),
                updatedAt: now.toISOString(),
              })
              .run();
          } else if (gate === 'disable') {
            const snapshot = f.configStore.current();
            const config = structuredClone(snapshot.config);
            const chat = config.telegram.chats[0];
            if (chat === undefined) {
              throw new Error('Missing Chat');
            }
            chat.group_memory = { enabled: false };
            f.configStore.publish({ ...snapshot, config });
            service.reconcile();
          } else if (gate === 'disconnect') {
            ready = false;
          } else {
            f.groupMemory.deactivate([f.chatId]);
          }
          return fauxAssistantMessage('invalid JSON');
        },
        fauxAssistantMessage('{"events":[]}'),
      ]);
      expect(await service.tick(now)).toBe(0);
      expect(f.store.orm.select().from(modelCalls).all()).toHaveLength(1);
      expect(f.store.orm.select().from(groupMemoryRuns).all()).toEqual([
        expect.objectContaining({ state: 'error', errorCode: 'group_memory_aborted', modelCalls: 1n }),
      ]);
      const lane = f.groupMemory.lane(f.chatId, 'live');
      if (lane !== undefined) {
        expect(lane).toMatchObject({ state: 'idle', claimedAt: null, throughMessageId: 0n });
        expect(Date.parse(lane.nextAttemptAt ?? '') - now.getTime()).toBeLessThan(5_000);
      }
    } finally {
      await f.close();
    }
  },
);
