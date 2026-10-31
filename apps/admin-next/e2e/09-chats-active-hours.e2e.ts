import { expect, type Locator } from '@playwright/test';
import { test, watchPageIssues } from './helpers.ts';
import { chatRow, inherited, prepareChatsPage, viewOf } from './chats-fixture.ts';

test.use({ signedIn: true });

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('active-hours editing sets custom periods, an empty schedule and back to unrestricted', async ({ page }) => {
  const finish = watchPageIssues(page);
  // Only groups gate participation; the fixture's only Chat is private, so the
  // suite hot-adds its own group and removes it at the end.
  const GROUP = '-100555000111';
  await page.evaluate(
    async ({ id, settings }) => {
      const view = await (await fetch('/api/chats')).json();
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify({ id, ...settings }),
      });
      if (!response.ok) {
        throw new Error(`Adding the group Chat failed: ${response.status}`);
      }
    },
    { id: GROUP, settings: inherited },
  );
  const groupRow = () => page.locator('table tbody tr').filter({ has: page.getByText(GROUP, { exact: true }) });
  // The POST bypasses React Query: reload so the new row renders.
  await page.reload();
  await expect(groupRow()).toBeVisible();
  const openDialog = async (): Promise<Locator> => {
    await groupRow().getByRole('button', { name: 'Edit active hours', exact: true }).click();
    return page.getByRole('dialog');
  };
  // Private chats never gate: no editor entry, no summary.
  await expect(chatRow(page).getByRole('button', { name: 'Edit active hours', exact: true })).toHaveCount(0);
  await expect(chatRow(page).getByRole('cell').nth(3)).toHaveText('');

  // The hot-added group starts unrestricted.
  let dialog = await openDialog();
  await expect(dialog.getByRole('radio', { name: /No schedule restriction/ })).toBeChecked();

  // Custom periods: 09:00–18:00 on weekdays plus a daily evening period.
  await dialog.getByRole('radio', { name: /Custom periods/ }).click();
  await expect(dialog.getByText('Add at least one period, or pick another mode.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add period', exact: true }).click();
  await expect(dialog.getByText(/Times shown in/)).toContainText('UTC');
  await dialog.getByRole('button', { name: 'Sat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Sun', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add period', exact: true }).click();
  await dialog.getByLabel('Start 2').fill('20:00');
  await dialog.getByLabel('End 2').fill('23:30');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = (await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved;
  expect(saved?.participation).toEqual({
    active_windows: [
      { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      { start: '20:00', end: '23:30' },
    ],
  });
  // Each period renders as its own line instead of stretching the table.
  const hoursCell = groupRow().getByRole('cell').nth(3);
  await expect(hoursCell).toContainText('Mon–Fri 09:00–18:00');
  await expect(hoursCell).toContainText('Daily 20:00–23:30');
  await expect(hoursCell.locator('p')).toHaveCount(2);

  // The explicit empty array is a distinct state: trigger-only.
  dialog = await openDialog();
  await expect(dialog.getByRole('radio', { name: /Custom periods/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /No active periods/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.participation).toEqual({
    active_windows: [],
  });
  await expect(groupRow().getByRole('cell').nth(3)).toContainText('Trigger only');

  // Unrestricted removes the participation section entirely.
  dialog = await openDialog();
  await expect(dialog.getByRole('radio', { name: /No active periods/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /No schedule restriction/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.participation).toBeNull();
  await expect(groupRow().getByRole('cell').nth(3)).toContainText('Unrestricted');

  // Custom mode with an empty editor is blocked: the explicit mode covers it.
  dialog = await openDialog();
  await dialog.getByRole('radio', { name: /Custom periods/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Add at least one period');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.participation).toBeNull();

  // On a phone the editor wraps instead of scrolling sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  dialog = await openDialog();
  await dialog.getByRole('radio', { name: /Custom periods/ }).click();
  await dialog.getByRole('button', { name: 'Add period', exact: true }).click();
  await expect(dialog.getByText(/Times shown in/)).toBeVisible();
  expect(
    await page.evaluate(() => {
      const content = document.querySelector('[data-slot="dialog-content"]');
      return content instanceof HTMLElement && content.scrollWidth <= content.clientWidth + 1;
    }),
  ).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });

  await groupRow().getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  await expect(groupRow()).toHaveCount(0);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
