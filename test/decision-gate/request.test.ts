import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Update } from 'grammy/types';
import {
  answer,
  BOT_DISPLAY_NAME,
  BOT_ID,
  BOT_USERNAME,
  conversationIdOf,
  decisionRows,
  gate,
  GROUP_A,
  GROUP_B,
  groupMessage,
  resetHarness,
  seedBotMessage,
  settle,
  setup,
  START,
  type DecisionCall,
  type Harness,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

const PHOTO = [{ file_id: 'photo-1', file_unique_id: 'photo-u1', width: 640, height: 480 }];
const STICKER = {
  file_id: 'sticker-1',
  file_unique_id: 'sticker-u1',
  width: 512,
  height: 512,
  is_animated: false,
  is_video: false,
  type: 'regular',
};

function seedHistory(harness: Harness, updates: readonly Update[]): void {
  for (const update of updates) {
    // Catch-up intake stores the message without opening a batch.
    harness.ingestion.ingestCatchUp(update, START);
  }
}

async function decide(harness: Harness, updates: readonly Update[]): Promise<DecisionCall> {
  for (const update of updates) {
    harness.ingestion.ingest(update, START);
  }
  harness.scheduler.processDue(new Date(START.getTime() + 15_000));
  await settle(harness);
  const call = harness.decisions.calls.at(-1);
  if (call === undefined) {
    throw new Error('The decision was never requested');
  }
  return call;
}

describe('request content', () => {
  test('history and pending are selected, ordered and bounded independently', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce', { history_messages: 3, pending_messages: 2 }),
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      seedHistory(
        harness,
        [1, 2, 3, 4, 5].map((index) => groupMessage(100 + index, index, { text: `history ${index}` })),
      );
      const call = await decide(
        harness,
        [10, 11, 12].map((messageId) => groupMessage(messageId, messageId, { text: `batch ${messageId}` })),
      );
      expect(call.body.state.history.map((entry) => entry.text)).toEqual(['history 3', 'history 4', 'history 5']);
      expect(call.body.state.pending.map((entry) => entry.text)).toEqual(['batch 11', 'batch 12']);
      expect(decisionRows(harness.store)[0]).toMatchObject({ history_count: 3n, pending_count: 2n });
      expect(call.body.state.bot).toEqual({ name: BOT_DISPLAY_NAME, username: BOT_USERNAME });
      expect(call.body.model).toBe('typesafe/jev-1.14');
      expect(call.body.questions.gate.type).toBe('noul');
    } finally {
      harness.store.close();
    }
  });

  test('the bot is marked, media are prefixed, bodies are cut and replies are quoted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({ decisionGate: gate(true, 'enforce', { history_messages: 5 }) });
    harness.decisions.responder = () => answer(0.9);
    try {
      seedHistory(harness, [
        groupMessage(201, 2, {
          text: 'quoting you',
          reply_to_message: {
            message_id: 1,
            date: Math.floor(START.getTime() / 1000) - 200,
            chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
            from: { id: BOT_ID, is_bot: true, first_name: 'Surowan' },
            text: 'an earlier answer',
          },
        }),
      ]);
      // The bot's own send lives in the store because a send wrote it; intake
      // never stores the bot's outgoing messages.
      seedBotMessage(harness.store, {
        conversationId: conversationIdOf(harness.store),
        messageNo: 1,
        text: 'an earlier answer',
        sentAt: new Date(START.getTime() - 200_000),
      });
      const call = await decide(harness, [
        groupMessage(210, 10, { text: undefined, photo: PHOTO, caption: 'look at this' }),
        groupMessage(211, 11, { text: undefined, sticker: STICKER }),
        groupMessage(212, 12, { text: 'x'.repeat(600) }),
        groupMessage(213, 13, {
          text: 'hi Alice',
          reply_to_message: {
            message_id: 11,
            date: Math.floor(START.getTime() / 1000) + 11,
            chat: { id: GROUP_A, type: 'supergroup', title: 'Group' },
            from: { id: 42, is_bot: false, first_name: 'Alice' },
            text: 'the sticker above',
          },
        }),
      ]);
      const [photo, sticker, long, reply] = call.body.state.pending;
      expect(photo).toEqual({ from: 'Alice', text: '[photo] look at this' });
      expect(sticker).toEqual({ from: 'Alice', text: '[sticker]' });
      expect(long?.text).toHaveLength(500);
      expect(reply?.reply_to).toBe('Alice: the sticker above');
      // The bot's own earlier message and a reply that quotes it.
      expect(call.body.state.history[0]).toEqual({ from: `${BOT_DISPLAY_NAME} [bot]`, text: 'an earlier answer' });
      expect(call.body.state.history[1]?.reply_to).toBe(`${BOT_DISPLAY_NAME} [bot]: an earlier answer`);
    } finally {
      harness.store.close();
    }
  });

  test('a custom question is rendered per scope, and a Chat override wins over the global text', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const harness = await setup({
      decisionGate: gate(true, 'enforce', { instructions: 'Global: should {{ bot.name }} reply?' }),
      twoGroups: true,
      transform: (config) => {
        config.telegram.chats = [
          { id: GROUP_A, instructions_file: 'chat-instructions.md' },
          {
            id: GROUP_B,
            instructions_file: 'chat-instructions.md',
            decision_gate: { instructions: 'Chat {{ bot.username }}: would you reply?' },
          },
        ];
      },
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      const global = await decide(harness, [groupMessage(1, 10, { text: 'a' })]);
      expect(global.body.questions.gate.instructions).toBe(`Global: should ${BOT_DISPLAY_NAME} reply?`);
      const chat = await decide(harness, [
        groupMessage(2, 11, {
          text: 'b',
          chat: { id: GROUP_B, type: 'supergroup', title: 'Group B' },
        }),
      ]);
      expect(chat.body.questions.gate.instructions).toBe(`Chat ${BOT_USERNAME}: would you reply?`);
    } finally {
      harness.store.close();
    }
  });

  test('the bot name is read at decision time, not at construction', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const identity = {
      id: BigInt(BOT_ID),
      name: BOT_DISPLAY_NAME,
      get displayName(): string {
        return this.name;
      },
      get username(): string {
        return BOT_USERNAME;
      },
    };
    const harness = await setup({
      decisionGate: gate(true, 'enforce'),
      twoGroups: true,
      bot: identity,
    });
    harness.decisions.responder = () => answer(0.9);
    try {
      const first = await decide(harness, [groupMessage(1, 10, { text: 'one' })]);
      expect(first.body.state.bot.name).toBe(BOT_DISPLAY_NAME);
      identity.name = '另一个名字';
      const second = await decide(harness, [
        groupMessage(2, 11, { text: 'two', chat: { id: GROUP_B, type: 'supergroup', title: 'Group B' } }),
      ]);
      expect(second.body.state.bot.name).toBe('另一个名字');
      expect(second.body.questions.gate.instructions).toContain('另一个名字');
    } finally {
      harness.store.close();
    }
  });
});
