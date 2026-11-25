/**
 * Tuning screenshots: the message-batch timing, the global entry gate and the
 * Harness page's budget and send-protection cards.
 *
 * Each state is written through the page's own form and read back through the
 * API, so a shot never shows a value the server did not accept. The writes run
 * in this order on one server: the gate's keychain entry and the batch timing
 * are plain config applies, while the last test only reads.
 */
import { adminUrl } from '../e2e/helpers.ts';
import { captureScreenshot, scrollToForCapture } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface BucketTiming {
  readonly bucket_window_seconds: number;
  readonly bucket_max_seconds: number | null;
  readonly bucket_bump_seconds: number;
}

interface TelegramView {
  readonly bucket_timing: { readonly saved: BucketTiming; readonly active: BucketTiming };
}

interface GateView {
  readonly saved: { readonly enabled: boolean; readonly mode: string; readonly threshold: number };
  /** What the running process actually does, which may trail the saved file. */
  readonly active: { readonly enabled: boolean; readonly mode: string; readonly threshold: number };
  readonly key_configured: boolean;
  readonly key_source: { readonly kind: string; readonly name?: string } | null;
}

test('tuning/bucket-timing', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/telegram'));
  await expect(page.getByRole('heading', { name: labels.telegram.title, exact: true })).toBeVisible();

  const batches = page.getByRole('region', { name: labels.telegram.bucketTitle, exact: true });
  await expect(batches).toBeVisible();
  const maximum = page.getByLabel(labels.telegram.bucketMax, { exact: true });
  const extension = page.getByLabel(labels.telegram.bucketBump, { exact: true });
  await expect(maximum).toHaveValue('');
  await expect(extension).toHaveValue('0');

  // The documented flow: raise the ceiling, extend per message, save.
  await maximum.fill('60');
  await extension.fill('5');
  await expect(page.getByText(labels.telegram.bucketPending(2), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: labels.telegram.bucketSave, exact: true }).click();
  await expect(page.getByText(labels.telegram.bucketUnchanged, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.telegram.bucketPending(2), { exact: true })).toHaveCount(0);

  const view = await apiJson<TelegramView>(page, await adminUrl('/api/telegram'));
  const applied: BucketTiming = { bucket_window_seconds: 15, bucket_max_seconds: 60, bucket_bump_seconds: 5 };
  expect(view.bucket_timing.saved).toEqual(applied);
  expect(view.bucket_timing.active).toEqual(applied);

  await captureScreenshot(page, docLocale, 'tuning/bucket-timing', 'viewport', {
    scrollTo: batches,
    align: 'start',
  });
});

test('tuning/entry-gate', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  // Taller than the project frame on purpose: the shot must hold both the
  // behaviour card (the switch the guide talks about) and the connection card
  // with the keychain reference, without one covering the other.
  await page.setViewportSize({ width: 1440, height: 1320 });
  await page.goto(await adminUrl('/decision-gate'));
  await expect(page.getByRole('heading', { name: labels.tuning.gate.title, level: 1 })).toBeVisible();

  // Enabling the gate needs a key; the form stores it in the keychain and the
  // file keeps only the reference, which is what the page shows afterwards.
  await page.getByRole('switch', { name: labels.tuning.gate.enabled, exact: true }).check();
  await page.getByLabel(labels.tuning.gate.mode, { exact: true }).selectOption('enforce');
  await page.getByLabel(labels.tuning.gate.apiKey, { exact: true }).fill('docs-entry-gate-key');
  await page.getByRole('button', { name: labels.tuning.gate.save, exact: true }).click();
  await expect(page.getByText(labels.tuning.gate.keyFromEntry('decision-gate'), { exact: true })).toBeVisible();
  await expect(page.getByText(labels.tuning.gate.unchanged, { exact: true })).toBeVisible();

  const view = await apiJson<GateView>(page, await adminUrl('/api/decision-gate'));
  expect(view.saved).toMatchObject({ enabled: true, mode: 'enforce', threshold: 0.57 });
  // The running side, not only the form: the gate is on and enforcing.
  expect(view.active).toMatchObject({ enabled: true, mode: 'enforce' });
  expect(view.key_configured).toBe(true);
  expect(view.key_source).toMatchObject({ kind: 'entry', name: 'decision-gate' });
  await expect(page.getByRole('switch', { name: labels.tuning.gate.enabled, exact: true })).toBeChecked();
  await expect(page.getByLabel(labels.tuning.gate.mode, { exact: true })).toHaveValue('enforce');
  await expect(page.getByText(labels.tuning.gate.keyFromEntry('decision-gate'), { exact: true })).toBeInViewport();

  await captureScreenshot(page, docLocale, 'tuning/entry-gate');
});

test('tuning/harness-budget', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/harness'));
  const budget = page.locator('[data-form-section="budget"]');
  await expect(budget.getByRole('heading', { name: labels.tuning.harness.budget, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: labels.tuning.harness.sections, exact: true })).toBeVisible();
  // The fixture's saved budget values are what the shot documents.
  await expect(page.getByLabel(labels.tuning.harness.dailyBudget, { exact: true })).toHaveValue('300000');
  await expect(page.getByLabel(labels.tuning.harness.maxConcurrency, { exact: true })).toHaveValue('4');
  await expect(page.getByLabel(labels.tuning.harness.historyMessages, { exact: true })).toHaveValue('20');

  // The frame starts at the budget card; the send card must begin inside it, or
  // the image would show budgets only.
  await scrollToForCapture(page, { scrollTo: budget, align: 'start' });
  const send = page.locator('[data-form-section="send"]');
  await expect(send.getByRole('heading', { name: labels.tuning.harness.send, exact: true })).toBeInViewport();
  await expect(page.getByLabel(labels.tuning.harness.dailyBudget, { exact: true })).toBeInViewport();

  await captureScreenshot(page, docLocale, 'tuning/harness-budget', 'viewport', {
    scrollTo: budget,
    align: 'start',
  });
});
