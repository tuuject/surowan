import { afterEach, expect, test } from 'vitest';
import { groupMessage, resetHarness, setup, START, BOT_USERNAME } from './reply-harness.ts';

afterEach(resetHarness);
for (const askOnly of [false, true]) {
  test(`ask queues an invocation despite zero probability (ask-only=${askOnly})`, async () => {
    const { store, ingestion, scheduler, random } = await setup({
      transform(config) {
        config.telegram.participation = { ask_only: askOnly, active_windows: [] };
        config.telegram.proactive_reply = { enabled: true, base_probability: 0, increment: 0, hard_pity: 100 };
      },
    });
    try {
      const token = `/ask@${BOT_USERNAME}`;
      const result = ingestion.ingest(
        groupMessage(1, 10, {
          text: `${token} question`,
          entities: [{ type: 'bot_command', offset: 0, length: token.length }],
        }),
        START,
      );
      expect(result.command).toBeUndefined();
      expect(scheduler.processDue(new Date(START.getTime() + 20_000))).toHaveLength(1);
      expect(store.db.prepare('SELECT state, error_code FROM buckets').get()).toEqual({
        state: 'queued',
        error_code: null,
      });
      expect(store.db.prepare('SELECT state FROM invocations').get()).toEqual({ state: 'queued' });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM proactive_reply_state').get()).toEqual({ n: 0n });
      expect(random).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
}

for (const catchUp of [false, true]) {
  test(`an original ask edited to plain text stays direct (catch-up=${catchUp})`, async () => {
    const { store, ingestion, scheduler, random } = await setup({
      transform(config) {
        config.telegram.participation = { ask_only: true };
        config.telegram.proactive_reply = { enabled: true, base_probability: 0, increment: 0, hard_pity: 100 };
      },
    });
    try {
      const update = groupMessage(1, 10, {
        text: '/ask question',
        entities: [{ type: 'bot_command', offset: 0, length: 4 }],
      });
      if (catchUp) {
        ingestion.ingestCatchUp(update, START);
      } else {
        ingestion.ingest(update, START);
      }
      const edited = groupMessage(2, 10, { text: 'plain', edit_date: 1700000020 });
      const editUpdate = { update_id: 2, edited_message: { ...edited.message!, edit_date: 1700000020 } };
      if (catchUp) {
        ingestion.ingestCatchUp(editUpdate, START);
      } else {
        ingestion.ingest(editUpdate, START);
      }
      if (catchUp) {
        scheduler.finishRuntimeCatchUp('telegram', START, START);
      } else {
        scheduler.processDue(new Date(START.getTime() + 20_000));
      }
      expect(store.db.prepare('SELECT state, error_code FROM buckets').get()).toEqual({
        state: 'queued',
        error_code: null,
      });
      expect(store.db.prepare('SELECT state FROM invocations').get()).toEqual({ state: 'queued' });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM message_revisions').get()).toEqual({ n: 2n });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM proactive_reply_state').get()).toEqual({ n: 0n });
      expect(random).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
}
