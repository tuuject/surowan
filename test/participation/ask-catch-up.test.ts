import { afterEach, expect, test } from 'vitest';
import { cleanupDirectories, setup, groupMessage, editedGroupMessage, OUTSIDE_PERIOD } from './fixtures.ts';

afterEach(cleanupDirectories);
const ask = { text: '/ask summarize the above', entities: [{ type: 'bot_command', offset: 0, length: 4 }] };

// Regression contracts: history loss, rank eviction, edit-only wakeups and empty skip audits.
test('ask-only catch-up snapshots ordinary backlog as history and asks as new', async () => {
  const { store, ingestion, scheduler } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingestCatchUp(groupMessage(1, 1, { text: 'details' }), OUTSIDE_PERIOD);
    ingestion.ingestCatchUp(groupMessage(2, 2, ask), OUTSIDE_PERIOD);
    scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD);
    expect(store.db.prepare('SELECT section, message_id FROM invocation_messages ORDER BY sequence_no').all()).toEqual([
      { section: 'history', message_id: 1n },
      { section: 'new', message_id: 2n },
    ]);
    expect(store.db.prepare('SELECT message_id FROM bucket_messages').all()).toEqual([{ message_id: 2n }]);
    expect(store.db.prepare('SELECT state FROM invocations').get()).toEqual({ state: 'queued' });
  } finally {
    store.close();
  }
});

test('ordinary backlog cannot evict an ask beyond the history rank limit', async () => {
  const { store, ingestion, scheduler, config } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingestCatchUp(groupMessage(1, 1, ask), OUTSIDE_PERIOD);
    for (let id = 2; id <= config.agent.history_messages + 2; id++) {
      ingestion.ingestCatchUp(groupMessage(id, id, { text: 'ordinary' }), OUTSIDE_PERIOD);
    }
    scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD);
    expect(store.db.prepare('SELECT state, error_code FROM buckets').get()).toEqual({
      state: 'queued',
      error_code: null,
    });
    expect(store.db.prepare('SELECT message_id FROM bucket_messages').all()).toEqual([{ message_id: 1n }]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM invocation_messages WHERE section = 'history'").get()).toEqual({
      n: BigInt(config.agent.history_messages),
    });
  } finally {
    store.close();
  }
});

test('a revision-one edit containing ask never queues catch-up', async () => {
  const { store, ingestion, scheduler } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingestCatchUp(editedGroupMessage(1, 1, 1700000010, ask), OUTSIDE_PERIOD);
    scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD);
    expect(store.db.prepare('SELECT state, error_code FROM buckets').get()).toEqual({
      state: 'skipped_budget',
      error_code: 'participation_gated',
    });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM invocations').get()).toEqual({ n: 0n });
    expect(store.db.prepare('SELECT revision_no FROM message_revisions').get()).toEqual({ revision_no: 1n });
  } finally {
    store.close();
  }
});

test('participation-gated catch-up retains its backlog and runtime does not select it again', async () => {
  const { store, ingestion, scheduler } = await setup({ global: { ask_only: true } });
  try {
    ingestion.ingestCatchUp(groupMessage(1, 1, { text: 'quiet' }), OUTSIDE_PERIOD);
    scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD);
    expect(store.db.prepare('SELECT error_code FROM buckets').get()).toEqual({ error_code: 'participation_gated' });
    expect(store.db.prepare('SELECT message_id FROM bucket_messages').all()).toEqual([{ message_id: 1n }]);
    scheduler.finishRuntimeCatchUp(OUTSIDE_PERIOD, OUTSIDE_PERIOD);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM buckets').get()).toEqual({ n: 1n });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM invocations').get()).toEqual({ n: 0n });
  } finally {
    store.close();
  }
});
