import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, test } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { groupMemoryRuns } from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test('backfill ages ahead of recently attempted live lanes under a full batch budget', async () => {
  const f = await groupMemoryFixture({ faux: true, extraChatIds: [-1001, -1002, -1003, -1004, -1005, -1006, -1007] });
  try {
    const now = new Date();
    seedMessage(f.store, f, {
      telegramMessageId: 100,
      date: new Date(now.getTime() - 4 * 86_400_000),
      text: 'backfill event',
    });
    expect(f.groupMemory.split(f.chatId, 100n, now)).toBe(true);
    if (f.faux === undefined) {
      throw new Error('Missing Faux provider');
    }
    f.faux.setResponses(Array.from({ length: 24 }, () => fauxAssistantMessage('{"events":[]}')));
    const service = new SleepingService({
      store: f.store,
      configStore: f.configStore,
      secrets: f.secrets,
      isHostReady: () => true,
    });
    for (let round = 0; round < 3; round += 1) {
      for (const chat of [f, ...f.extraChats]) {
        seedMessage(f.store, chat, {
          telegramMessageId: 200 + round,
          date: new Date(now.getTime() - 86_400_000),
          text: 'live event',
        });
      }
      expect(await service.tick(new Date(now.getTime() + round * 60_000))).toBe(8);
    }
    expect(f.groupMemory.lane(f.chatId, 'backfill')).toBeUndefined();
    expect(f.store.orm.select().from(groupMemoryRuns).all()).toContainEqual(
      expect.objectContaining({ lane: 'backfill', firstMessageId: 100n, throughMessageId: 100n, state: 'success' }),
    );
    for (const chat of [f, ...f.extraChats]) {
      expect(f.groupMemory.lane(chat.chatId, 'live')?.throughMessageId).toBeGreaterThanOrEqual(201n);
    }
  } finally {
    await f.close();
  }
});
