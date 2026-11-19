import { expect } from '@playwright/test';
import { chatRow, inherited, openChatAction, prepareChatsPage, viewOf } from './chats-fixture.ts';
import { test, watchPageIssues } from './helpers.ts';

test.use({ signedIn: true });

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('group memory can be enabled, tuned and disabled from the Chat row', async ({ page }, testInfo) => {
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
  await openChatAction(page, row(), 'Edit group memory');
  await expect(dialog.getByRole('switch')).not.toBeChecked();
  await dialog.getByRole('switch').click();
  await dialog.getByLabel('Idle minutes before consolidating the current day').fill('45');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: true,
    idle_minutes: 45,
  });
  await expect(row().getByRole('cell').nth(5)).toContainText('On, idle 45 min');
  await expect(row().getByRole('cell').nth(5)).not.toContainText('30-hour');

  await openChatAction(page, row(), 'Edit group memory');
  dialog = page.getByRole('dialog');
  const clock = dialog.getByRole('radiogroup', { name: '30-hour clock for date searches' });
  await expect(clock.getByRole('radio', { name: /^Off/ })).toBeChecked();
  // The previous save's toast reads "restart required" because the fixture
  // overrides admin.port in memory; let it expire so the screenshot shows only
  // the dialog and the tooltip.
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0, { timeout: 10_000 });
  await dialog.getByRole('button', { name: 'About the 30-hour clock' }).hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Japanese broadcasting');
  await expect(tooltip).toContainText('until 6:00 the next morning (30:00)');
  // Capture the bubble once its fade-in has finished, not halfway through.
  await expect(tooltip).toHaveCSS('opacity', '1');
  const tooltipShot = testInfo.outputPath('group-memory-30-hour-tooltip.png');
  await page.screenshot({ path: tooltipShot });
  await testInfo.attach('group-memory-30-hour-tooltip', { path: tooltipShot, contentType: 'image/png' });
  await clock.getByRole('radio', { name: /^On, no overlap/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: true,
    idle_minutes: 45,
    thirty_hour_clock: 'non_overlapping',
  });
  // Hot-applied: nothing about group memory waits for a restart.
  expect((await viewOf(page)).restart_required.filter((path) => path.includes('group_memory'))).toEqual([]);
  await expect(row().getByRole('cell').nth(5)).toContainText('On, idle 45 min, 30-hour clock');

  await openChatAction(page, row(), 'Edit group memory');
  dialog = page.getByRole('dialog');
  await expect(clock.getByRole('radio', { name: /^On, no overlap/ })).toBeChecked();
  await clock.getByRole('radio', { name: /^On, overlapping the previous day/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: true,
    idle_minutes: 45,
    thirty_hour_clock: 'overlapping',
  });

  await openChatAction(page, row(), 'Edit group memory');
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
    thirty_hour_clock: 'overlapping',
  });
  await expect(row().getByRole('cell').nth(5)).toHaveText('Off');

  await openChatAction(page, row(), 'Edit group memory');
  dialog = page.getByRole('dialog');
  await expect(clock.getByRole('radio', { name: /^On, overlapping the previous day/ })).toBeDisabled();
  await dialog.getByRole('switch').click();
  await clock.getByRole('radio', { name: /^Off/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.group_memory).toEqual({
    enabled: true,
    idle_minutes: 45,
  });
  await expect(row().getByRole('cell').nth(5)).toHaveText('On, idle 45 min');

  await row().getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  await expect(row()).toHaveCount(0);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
