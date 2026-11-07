import { expect } from '@playwright/test';
import { adminUrl, clickSearch, expectRealPagination, nextPage, previousPage, tableBodyRows, test } from './helpers.ts';

/** Fixture-backed filters and pagination for the remaining admin lists, plus chat-scope deep links. */
test.use({ signedIn: true });

test.describe('messages list', () => {
  test('Next fetches only the second cursor page', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
  });

  test('search narrows to the exact seeded message', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    await page.getByRole('textbox', { name: 'Search text or caption' }).fill('e2e message 5');
    await page.getByRole('textbox', { name: 'Search text or caption' }).press('Enter');
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('e2e message 5', { exact: true })).toBeVisible();
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/messages'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No messages match the current filters.')).toBeVisible();
  });
});

test.describe('contexts list', () => {
  test('Next fetches only the second cursor page', async ({ page }) => {
    await page.goto(await adminUrl('/contexts'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    await nextPage(page).click();
    await expect(rows).toHaveCount(2);
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/contexts'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No conversation contexts', { exact: true })).toBeVisible();
  });
});

test.describe('alarms list', () => {
  test('target filter keeps the seeded target and empties for an unknown one', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    await page.getByRole('textbox', { name: 'Target user ID' }).fill('42');
    await page.getByRole('textbox', { name: 'Target user ID' }).press('Enter');
    await expect(tableBodyRows(page).first()).toBeVisible();
    await expectRealPagination(page);
    await page.getByRole('textbox', { name: 'Target user ID' }).fill('999999');
    await page.getByRole('textbox', { name: 'Target user ID' }).press('Enter');
    await expect(page.getByText('No alarms match these filters.')).toBeVisible();
  });

  test('state filter shows the pre-cancelled alarm', async ({ page }) => {
    await page.goto(await adminUrl('/alarms'));
    await page.getByRole('combobox', { name: 'State' }).selectOption('cancelled');
    await clickSearch(page);
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('e2e alarm already cancelled')).toBeVisible();
  });
});

test.describe('memories list', () => {
  test('Next fetches only the second cursor page', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    await nextPage(page).click();
    await expect(rows).toHaveCount(5);
  });

  test('state=expired keeps only the expired seed memo', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('combobox', { name: 'State' }).selectOption('expired');
    await clickSearch(page);
    await expect(tableBodyRows(page)).toHaveCount(1);
    await expect(page.getByText('Old note that expired already.')).toBeVisible();
    await expect(page.getByText('expired', { exact: true }).first()).toBeVisible();
  });

  test('long-term filter is empty because every seed memo is short-term', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('combobox', { name: 'State' }).selectOption('long');
    await clickSearch(page);
    await expect(page.getByText('No memos match these filters.')).toBeVisible();
  });

  test('chat filter empties the list for an unknown chat', async ({ page }) => {
    await page.goto(await adminUrl('/memories'));
    await page.getByRole('combobox', { name: 'Chat', exact: true }).fill('999999999');
    await page.getByRole('combobox', { name: 'Chat', exact: true }).press('Enter');
    await expect(page.getByText('No memos match these filters.')).toBeVisible();
  });
});

test.describe('stickers list', () => {
  const stickerRows = (page: Parameters<typeof tableBodyRows>[0]): ReturnType<typeof tableBodyRows> =>
    page.locator('table').nth(1).locator('tbody tr');

  test('Next fetches only the second cursor page', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    const rows = stickerRows(page);
    await expect(rows).toHaveCount(25);
    await expectRealPagination(page);
    await nextPage(page).last().click();
    await expect(rows).toHaveCount(5);
  });

  test('set filter splits the two seeded sets', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('combobox', { name: 'Sticker set' }).selectOption('legacy');
    await clickSearch(page);
    await expect(stickerRows(page)).toHaveCount(12);
    await page.getByRole('combobox', { name: 'Sticker set' }).selectOption('mascot');
    await clickSearch(page);
    await expect(stickerRows(page)).toHaveCount(18);
  });

  test('index-state filter keeps only error rows', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('combobox', { name: 'Index state' }).selectOption('error');
    await clickSearch(page);
    await expect(stickerRows(page)).toHaveCount(3);
  });

  test('search matches the seeded emoji and paginates the filtered result', async ({ page }) => {
    await page.goto(await adminUrl('/stickers'));
    await page.getByRole('textbox', { name: 'Search description or emoji' }).fill('e2e');
    await page.getByRole('textbox', { name: 'Search description or emoji' }).press('Enter');
    await expect(stickerRows(page)).toHaveCount(25);
    await nextPage(page).last().click();
    await expect(stickerRows(page)).toHaveCount(3);
  });
});

