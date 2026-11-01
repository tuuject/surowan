import { expect } from '@playwright/test';
import { test, watchPageIssues } from './helpers.ts';
import { chatRow, inherited, prepareChatsPage, viewOf } from './chats-fixture.ts';

test.use({ signedIn: true });

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('group memory can be enabled, tuned and disabled from the Chat row', async ({ page }) => {
  const finish = watchPageIssues(page);
  const GROUP = '-100555000113';
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
  await page.reload();
  const row = () => chatRow(page, GROUP);
  await expect(row()).toBeVisible();
  await expect(row().getByRole('cell').nth(5)).toHaveText('Off');

  let dialog = page.getByRole('dialog');
  await row().getByRole('button', { name: 'Edit group memory', exact: true }).click();
  await expect(dialog.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
  await dialog.getByRole('switch').click();
  await dialog.getByLabel('Idle minutes before consolidating the current day').fill('45');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: true,
    idle_minutes: 45,
  });
  await expect(row().getByRole('cell').nth(5)).toContainText('On · idle 45 min');

  await row().getByRole('button', { name: 'Edit group memory', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Idle minutes before consolidating the current day').fill('0');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('between 1 and 1440');
  await dialog.getByRole('switch').click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: false,
    idle_minutes: 45,
  });
  await expect(row().getByRole('cell').nth(5)).toHaveText('Off');

  await row().getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  await expect(row()).toHaveCount(0);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
