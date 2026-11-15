import { expect } from '@playwright/test';
import { adminUrl, e2eFetch, test, toast } from './helpers.ts';

/**
 * Two operators on the same failed invocation: the slower click is refused,
 * and the page refreshes so the stale Resume button goes away and the run
 * that won shows up as the forward link. A file of its own, because the
 * resume consumes the seeded conversation's only resumable run.
 */
test.use({ signedIn: true });

test('a resume click that lost the race shows the refusal and hides the stale button', async ({ page }) => {
  await e2eFetch('/telegram-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'connected' }),
  });
  await page.goto(await adminUrl('/invocations/4127'));
  await expect(page.getByText('Invocation 4127').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

  // Another operator resumes it first, out of band.
  const other = await page.request.post(await adminUrl('/api/invocations/4127/resume'));
  expect(other.status()).toBe(202);
  const { invocation_id: winner } = (await other.json()) as { invocation_id: string };

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(toast(page, 'only the latest one can be resumed')).toBeVisible();
  await expect(page).toHaveURL(/\/invocations\/4127$/);
  await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await expect(page.getByText('Resumed by')).toBeVisible();
  await expect(page.getByRole('link', { name: winner, exact: true })).toBeVisible();
});
