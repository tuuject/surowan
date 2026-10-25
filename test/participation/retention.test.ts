import { afterEach, describe, expect, test } from 'vitest';
import { purgeExpiredData } from '../../src/store/store.ts';
import {
  DAY_WINDOW,
  OUTSIDE_PERIOD,
  attention,
  cleanupDirectories,
  groupMessage,
  mentionText,
  setup,
} from './fixtures.ts';

afterEach(async () => {
  await cleanupDirectories();
});

describe('participation retention', () => {
  test('deletes expired windows and keeps open ones', async () => {
    const { store, config, ingestion } = await setup({ global: { active_windows: [DAY_WINDOW] } });
    ingestion.ingest(groupMessage(1, 10, mentionText()), OUTSIDE_PERIOD);
    purgeExpiredData(store.orm, config, OUTSIDE_PERIOD);
    expect(attention(store)).not.toBeNull();
    purgeExpiredData(store.orm, config, new Date('2026-08-15T13:05:00.000Z'));
    expect(attention(store)).toBeNull();
    store.close();
  });
});
