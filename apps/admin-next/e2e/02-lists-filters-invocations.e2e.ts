import { expect } from '@playwright/test';
import { adminUrl, clickSearch, expectRealPagination, nextPage, previousPage, tableBodyRows, test } from './helpers.ts';

/** Real list filters and Previous/Next pagination against the fixture APIs. */
test.use({ signedIn: true });

test.describe('invocations list', () => {
  test('cursor Next shows different rows, Previous restores them, and filters reset to page 1', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    const firstPageIds = await rows.locator('td:first-child').allTextContents();

    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
    const secondPageIds = await rows.locator('td:first-child').allTextContents();
    expect(secondPageIds).not.toEqual(firstPageIds);
    await expect(page.getByText('Page 2, 5 records', { exact: true })).toBeVisible();

    await previousPage(page).click();
    await expect(rows).toHaveCount(25);
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);
    await expect(page.getByText('Page 1, 25 records', { exact: true })).toBeVisible();

    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
    const model = page.getByRole('textbox', { name: 'Model', exact: true });
    await model.fill('gpt-4.1-mini');
    await model.press('Enter');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('Page 1, 2 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();

    // Returning to the unfiltered query must not resurrect its old second page.
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(rows).toHaveCount(25);
    await expect(page.getByText('Page 1, 25 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();
  });

  test('refresh and cursor pagination cannot cancel each other', async ({ page }) => {
    const refreshGate = Promise.withResolvers<void>();
    const nextPageGate = Promise.withResolvers<void>();
    let holdRefresh = false;
    let refreshCalls = 0;
    let nextPageCalls = 0;
    await page.route('**/api/invocations?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/invocations') {
        await route.fallback();
        return;
      }
      if (url.searchParams.has('cursor')) {
        nextPageCalls += 1;
        await nextPageGate.promise;
      } else if (holdRefresh) {
        refreshCalls += 1;
        await refreshGate.promise;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    const refresh = page.getByRole('button', { name: 'Refresh list', exact: true });

    holdRefresh = true;
    await refresh.click();
    await expect.poll(() => refreshCalls).toBe(1);
    await nextPage(page).click();
    expect(nextPageCalls).toBe(0);
    holdRefresh = false;
    refreshGate.resolve();
    await expect(refresh).toBeEnabled();

    await nextPage(page).click();
    await expect.poll(() => nextPageCalls).toBe(1);
    await expect(refresh).toBeDisabled();
    nextPageGate.resolve();
    await expect(rows).toHaveCount(5);
  });

  test('Previous wins over a slower pending Next response', async ({ page }) => {
    const thirdPageGate = Promise.withResolvers<void>();
    const firstPageIds: string[] = [];
    let cursorCalls = 0;
    await page.route('**/api/invocations?*', async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has('cursor')) {
        await route.fallback();
        return;
      }
      cursorCalls += 1;
      if (cursorCalls === 1) {
        const response = await route.fetch();
        const body = (await response.json()) as { items: { id: string }[]; next_cursor: string | null };
        // Advertise one more page so Next is available while standing on page 2.
        body.next_cursor = body.items.at(-1)?.id ?? null;
        await route.fulfill({ response, json: body });
        return;
      }
      await thirdPageGate.promise;
      await route.fulfill({ json: { items: [], next_cursor: null } });
    });

    await page.goto(await adminUrl('/invocations'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    firstPageIds.push(...(await rows.locator('td:first-child').allTextContents()));
    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
    const thirdResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/invocations' && cursorCalls === 2,
    );
    await nextPage(page).click();
    await expect.poll(() => cursorCalls).toBe(2);
    await previousPage(page).click();
    await expect(rows).toHaveCount(25);
    thirdPageGate.resolve();
    await thirdResponse;
    await expect(page.getByRole('button', { name: 'Refresh list', exact: true })).toBeEnabled();
    await expect(page.getByText('Page 1, 25 records', { exact: true })).toBeVisible();
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);
  });

  test('an initial failure does not invent an empty page or a zero count', async ({ page }) => {
    let failed = false;
    await page.route('**/api/invocations?*', async (route) => {
      if (!failed && new URL(route.request().url()).pathname === '/api/invocations') {
        failed = true;
        await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic cursor failure' } });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/invocations'));
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic cursor failure' })).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByText('Page 1, 0 records', { exact: true })).toHaveCount(0);
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
