import { afterEach, describe, expect, test } from 'vitest';
import type { Update } from 'grammy/types';
import { type StartupCatchUpApi, runStartupCatchUp } from '../src/startup-catch-up.ts';
import {
  DAY_WINDOW,
  attention,
  cleanupDirectories,
  groupMessage,
  mentionText,
  setup,
} from './participation-fixtures.ts';

afterEach(async () => {
  await cleanupDirectories();
});

describe('startup catch-up participation', () => {
  function fakeApi(updates: readonly Update[]): StartupCatchUpApi {
    return {
      getUpdates: async (options) =>
        updates
          .filter((update) => options.offset === undefined || update.update_id >= options.offset)
          .slice(0, options.limit),
    };
  }

  const catchUpAt = new Date('2026-08-15T13:00:10.000Z');

  test('skips a quiet chat without starting an invocation', async () => {
    const { store, ingestion, scheduler, commands } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = await runStartupCatchUp({
      api: fakeApi([groupMessage(1, 10, { text: 'while down' })]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => catchUpAt,
    });
    expect(result.invocationIds).toHaveLength(0);
    expect(
      store.db.prepare<[], { state: string; error_code: string }>('SELECT state, error_code FROM buckets').get(),
    ).toEqual({ state: 'skipped_budget', error_code: 'participation_gated' });
    expect(store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM invocations').get()?.count).toBe(0n);
    store.close();
  });

  test('resumes a chat whose attention window a catch-up mention refreshed', async () => {
    const { store, ingestion, scheduler, commands } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    const result = await runStartupCatchUp({
      api: fakeApi([groupMessage(1, 10, mentionText())]),
      store,
      ingestion,
      scheduler,
      commands,
      allowedUpdates: ['message', 'edited_message', 'my_chat_member'],
      now: () => catchUpAt,
    });
    expect(result.invocationIds).toHaveLength(1);
    expect(attention(store)).toEqual({ expiresAt: '2026-08-15T13:05:10.000Z', triggerKind: 'mention' });
    expect(store.db.prepare<[], { kind: string; state: string }>('SELECT kind, state FROM buckets').get()).toEqual({
      kind: 'startup_catch_up',
      state: 'queued',
    });
    store.close();
  });
});
