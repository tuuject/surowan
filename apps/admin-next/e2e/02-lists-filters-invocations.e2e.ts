import { writeFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import {
  adminUrl,
  clickSearch,
  e2eFetch,
  expectRealPagination,
  nextPage,
  previousPage,
  tableBodyRows,
  test,
} from './helpers.ts';

/** Real list filters and snapshot pagination against the fixture APIs. */
test.use({ signedIn: true });

function pageButton(page: Page, number: number) {
  return page.getByRole('button', { name: `Page ${number}`, exact: true });
}

test.describe('invocations list', () => {
  test('Next shows different rows, Previous restores them, and filters reset to page 1', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    await expect(page.getByText('30 records', { exact: true })).toBeVisible();
    const firstPageIds = await rows.locator('td:first-child').allTextContents();

    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
    const secondPageIds = await rows.locator('td:first-child').allTextContents();
    expect(secondPageIds).not.toEqual(firstPageIds);
    await expect(pageButton(page, 2)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('30 records', { exact: true })).toBeVisible();

    await previousPage(page).click();
    await expect(rows).toHaveCount(25);
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);
    await expect(pageButton(page, 1)).toHaveAttribute('aria-current', 'page');

    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
    const model = page.getByRole('textbox', { name: 'Model', exact: true });
    await model.fill('gpt-4.1-mini');
    await model.press('Enter');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('2 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();

    // Returning to the unfiltered query must not resurrect its old second page.
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(rows).toHaveCount(25);
    await expect(page.getByText('30 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();
  });

  test('an invocation that arrives after opening stays out of every page until the notice is used', async ({
    page,
  }, testInfo) => {
    const requests: { offset: string | null; as_of: string | null }[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/invocations') {
        requests.push({ offset: url.searchParams.get('offset'), as_of: url.searchParams.get('as_of') });
      }
    });
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    const firstPageIds = await rows.locator('td:first-child').allTextContents();
    expect(requests[0]).toEqual({ offset: '0', as_of: null });

    const { id: arrival } = await e2eFetch<{ id: string }>('/insert-invocation', { method: 'POST' });
    expect(Number(arrival)).toBeGreaterThan(Number(firstPageIds[0]));

    // A refresh re-reads the snapshot: the same rows, plus the arrival count.
    const notice = page.getByRole('status').filter({ hasText: '1 new record since this list was opened' });
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(notice).toBeVisible();
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);
    await expect(page.getByText('30 records', { exact: true })).toBeVisible();

    // Page 2 is the snapshot's remainder: five rows, none of them repeated
    // from page 1 even though a newer row now sorts before all of them.
    await nextPage(page).click();
    await expect(pageButton(page, 2)).toHaveAttribute('aria-current', 'page');
    await expect(rows).toHaveCount(5);
    const secondPageIds = await rows.locator('td:first-child').allTextContents();
    expect(secondPageIds.filter((id) => firstPageIds.includes(id))).toEqual([]);
    await expect(page.getByText('30 records', { exact: true })).toBeVisible();
    await expect(notice).toBeVisible();
    const pinned = requests.filter((request) => request.as_of !== null);
    expect(pinned.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pinned.map((request) => request.as_of)).size).toBe(1);
    expect(pinned.map((request) => request.offset)).toContain('25');
    expect(Number(pinned[0]?.as_of)).toBe(Number(firstPageIds[0]));

    const screenshot = testInfo.outputPath('snapshot-notice.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('snapshot-notice', { path: screenshot, contentType: 'image/png' });

    const beforeRenew = requests.length;
    await notice.getByRole('button', { name: 'Show new records', exact: true }).click();
    await expect(pageButton(page, 1)).toHaveAttribute('aria-current', 'page');
    await expect(rows).toHaveCount(25);
    await expect(rows.first().locator('td:first-child')).toHaveText(arrival);
    await expect(page.getByText('31 records', { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(requests[beforeRenew]).toEqual({ offset: '0', as_of: null });

    const report = testInfo.outputPath('snapshot-requests.json');
    await writeFile(report, JSON.stringify({ arrival, firstPageIds, secondPageIds, requests }, null, 2));
    await testInfo.attach('snapshot-requests', { path: report, contentType: 'application/json' });
  });

  test('Previous wins over a slower pending Next response', async ({ page }) => {
    const secondPageGate = Promise.withResolvers<void>();
    let secondPageCalls = 0;
    await page.route('**/api/invocations?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/invocations' || url.searchParams.get('offset') !== '25') {
        await route.fallback();
        return;
      }
      secondPageCalls += 1;
      await secondPageGate.promise;
      await route.fallback();
    });

    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    const firstPageIds = await rows.locator('td:first-child').allTextContents();
    const secondResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/invocations' &&
        new URL(response.url()).searchParams.get('offset') === '25',
    );
    await nextPage(page).click();
    await expect.poll(() => secondPageCalls).toBe(1);
    await pageButton(page, 1).click();
    secondPageGate.resolve();
    await secondResponse;
    await expect(pageButton(page, 1)).toHaveAttribute('aria-current', 'page');
    await expect(rows).toHaveCount(25);
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);
  });

  test('an initial failure does not invent an empty page or a zero count', async ({ page }) => {
    let failed = false;
    await page.route('**/api/invocations?*', async (route) => {
      if (!failed && new URL(route.request().url()).pathname === '/api/invocations') {
        failed = true;
        await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic list failure' } });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/invocations'));
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic list failure' })).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByText('0 records', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No records match the current filters.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
    await expect(tableBodyRows(page)).toHaveCount(25);
  });

  test('state filter narrows to completed rows only', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    await page.getByRole('combobox', { name: 'State' }).selectOption('completed');
    await clickSearch(page);
    await expect(tableBodyRows(page)).toHaveCount(25);
    await expect(page.locator('table tbody tr').filter({ hasText: 'failed' })).toHaveCount(0);
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No records match the current filters.')).toBeVisible();
  });

  test('draft edits wait for Search, and Reset plus browser navigation restore applied conditions', async ({
    page,
  }) => {
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    const model = page.getByRole('textbox', { name: 'Model', exact: true });
    let filteredRequests = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/invocations' && url.searchParams.get('model') === 'gpt-4.1-mini') {
        filteredRequests += 1;
      }
    });

    await model.fill('gpt-4.1-mini');
    await expect(rows).toHaveCount(25);
    await expect(page).toHaveURL(/\/invocations$/);
    expect(filteredRequests).toBe(0);

    await clickSearch(page);
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL(/\?model=gpt-4\.1-mini$/);
    expect(filteredRequests).toBe(1);

    await model.fill('draft-that-was-not-applied');
    await expect(rows).toHaveCount(2);
    await page.goBack();
    await expect(model).toHaveValue('');
    await expect(rows).toHaveCount(25);
    await page.goForward();
    await expect(model).toHaveValue('gpt-4.1-mini');
    await expect(rows).toHaveCount(2);

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(model).toHaveValue('');
    await expect(page).toHaveURL(/\/invocations$/);
    await expect(rows).toHaveCount(25);
  });

  test('model filter narrows to the invocations that ran on that model', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    const model = page.getByRole('textbox', { name: 'Model', exact: true });
    await model.fill('gpt-4.1-mini');
    await model.press('Enter');
    await expect(tableBodyRows(page)).toHaveCount(2);
    await expect(page.getByRole('link', { name: '4001' })).toBeVisible();
    await expect(page.getByRole('link', { name: '4002' })).toBeVisible();

    await model.fill('unknown-model');
    await model.press('Enter');
    await expect(page.getByText('No records match the current filters.')).toBeVisible();
  });
});