test.describe('whole-response admin list', () => {
  test('client pagination keeps real totals, different pages, Previous and filter reset', async ({ page }) => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      telegram_user_id: String(100000000000000 + index),
    }));
    await page.route('**/api/admins', (route) => route.fulfill({ json: { items, revision: 'fixture-revision' } }));
    await page.goto(await adminUrl('/admins'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(10);
    await expect(page.getByText('12 records', { exact: true })).toBeVisible();
    await expectRealPagination(page);
    const firstPageIds = await rows.locator('td:first-child').allTextContents();

    await nextPage(page).click();
    await expect(rows).toHaveCount(2);
    expect(await rows.locator('td:first-child').allTextContents()).not.toEqual(firstPageIds);
    await expect(page.getByText(items[10]?.telegram_user_id ?? '', { exact: true })).toBeVisible();
    await previousPage(page).click();
    await expect(rows).toHaveCount(10);
    expect(await rows.locator('td:first-child').allTextContents()).toEqual(firstPageIds);

    await nextPage(page).click();
    await expect(rows).toHaveCount(2);
    const filter = page.getByRole('textbox', { name: 'Telegram user ID', exact: true });
    await filter.fill(items[11]?.telegram_user_id ?? '');
    await filter.press('Enter');
    await expect(rows).toHaveCount(1);
    await expect(page.getByText('1 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(rows).toHaveCount(10);
    await expect(page.getByText('12 records', { exact: true })).toBeVisible();
    await expect(previousPage(page)).toBeDisabled();
  });

  test('deleting the only row on the last client page returns to the previous page', async ({ page }) => {
    let items = Array.from({ length: 11 }, (_, index) => ({
      telegram_user_id: String(200000000000000 + index),
    }));
    let revision = 1;
    await page.route('**/api/admins**', async (route) => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        const id = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-1) ?? '');
        items = items.filter((item) => item.telegram_user_id !== id);
        revision += 1;
        await route.fulfill({ json: { items, revision: `fixture-revision-${revision}` } });
        return;
      }
      await route.fulfill({ json: { items, revision: `fixture-revision-${revision}` } });
    });
    await page.goto(await adminUrl('/admins'));
    const rows = tableBodyRows(page);
    await expect(rows).toHaveCount(10);
    await nextPage(page).click();
    await expect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Remove admin', exact: true }).click();
    await expect(rows).toHaveCount(10);
    await expect(page.getByText('10 records', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Page 1', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('chat scope deep links', () => {
  test('chat search param filters the invocations list', async ({ page }) => {
    await page.goto(await adminUrl('/invocations?chat=123456789'));
    await expect(page.getByRole('combobox', { name: 'Chat', exact: true })).toHaveValue('123456789');
    await expect(tableBodyRows(page).first()).toBeVisible();
    await page.goto(await adminUrl('/invocations?chat=999999999'));
    await expect(page.getByText('No records match the current filters.')).toBeVisible();
  });

  test('chat search param filters the messages list', async ({ page }) => {
    await page.goto(await adminUrl('/messages?chat=999999999'));
    await expect(page.getByText('No messages match the current filters.')).toBeVisible();
  });

  test('applying the chat filter writes the URL param and Reset removes it', async ({ page }) => {
    await page.goto(await adminUrl('/invocations'));
    const chatBox = page.getByRole('combobox', { name: 'Chat', exact: true });
    await chatBox.fill('123456789');
    await chatBox.press('Enter');
    await expect(page).toHaveURL(/\?chat=123456789$/);
    await expect(tableBodyRows(page).first()).toBeVisible();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page).toHaveURL(/\/invocations$/);
    await expect(tableBodyRows(page).first()).toBeVisible();
  });
});
