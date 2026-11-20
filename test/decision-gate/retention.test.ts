import { afterEach, expect, test, vi } from 'vitest';
import { purgeExpiredData } from '../../src/store/store.ts';
import {
  answer,
  attempt,
  bucketRow,
  decisionRows,
  gate,
  groupMessage,
  resetHarness,
  settle,
  setup,
  START,
} from './fixtures.ts';

afterEach(async () => {
  await resetHarness();
});

test('the retention sweep removes decision rows together with their finished Buckets', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const harness = await setup({ decisionGate: gate(true, 'enforce') });
  harness.decisions.responder = () => answer(0.1);
  try {
    const result = attempt(harness, groupMessage(1, 10), START);
    await settle(harness);
    expect(decisionRows(harness.store, result.bucketId ?? 0n)).toHaveLength(1);
    expect(bucketRow(harness.store, result.bucketId ?? 0n).state).toBe('skipped_budget');

    // One day past the configured window, derived from the clock rather than a
    // fixed date so the fixture can never expire.
    const after = new Date(Date.now() + (harness.loaded.config.retention.online_days + 1) * 86_400_000);
    purgeExpiredData(harness.store.orm, harness.loaded.config, after);
    expect(
      harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM bucket_decisions').get()?.count,
    ).toBe(0n);
    expect(harness.store.db.prepare<[], { count: bigint }>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(
      0n,
    );
  } finally {
    harness.store.close();
  }
});
