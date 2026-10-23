/**
 * Model health check lifetime: results are page-local. Unmounting the Models
 * page must abort the queued and in-flight batch (proven by a test-only
 * upstream gate: requests are held open until the spec releases them, so a drop
 * to zero in-flight while still held can only be a real abort) and a fresh
 * check afterwards still lands in a freed backend slot. A full reload starts
 * the rows clean instead of replaying a stale result.
 *
 * The providers these checks hit, and the gate that holds requests open, come
 * from `model-health-fixture.ts`; the per-row and per-batch behavior lives in
 * `16-model-health.e2e.ts`.
 */
import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';
import {
  holdHealthGate,
  modelRow,
  releaseHealthGate,
  relayStats,
  resetRelayStats,
  selectProvider,
  modelHealthFixture,
} from './model-health-fixture.ts';
import {
  E2E_HEALTH_ALIAS_A,
  E2E_HEALTH_ALIAS_B,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_UNEXPECTED_MODEL,
} from './models-fixture.ts';

test.use({ signedIn: true });
modelHealthFixture();

test.describe('model health checks', () => {
  test('leaving the page aborts the queued and in-flight batch', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Hold every model upstream before the batch starts: no request can settle
    // on its own, so an in-flight drop below three can only mean a real abort.
    await holdHealthGate();
    try {
      // Queue four checks so three run and one waits behind them: the three
      // slow models fill the concurrency slots and the fast one is picked up
      // last (and never reaches the upstream).
      await page.getByLabel(`Select ${E2E_HEALTH_OK_2_MODEL} for a health check`).check();
      await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();
      await selectProvider(page, E2E_HEALTH_ALIAS_B);
      await page.getByLabel(`Select ${E2E_HEALTH_FAIL_MODEL} for a health check`).check();
      await selectProvider(page, E2E_HEALTH_ALIAS_A);
      await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
      await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();

      // All three concurrency slots are busy upstream (held) — including the
      // HTTP-500 model, which counts toward in-flight like any other request —
      // and the fourth is queued in the page, not upstream.
      await expect.poll(async () => (await relayStats()).total).toBe(3);
      await expect.poll(async () => (await relayStats()).in_flight).toBe(3);
      const held = await relayStats();
      expect(held.by_model).toEqual({
        [E2E_HEALTH_OK_2_MODEL]: 1,
        [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
        [E2E_HEALTH_FAIL_MODEL]: 1,
      });

      // SPA navigation unmounts the Models page; the cleanup must abort the
      // batch instead of letting the queued check charge in the background.
      await page.getByRole('link', { name: 'Overview' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      await expect(page.getByText('Bot status')).toBeVisible();

      // While still held, the only way in-flight drops to zero is a real
      // upstream teardown: all three requests saw their connection die before
      // the fixture ever answered, and freed their slots. Natural completion
      // is impossible here, so this is cancellation, not a wait-out.
      await expect.poll(async () => (await relayStats()).in_flight).toBe(0);
      await expect.poll(async () => (await relayStats()).aborted).toBe(3);
      const cancelled = await relayStats();
      expect(cancelled.total).toBe(3);
      expect(cancelled.by_model).toEqual(held.by_model);
      expect(cancelled.records).toHaveLength(3);
      expect(cancelled.records.every((record) => record.aborted)).toBe(true);
      expect(cancelled.rejected).toBe(0);
    } finally {
      await releaseHealthGate();
    }

    // Back on the Models page a fresh check lands in a freed backend slot and
    // completes normally: the queued fourth never sneaked in behind the page's
    // lifetime (health-ok was absent from the cancelled batch).
    await page.getByRole('link', { name: 'Models' }).click();
    await page.waitForURL((url) => url.pathname === '/models');
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/TTFB/)).toBeVisible();
    const after = await relayStats();
    expect(after.total).toBe(4);
    expect(after.by_model).toEqual({
      [E2E_HEALTH_OK_2_MODEL]: 1,
      [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
      [E2E_HEALTH_FAIL_MODEL]: 1,
      [E2E_HEALTH_OK_MODEL]: 1,
    });
    const fresh = after.records.find((record) => record.model === E2E_HEALTH_OK_MODEL);
    expect(fresh, 'the fresh check reached the upstream').toBeDefined();
    expect(fresh?.aborted).toBe(false);
    expect(fresh?.completed).toBe(true);
  });

  test('a reload clears the page-local health results', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();

    // Health state is page-local: after a full reload the row starts clean
    // again instead of replaying a stale result.
    await page.reload();
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    const check = modelRow(page, E2E_HEALTH_OK_MODEL).getByRole('button', { name: /check health/i });
    await expect(check).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_OK_MODEL).getByText(/^ok$/i)).toHaveCount(0);
  });
});
