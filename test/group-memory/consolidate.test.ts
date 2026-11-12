import { fauxAssistantMessage } from '@earendil-works/pi-ai';
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
  return loadPendingMessages(f.store.orm, f.chatId, { after: 0n, until: null });
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

test('parseConsolidatedEvents rejects ranges outside the batch and backwards ranges', () => {
  const rows = [
    { telegramMessageId: 10n },
    { telegramMessageId: 20n },
    { telegramMessageId: 30n },
  ] as GroupMemoryMessageRow[];
  expect(() =>
    parseConsolidatedEvents('{"events":[{"summary":"x","first_message_id":10,"last_message_id":99}]}', rows),
  ).toThrow('outside the batch (event 1: 99)');
  expect(() =>
    parseConsolidatedEvents('{"events":[{"summary":"x","first_message_id":20,"last_message_id":10}]}', rows),
  ).toThrow('backwards message range (event 1: 20 > 10)');
});

test('parseConsolidatedEvents accepts overlapping and unordered ranges and sorts them', () => {
  const rows = [
    { telegramMessageId: 10n },
    { telegramMessageId: 20n },
    { telegramMessageId: 30n },
  ] as GroupMemoryMessageRow[];
  // Two interleaved discussions: the second starts before the first ends.
  expect(
    parseConsolidatedEvents(
      '{"events":[{"summary":"later","first_message_id":20,"last_message_id":30},{"summary":"earlier","first_message_id":10,"last_message_id":20}]}',
      rows,
    ),
  ).toEqual([
    { summary: 'earlier', firstMessageId: 10n, lastMessageId: 20n },
    { summary: 'later', firstMessageId: 20n, lastMessageId: 30n },
  ]);
});

test('parseConsolidatedEvents accepts summaries up to 200 characters', () => {
  const rows = [{ telegramMessageId: 10n }] as GroupMemoryMessageRow[];
  const reply = (summary: string): string =>
    JSON.stringify({ events: [{ summary, first_message_id: 10, last_message_id: 10 }] });
  expect(parseConsolidatedEvents(reply('事'.repeat(200)), rows)[0]?.summary).toHaveLength(200);
  expect(() => parseConsolidatedEvents(reply('事'.repeat(201)), rows)).toThrow('invalid events');
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
    expect(result).toEqual({
      ok: true,
      through: 4114n,
      messages: 2,
      modelCalls: 1,
      events: [{ summary: 'Natu and tcdw discussed eSIM prices', firstMessageId: 4005n, lastMessageId: 4114n }],
    });
    const calls = f.store.orm.select().from(modelCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBe('tool');
    expect(calls[0]?.state).toBe('success');
    expect(calls[0]?.invocationId).toBeNull();
  } finally {
    await f.close();
  }
});

test('consolidateDay sends an invalid reply back once and accepts the corrected one', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    const rows = seedBatch(f);
    const faux = f.faux;
    if (faux === undefined) {
      throw new Error('faux provider missing');
    }
    let repairPrompt = '';
    faux.setResponses([
      fauxAssistantMessage('{"events":[{"summary":"x","first_message_id":1,"last_message_id":2}]}'),
      (context) => {
        const last = context.messages.at(-1);
        repairPrompt = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
        return fauxAssistantMessage(
          '{"events":[{"summary":"Natu asked about eSIM prices","first_message_id":4005,"last_message_id":4114}]}',
        );
      },
    ]);
    const snapshot = f.configStore.current();
    const selection = { provider: 'agent', model: 'agent-model', thinkingLevel: 'low' as const, inherited: true };
    const result = await consolidateDay(
      { orm: f.store.orm, secrets: f.secrets },
      { day: '2026-10-01', rows, models: snapshot.models, selection },
    );
    expect(result).toMatchObject({ ok: true, modelCalls: 2 });
    expect(repairPrompt).toContain('outside the batch (event 1: 1, 2)');
    const calls = f.store.orm.select().from(modelCalls).orderBy(modelCalls.id).all();
    expect(calls.map((call) => [call.attempt, call.state, call.errorCode])).toEqual([
      [1n, 'error', 'group_memory_invalid_output'],
      [2n, 'success', null],
    ]);
  } finally {
    await f.close();
  }
});

test('consolidateDay gives up after the repair call and never repairs a provider error', async () => {
  const f = await groupMemoryFixture({ faux: true });
  try {
    const rows = seedBatch(f);
    const faux = f.faux;
    if (faux === undefined) {
      throw new Error('faux provider missing');
    }
    faux.setResponses([fauxAssistantMessage('not json'), fauxAssistantMessage('still not json')]);
    const snapshot = f.configStore.current();
    const selection = { provider: 'agent', model: 'agent-model', thinkingLevel: 'low' as const, inherited: true };
    const invalid = await consolidateDay(
      { orm: f.store.orm, secrets: f.secrets },
      { day: '2026-10-01', rows, models: snapshot.models, selection },
    );
    expect(invalid).toMatchObject({
      ok: false,
      modelCalls: 2,
      errorCode: 'group_memory_invalid_output',
      errorDetail: 'The tool model did not return a JSON object',
    });

    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream 503' })]);
    const outage = await consolidateDay(
      { orm: f.store.orm, secrets: f.secrets },
      { day: '2026-10-01', rows, models: snapshot.models, selection },
    );
    expect(outage).toMatchObject({ ok: false, modelCalls: 1, errorCode: 'group_memory_error' });
    const call = f.store.orm.select().from(modelCalls).orderBy(modelCalls.id).all().at(-1);
    expect(call?.errorDetail).toContain('upstream 503');
  } finally {
    await f.close();
  }
});
