import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, test, vi } from 'vitest';
import { SleepingService } from '../../src/context/group-memory/sleeping.ts';
import { GroupMemoryStore } from '../../src/context/group-memory/store.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

test.each([false, true])(
  'a failed audit insert drains every worker even if claim release fails: %s',
  async (failRelease) => {
    const f = await groupMemoryFixture({
      faux: true,
      extraChatIds: [-1001, -1002, -1003, -1004, -1005, -1006, -1007, -1008],
    });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const now = new Date();
    let active = 0;
    let peak = 0;
    let settled = false;
    const service = new SleepingService({
      store: f.store,
      configStore: f.configStore,
      secrets: f.secrets,
      isHostReady: () => true,
    });
    let ticking: Promise<unknown> = Promise.resolve();
    try {
      for (const chat of [f, ...f.extraChats]) {
        seedMessage(f.store, chat, {
          telegramMessageId: 101,
          date: new Date(now.getTime() - 86_400_000),
          text: 'event',
        });
      }
      const failedChat = f.extraChats[0];
      if (failedChat === undefined || f.faux === undefined) {
        throw new Error('Missing fixture');
      }
      const originalStart = GroupMemoryStore.prototype.startRun;
      vi.spyOn(GroupMemoryStore.prototype, 'startRun').mockImplementation(function (this: GroupMemoryStore, run, at) {
        if (run.chatId === failedChat.chatId) {
          throw new Error('audit insert unavailable');
        }
        return originalStart.call(this, run, at);
      });
      const releaseError = new Error('claim release unavailable');
      if (failRelease) {
        vi.spyOn(GroupMemoryStore.prototype, 'fail').mockImplementationOnce(() => {
          throw releaseError;
        });
      }
      const reply = async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active >= 3) {
          started.resolve();
        }
        await release.promise;
        active -= 1;
        return fauxAssistantMessage('{"events":[]}');
      };
      f.faux.setResponses(Array.from({ length: 16 }, () => reply));
      ticking = service.tick(now).then(
        () => undefined,
        (error: unknown) => error,
      );
      void ticking.then(() => {
        settled = true;
      });
      await started.promise;
      expect(settled).toBe(false);
      expect(await service.tick(new Date(now.getTime() + 60_000))).toBe(0);
      if (!failRelease) {
        expect(f.groupMemory.lane(failedChat.chatId, 'live')).toMatchObject({
          state: 'idle',
          claimedAt: null,
          errorCode: 'group_memory_error',
        });
      }
      let stopped = false;
      const stopping = service.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release.resolve();
      expect(await ticking).toBe(failRelease ? releaseError : undefined);
      await stopping;
      expect(active).toBe(0);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      const stopping = service.stop();
      release.resolve();
      await ticking;
      await stopping;
      await vi.waitFor(() => expect(active).toBe(0));
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.restoreAllMocks();
      await f.close();
    }
  },
);
