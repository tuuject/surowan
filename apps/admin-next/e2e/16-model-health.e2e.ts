/**
 * Model health checks against the real `AdminServer`, per row and per batch:
 * the page must trigger exactly one upstream call per click, keep every check
 * control disabled while a check runs, report ok / unexpected / error
 * separately (also in a mixed batch that never stops at a failure), keep its
 * selection across providers, cap the batch at three concurrent calls, settle
 * fast checks visibly before slow ones, fit a narrow phone screen, and never
 * render the provider key.
 *
 * The local upstream (`e2e/server.ts`) verifies the wire shape — a single user
 * message with the fixed prompt, no system role, no tools, an output cap of
 * 128 — and records every body so the spec can assert what actually left the
 * process. The providers these checks hit, and the gate that holds requests
 * open, come from `model-health-fixture.ts`; the page-lifetime behavior lives
 * in `16-model-health-lifecycle.e2e.ts`.
 *
 * UI contract assumed (matches the Models page health-check work):
 * - the row checkbox is labelled `Select {{model}} for a health check`;
 * - the per-row button is "Check health" (aria `Check health of {{model}}`);
 * - the batch button reads `Check selected (N)`;
 * - the health cell shows a status badge and `TTFB … · … ms`;
 * - response text and error text render in the expandable row details
 *   (toggled by the table's "Toggle row details" button).
 */
import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';
import {
  assertHealthRequestShape,
  expandedRow,
  holdHealthGate,
  modelRow,
  providersView,
  releaseHealthGate,
  relayStats,
  resetRelayStats,
  selectProvider,
  showHealthDetails,
  modelHealthFixture,
} from './model-health-fixture.ts';
import {
  E2E_HEALTH_ALIAS_A,
  E2E_HEALTH_ALIAS_B,
  E2E_HEALTH_FAIL_MODEL,
  E2E_HEALTH_OK_2_MODEL,
  E2E_HEALTH_OK_MODEL,
  E2E_HEALTH_UNEXPECTED_MODEL,
  E2E_SECRETS,
} from './models-fixture.ts';

test.use({ signedIn: true });
modelHealthFixture();

