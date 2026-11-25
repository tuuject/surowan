/**
 * Invocation screenshots: a review draft with its export dialog, and a failed
 * tool session that offers Resume.
 *
 * Both runs come from the docs seed (`e2e/server-docs.ts`): the tool run is
 * completed and carries a read, a send and the Telegram send row; the resume
 * run is the newest of its own Conversation, which is what makes the button
 * real. The review draft is authored through the invocation page, never seeded
 * into localStorage, so the panel's own store writes every word on screen.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { DOCS_IDS } from '../e2e/server-docs-ids.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

// The Resume and Review shots are the only ones that need the docs-only runs.
test.use({ docsRuns: true });

interface InvocationView {
  readonly state: string;
  readonly completion_reason: string | null;
  readonly resume: { readonly available: boolean; readonly reason: string | null };
}

test('tuning/review-export', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl(`/invocations/${DOCS_IDS.toolInvocation.toString()}`));
  await expect(page.getByText(labels.invocations.title(DOCS_IDS.toolInvocation.toString())).first()).toBeVisible();

  // An overall comment and one event comment, both typed on this page.
  await page.getByRole('button', { name: labels.reviews.addOverall, exact: true }).click();
  await page.getByRole('textbox', { name: labels.reviews.overall, exact: true }).fill(seed.reviews.overall);
  await page.getByRole('button', { name: labels.common.save, exact: true }).first().click();
  await expect(page.getByText(seed.reviews.overall, { exact: true })).toBeVisible();

  const overview = page.getByRole('tabpanel', { name: labels.invocations.overviewTab, exact: true });
  const sendCard = overview.locator('article').filter({ hasText: seed.toolRun.reply });
  await expect(sendCard).toBeVisible();
  await sendCard.getByRole('button', { name: labels.invocations.addReviewComment, exact: true }).click();
  await sendCard
    .getByRole('textbox', { name: labels.invocations.reviewComment, exact: true })
    .fill(seed.reviews.toolComment);
  await sendCard.getByRole('button', { name: labels.common.save, exact: true }).click();
  await expect(sendCard.getByText(seed.reviews.toolComment, { exact: true })).toBeVisible();

  // The draft page holds the same comments plus the export settings.
  await page.getByRole('link', { name: labels.reviews.openDraft, exact: true }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByText(seed.reviews.overall, { exact: true })).toBeVisible();
  await expect(page.getByText(seed.reviews.toolComment, { exact: true })).toBeVisible();
  await page.getByLabel(labels.reviews.goal, { exact: true }).fill(seed.reviews.goal);
  await page.getByRole('radio', { name: labels.reviews.purposeDevelop, exact: true }).click();
  // The dialog exports what this panel holds: read the goal and the purpose
  // back before it opens.
  await expect(page.getByLabel(labels.reviews.goal, { exact: true })).toHaveValue(seed.reviews.goal);
  await expect(page.getByRole('radio', { name: labels.reviews.purposeDevelop, exact: true })).toBeChecked();

  const exporter = page.getByRole('region', { name: labels.reviews.exportPanelTitle, exact: true });
  await expect(exporter).toBeVisible();
  await exporter.getByRole('button', { name: labels.reviews.download, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: labels.reviews.confirmTitle, exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: labels.reviews.confirmButton, exact: true })).toBeVisible();
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  // Nothing was exported yet. The capture is the last step: this file's server
  // is gone at the end of the test, so there is nothing to clean up after it.
  await captureScreenshot(page, docLocale, 'tuning/review-export');
});

test('tuning/invocation-resume', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  // Resume is only offered while the host runs; the fixture's registry is moved
  // by hand because no connection manager runs in this process.
  await e2eFetch('/telegram-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'connected' }),
  });
  const id = DOCS_IDS.resumeInvocation.toString();
  await page.goto(await adminUrl(`/invocations/${id}`));
  await expect(page.getByText(labels.invocations.title(id)).first()).toBeVisible();

  const view = await apiJson<InvocationView>(page, await adminUrl(`/api/invocations/${id}`));
  expect(view.state).toBe('failed');
  expect(view.completion_reason).toBe('model_error');
  expect(view.resume).toEqual({ available: true, reason: null });

  // The failed session really carries its tool call and the frozen message.
  const calls = page.getByRole('tab', { name: labels.invocations.toolCallsTab(1), exact: true });
  await expect(calls).toBeVisible();
  await page.getByRole('tab', { name: labels.invocations.overviewTab, exact: true }).click();
  await expect(page.getByText(seed.resumeRun.incoming, { exact: true }).first()).toBeVisible();

  const resume = page.getByRole('button', { name: labels.invocations.resume, exact: true });
  await expect(resume).toBeVisible();
  const refresh = page.getByRole('switch', { name: labels.invocations.autoRefresh, exact: true });
  await expect(refresh).toBeChecked();
  await expect(page.getByRole('switch', { name: labels.invocations.autoScroll, exact: true })).not.toBeChecked();

  await captureScreenshot(page, docLocale, 'tuning/invocation-resume');
});
