import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { consolidateDay, parseConsolidatedEvents } from '../../src/context/group-memory/consolidate.ts';
import { loadPendingMessages, type GroupMemoryMessageRow } from '../../src/context/group-memory/messages.ts';
import { modelCalls } from '../../src/store/schema/index.ts';
import { groupMemoryFixture, seedMessage } from './fixtures.ts';

const DAY = new Date('2026-10-01T12:00:00.000Z');

function seedBatch(f: Awaited<ReturnType<typeof groupMemoryFixture>>): GroupMemoryMessageRow[] {
  seedMessage(f.store, f, { telegramMessageId: 4005, date: DAY, text: 'Natu: eSIM 多少钱？', senderName: 'Natu' });
  seedMessage(f.store, f, {
    telegramMessageId: 4114,
    date: new Date(DAY.getTime() + 60_000),
    text: 'tcdw: 大概 50 块',
    senderName: 'tcdw',
  });
  return loadPendingMessages(f.store.orm, f.chatId, 0n);
}

test('parseConsolidatedEvents accepts ordered inclusive ranges', () => {
  const rows = [{ telegramMessageId: 4005n }, { telegramMessageId: 4114n }] as GroupMemoryMessageRow[];
  expect(
    parseConsolidatedEvents(
      '{"events":[{"summary":"Natu asked about eSIM prices","first_message_id":4005,"last_message_id":4114}]}',
      rows,
    ),
  ).toEqual([{ summary: 'Natu asked about eSIM prices', firstMessageId: 4005n, lastMessageId: 4114n }]);
});

test('parseConsolidatedEvents rejects ranges outside the batch, backwards and overlapping', () => {
  const rows = [
    { telegramMessageId: 10n },
    { telegramMessageId: 20n },
    { telegramMessageId: 30n },
  ] as GroupMemoryMessageRow[];
  expect(() =>
    parseConsolidatedEvents('{"events":[{"summary":"x","first_message_id":10,"last_message_id":99}]}', rows),
  ).toThrow('outside the batch');
  expect(() =>
    parseConsolidatedEvents('{"events":[{"summary":"x","first_message_id":20,"last_message_id":10}]}', rows),
  ).toThrow('backwards');
  expect(() =>
    parseConsolidatedEvents(
      '{"events":[{"summary":"x","first_message_id":10,"last_message_id":20},{"summary":"y","first_message_id":20,"last_message_id":30}]}',
      rows,
    ),
  ).toThrow('overlapping');
});

test('consolidateDay sends one day of messages and records a successful model call', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    const rows = seedBatch(f);
    const faux = f.faux;
    if (faux === undefined) {
      throw new Error('faux provider missing');
    }
    faux.setResponses([
      fauxAssistantMessage(
        '{"events":[{"summary":"Natu and tcdw discussed eSIM prices","first_message_id":4005,"last_message_id":4114}]}',
      ),
    ]);
    const snapshot = f.configStore.current();
    const selection = { provider: 'agent', model: 'agent-model', thinkingLevel: 'low' as const, inherited: true };
    const result = await consolidateDay(
      { orm: f.store.orm, secrets: f.secrets },
      { day: '2026-10-01', rows, models: snapshot.models, selection },
    );
    expect(result.through).toBe(4114n);
    expect(result.messages).toBe(2);
    expect(result.events).toEqual([
      { summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 4005n, lastMessageId: 4114n },
    ]);
    const calls = f.store.orm.select().from(modelCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBe('tool');
    expect(calls[0]?.state).toBe('success');
    expect(calls[0]?.invocationId).toBeNull();
  } finally {
    await f.close();
  }
});

test('consolidateDay audits invalid model output as an error', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    const rows = seedBatch(f);
    const faux = f.faux;
    if (faux === undefined) {
      throw new Error('faux provider missing');
    }
    faux.setResponses([fauxAssistantMessage('{"events":[{"summary":"x","first_message_id":1,"last_message_id":2}]}')]);
    const snapshot = f.configStore.current();
    const selection = { provider: 'agent', model: 'agent-model', thinkingLevel: 'low' as const, inherited: true };
    await expect(
      consolidateDay(
        { orm: f.store.orm, secrets: f.secrets },
        { day: '2026-10-01', rows, models: snapshot.models, selection },
      ),
    ).rejects.toThrow('outside the batch');
    const call = f.store.orm.select().from(modelCalls).where(eq(modelCalls.state, 'error')).get();
    expect(call?.errorCode).toBe('group_memory_invalid_output');
  } finally {
    await f.close();
  }
});