test.describe('model health checks', () => {
  test('a single check reports ok with ttfb and response, and blocks repeats while in flight', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Loading the page and selecting the provider fires no health request.
    await expect.poll(async () => (await relayStats()).total).toBe(0);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    const check = row.getByRole('button', { name: /check health/i });
    await check.click();

    // The row's check is disabled while the call is in flight, so a repeat
    // click cannot fire a second request.
    await expect(check).toBeDisabled();
    await expect.poll(async () => (await relayStats()).total).toBe(1);

    // The result renders in the row: the status badge and ttfb/duration in ms.
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/ms/)).toBeVisible();
    await expect(check).toBeEnabled();

    // The response text lands in the expandable details.
    await showHealthDetails(page, E2E_HEALTH_OK_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_OK_MODEL).getByText('ok', { exact: true })).toBeVisible();

    // The upstream saw exactly the pinned prompt, nothing else.
    const stats = await relayStats();
    expect(stats.rejected).toBe(0);
    expect(stats.by_model).toEqual({ [E2E_HEALTH_OK_MODEL]: 1 });
    expect(stats.bodies).toHaveLength(1);
    assertHealthRequestShape(stats.bodies[0] as Record<string, unknown>, E2E_HEALTH_OK_MODEL);

    // A finished check can run again.
    await check.click();
    await expect.poll(async () => (await relayStats()).total).toBe(2);
    // Let the repeat check settle upstream before the test ends: ending with a
    // request still in flight races the next spec's stats reset against the
    // page-teardown abort and can leave stale state behind.
    await expect.poll(async () => (await relayStats()).in_flight).toBe(0);
    const settled = await relayStats();
    expect(settled.aborted).toBe(0);
    expect(settled.completed).toBe(2);
  });

  test('a mixed batch keeps selection across providers, caps concurrency, and never stops at a failure', async ({
    page,
  }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
    await page.getByLabel(`Select ${E2E_HEALTH_OK_2_MODEL} for a health check`).check();
    await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();

    // Selection survives switching providers: check a model of the second
    // provider, then confirm the first provider's checks are still there.
    await selectProvider(page, E2E_HEALTH_ALIAS_B);
    await page.getByLabel(`Select ${E2E_HEALTH_FAIL_MODEL} for a health check`).check();
    await selectProvider(page, E2E_HEALTH_ALIAS_A);
    await expect(page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`)).toBeChecked();

    const before = await providersView(page);
    // Hold every model upstream so the first three checks stay in flight
    // together: the concurrency cap is observed, not inferred from timing.
    await holdHealthGate();
    try {
      await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();
      await expect.poll(async () => (await relayStats()).in_flight).toBe(3);
      expect((await relayStats()).total).toBe(3);
    } finally {
      await releaseHealthGate();
    }

    // All four models are checked, three in flight at once (never more); the
    // failing one does not interrupt the others.
    await expect.poll(async () => (await relayStats()).total).toBe(4);
    const stats = await relayStats();
    expect(stats.rejected).toBe(0);
    expect(stats.max_concurrent).toBe(3);
    expect(stats.by_model).toEqual({
      [E2E_HEALTH_OK_MODEL]: 1,
      [E2E_HEALTH_OK_2_MODEL]: 1,
      [E2E_HEALTH_UNEXPECTED_MODEL]: 1,
      [E2E_HEALTH_FAIL_MODEL]: 1,
    });
    for (const body of stats.bodies) {
      assertHealthRequestShape(body, String(body.model));
    }

    // Each outcome is displayed on its own row; the unexpected reply and the
    // upstream error are readable in the expandable details.
    await expect(modelRow(page, E2E_HEALTH_OK_MODEL).getByText(/^ok$/i)).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_OK_2_MODEL).getByText(/^ok$/i)).toBeVisible();
    await expect(modelRow(page, E2E_HEALTH_UNEXPECTED_MODEL).getByText('Unexpected response')).toBeVisible();
    await showHealthDetails(page, E2E_HEALTH_UNEXPECTED_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_UNEXPECTED_MODEL).getByText('hello')).toBeVisible();

    await selectProvider(page, E2E_HEALTH_ALIAS_B);
    await expect(modelRow(page, E2E_HEALTH_FAIL_MODEL).getByText('Error', { exact: true })).toBeVisible();
    await showHealthDetails(page, E2E_HEALTH_FAIL_MODEL);
    await expect(expandedRow(page, E2E_HEALTH_FAIL_MODEL).getByText(/fixture upstream failure/)).toBeVisible();

    // Health checks are read-only: the configuration and the model references
    // did not move, and the provider key never reached the DOM.
    const after = await providersView(page);
    expect(after.revision).toBe(before.revision);
    expect(after.agent).toEqual(before.agent);
    expect(after.vision).toEqual(before.vision);
    expect(await page.content()).not.toContain(E2E_SECRETS.health);
  });

  test('a fast check settles visibly while a slow one is still checking', async ({ page }) => {
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    // Hold the slow model upstream before the batch starts, so the fast result
    // settling next to a still-"Checking…" row does not depend on timing: the
    // slow request cannot settle until released.
    await holdHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
    try {
      await page.getByLabel(`Select ${E2E_HEALTH_OK_MODEL} for a health check`).check();
      await page.getByLabel(`Select ${E2E_HEALTH_UNEXPECTED_MODEL} for a health check`).check();
      await page.getByRole('button', { name: /^Check selected \(\d+\)$/ }).click();

      // The fast row already shows its status and timing while the slow row is
      // still in flight — a finished and a running check coexist row by row.
      const fast = modelRow(page, E2E_HEALTH_OK_MODEL);
      const slow = modelRow(page, E2E_HEALTH_UNEXPECTED_MODEL);
      await expect(fast.getByText(/^ok$/i)).toBeVisible();
      await expect(fast.getByText(/TTFB/)).toBeVisible();
      await expect(slow.getByText('Checking…')).toBeVisible();

      // The slow check settles once released.
      await releaseHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
      await expect(slow.getByText('Unexpected response')).toBeVisible({ timeout: 15_000 });
      expect((await relayStats()).total).toBe(2);
    } finally {
      await releaseHealthGate(E2E_HEALTH_UNEXPECTED_MODEL);
    }
  });

  test('a checked model with its result fits a narrow phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetRelayStats();
    await page.goto(await adminUrl('/models'));
    await selectProvider(page, E2E_HEALTH_ALIAS_A);

    const row = modelRow(page, E2E_HEALTH_OK_MODEL);
    await row.getByRole('button', { name: /check health/i }).click();
    await expect(row.getByText(/^ok$/i)).toBeVisible();
    await expect(row.getByText(/ms/)).toBeVisible();

    // The page itself must not scroll sideways; the table scrolls internally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
