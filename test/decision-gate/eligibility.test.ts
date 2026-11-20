import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Update } from 'grammy/types';
import { PlaygroundIngress } from '../../src/ingress/playground.ts';
import { resumeInvocation } from '../../src/orchestration/invocation-queue/resume.ts';
import { everyHostReady } from '../../src/orchestration/host-scope.ts';
import { CronerScheduleEngine } from '../../src/adapters/local-monolith/recurring-schedule.ts';
import { PlaygroundStore } from '../../src/store/playground/index.ts';
import { RecurringAlarmService } from '../../src/store/recurring-alarms/index.ts';
import {
  answer,
  BOT_ID,
  BOT_USERNAME,
  bucketRow,
  conversationIdOf,
  decisionRows,
  gate,
  groupMessage,
  internalChatId,
  invocationCount,
  privateMessage,
  PRIVATE,
  resetHarness,
  seedRunningInvocation,
  setup,
  START,
  WINDOW_MS,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

const drop = () => answer(0.01);

describe('batches that never reach the decision model', () => {
  const triggers: ReadonlyArray<{ readonly name: string; readonly update: () => Update; readonly config?: unknown }> = [
    {
      name: '/ask',
      update: () =>
        groupMessage(1, 10, {
          text: `/ask@${BOT_USERNAME} question`,
          entities: [{ type: 'bot_command', offset: 0, length: BOT_USERNAME.length + 5 }],
        }),
    },
    {
      name: 'an @-mention',
      update: () =>
        groupMessage(1, 10, {
          text: `@${BOT_USERNAME} ping`,
          entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
        }),
    },
    {
      name: 'a reply to the bot',
      update: () =>
        groupMessage(1, 10, {
          text: 'replying to you',
          reply_to_message: {
            message_id: 900,
            date: Math.floor(START.getTime() / 1000),
            chat: { id: -1_001_234_567_890, type: 'supergroup', title: 'Group A' },
            from: { id: BOT_ID, is_bot: true, first_name: 'Surowan' },
            text: 'earlier',
          },
        }),
    },
    {
      name: 'a trigger keyword',
      update: () => groupMessage(1, 10, { text: 'please wake the bot' }),
      config: { trigger_keywords: ['wake'] },
    },
  ];

  for (const trigger of triggers) {
    test(`no request for ${trigger.name}`, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const harness = await setup({
        decisionGate: gate(true, 'enforce'),
        transform: (config) => {
          if (trigger.config !== undefined) {
            config.telegram.participation = trigger.config as NonNullable<typeof config.telegram.participation>;
          }
        },
      });
      harness.decisions.responder = drop;
      try {
        const result = harness.ingestion.ingest(trigger.update(), START);
        expect(result.bucketId).toBeDefined();
        const invocations = harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS));
        expect(invocations).toHaveLength(1);
        expect(harness.decisions.calls).toEqual([]);
        expect(decisionRows(harness.store)).toEqual([]);
        expect(bucketRow(harness.store, result.bucketId ?? 0n).state).toBe('queued');
      } finally {
        harness.store.close();
      }
    });
  }

  test('an ask-only Chat only has direct batches', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: (config) => {
        config.telegram.participation = { ask_only: true };
      },
    });
    harness.decisions.responder = drop;
    try {
      // Ordinary chatter is stored but never opens a batch.
      expect(harness.ingestion.ingest(groupMessage(1, 10), START).bucketId).toBeUndefined();
      const ask = harness.ingestion.ingest(
        groupMessage(2, 11, {
          text: '/ask question',
          entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        }),
        START,
      );
      expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toHaveLength(1);
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(bucketRow(harness.store, ask.bucketId ?? 0n).state).toBe('queued');
    } finally {
      harness.store.close();
    }
  });

  test('a private chat is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      transform: (config) => {
        config.telegram.chats = [
          { id: -1_001_234_567_890, instructions_file: 'chat-instructions.md' },
          { id: PRIVATE, instructions_file: 'chat-instructions.md' },
        ];
      },
    });
    harness.decisions.responder = drop;
    try {
      const result = harness.ingestion.ingest(privateMessage(1, 10), START);
      expect(harness.scheduler.processDue(new Date(START.getTime() + WINDOW_MS))).toHaveLength(1);
      expect(result.bucketId).toBeDefined();
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(bucketRow(harness.store, result.bucketId ?? 0n).state).toBe('queued');
    } finally {
      harness.store.close();
    }
  });

  test('a Playground room release is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = drop;
    try {
      const playground = new PlaygroundStore(harness.store.orm);
      const room = playground.createRoom({ title: 'Room', members: [{ name: 'Alice' }] });
      const senderId = harness.store.orm.all<{ id: bigint }>('SELECT id FROM senders LIMIT 1')[0]?.id;
      if (senderId === undefined) {
        throw new Error('Expected a room sender');
      }
      const ingress = new PlaygroundIngress(harness.store.orm);
      await ingress.submit(room.chatId, { requestKey: 'req-1', senderId, text: 'hello room' });
      const release = ingress.release(room.chatId, {
        releaseKey: 'rel-1',
        revision: playground.room(room.chatId).revision,
      });
      expect(release.invocationId).not.toBeNull();
      harness.scheduler.processDue(new Date());
      harness.scheduler.processTasksDue(new Date());
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });

  test('a startup catch-up batch is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = drop;
    try {
      harness.ingestion.ingestCatchUp(groupMessage(1, 10), START);
      const invocations = harness.scheduler.finishRuntimeCatchUp('telegram', START, START);
      expect(invocations).toHaveLength(1);
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(
        harness.store.db.prepare<[], { kind: string; state: string }>('SELECT kind, state FROM buckets').get(),
      ).toEqual({ kind: 'startup_catch_up', state: 'queued' });
    } finally {
      harness.store.close();
    }
  });

  test('a long-task completion receipt is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = drop;
    try {
      harness.ingestion.ingest(groupMessage(1, 10), START);
      const conversationId = conversationIdOf(harness.store);
      const scope = harness.tasks.scoped('test-plugin', conversationId);
      const created = scope.create({
        payload: { state: 'done' },
        delivery: { bypassDailyBudget: false, mentionUser: { userId: 42n, displayName: 'Alice' } },
      });
      expect(scope.complete(created.taskId, { url: 'https://example.test/report' })).toBe(true);
      const invocations = harness.scheduler.processTasksDue(new Date());
      expect(invocations).toHaveLength(1);
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });

  test('a recurring alarm coming due is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = drop;
    try {
      harness.ingestion.ingest(groupMessage(1, 10), START);
      const recurring = new RecurringAlarmService({
        store: harness.store,
        engine: new CronerScheduleEngine(),
        tasks: harness.tasks,
        config: () => harness.configStore.current().config,
      });
      harness.tasks.addTimerSource(recurring);
      const alarm = recurring.create(
        internalChatId(harness.store),
        {
          title: 'Morning greeting',
          prompt: 'Say good morning.',
          rules: ['*/5 * * * *'],
          inputMode: 'cron',
          timeZone: 'UTC',
          enabled: true,
        },
        'admin',
      );
      harness.store.db
        .prepare('UPDATE recurring_alarms SET next_fire_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 300_000).toISOString(), alarm.id);
      const invocations = harness.scheduler.processTasksDue(new Date());
      expect(invocations).toHaveLength(1);
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(invocationCount(harness.store)).toBe(1);
    } finally {
      harness.store.close();
    }
  });

  test('an Invocation resumed from the panel is never decided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce') });
    harness.decisions.responder = drop;
    try {
      harness.ingestion.ingest(groupMessage(1, 10), START);
      const conversationId = conversationIdOf(harness.store);
      seedRunningInvocation(harness.store, conversationId);
      harness.store.db
        .prepare("UPDATE invocations SET state = 'failed', completion_reason = 'test' WHERE id = 900")
        .run();
      const resumed = resumeInvocation(harness.store, harness.configStore, 900n, everyHostReady, new Date());
      expect(resumed.ok).toBe(true);
      harness.scheduler.processDue(new Date());
      expect(harness.decisions.calls).toEqual([]);
      expect(decisionRows(harness.store)).toEqual([]);
      expect(invocationCount(harness.store)).toBe(2);
    } finally {
      harness.store.close();
    }
  });
});
