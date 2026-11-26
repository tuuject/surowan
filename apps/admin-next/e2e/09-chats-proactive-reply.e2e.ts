import { expect, type Locator } from '@playwright/test';
import {
  chatRow,
  expectNoChatAction,
  inherited,
  labelledValue,
  openChatAction,
  openChatDetails,
  prepareChatsPage,
  removeChat,
  viewOf,
} from './chats-fixture.ts';
import { test, watchPageIssues } from './helpers.ts';

test.use({ signedIn: true });

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('proactive-reply editing follows inherit, off and custom values per group', async ({ page }) => {
  const finish = watchPageIssues(page);
  const GROUP = '-100555000112';
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
  const groupRow = () => chatRow(page, GROUP);
  const proactive = () => labelledValue(groupRow(), 'Proactive replies');
  await page.reload();
  await expect(groupRow()).toBeVisible();
  // Global proactive replies are off in the fixture: an inherited "off" stays out of
  // the summary, and the full settings still name it.
  await expect(labelledValue(groupRow(), 'Active hours')).toBeVisible();
  await expect(proactive()).toHaveCount(0);
  const details = await openChatDetails(groupRow());
  await expect(labelledValue(details, 'Proactive replies')).toHaveText('Off (inherited)');
  await groupRow().getByRole('button', { name: 'Toggle row details', exact: true }).click();

  const openDialog = async (): Promise<Locator> => {
    await openChatAction(page, groupRow(), 'Edit proactive reply chance');
    return page.getByRole('dialog');
  };
  // Private chats never schedule proactive replies.
  await expectNoChatAction(page, chatRow(page), 'Edit proactive reply chance');

  let dialog = await openDialog();
  await expect(dialog.getByRole('radio', { name: /Follow the global setting/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /Use custom values for this Chat/ }).click();
  await dialog.getByLabel('Chance on the first try (%)').fill('25');
  await dialog.getByLabel('Increase after each miss (%)').fill('5');
  await dialog.getByLabel('Maximum tries (guaranteed hit at this try)').fill('4');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.25,
    increment: 0.05,
    hard_pity: 4,
  });
  await expect(proactive()).toHaveText('25% first, +5% per miss, guaranteed by try 4');

  dialog = await openDialog();
  await expect(dialog.getByRole('radio', { name: /Use custom values for this Chat/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /Turn proactive replies off/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.proactive_reply).toEqual({
    enabled: false,
  });
  // A Chat that turns it off on its own differs from the global setting, so the summary shows it.
  await expect(proactive()).toHaveText('Off');

  dialog = await openDialog();
  await dialog.getByRole('radio', { name: /Follow the global setting/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.proactive_reply).toBeNull();
  await expect(proactive()).toHaveCount(0);

  dialog = await openDialog();
  await dialog.getByRole('radio', { name: /Use custom values for this Chat/ }).click();
  await dialog.getByLabel('Chance on the first try (%)').fill('120');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('between 0 and 100');
  // A cleared field is rejected instead of saving as 0%.
  await dialog.getByLabel('Chance on the first try (%)').fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('between 0 and 100');
  await dialog.getByLabel('Chance on the first try (%)').fill('20');
  await dialog.getByLabel('Increase after each miss (%)').fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('between 0 and 100');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.proactive_reply).toBeNull();

  // A probability finer than the dialog displays survives an edit of another field.
  await page.evaluate(async (id) => {
    const view = await (await fetch('/api/chats')).json();
    const response = await fetch(`/api/chats/${id}/proactive-reply`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': view.revision },
      body: JSON.stringify({ mode: 'custom', base_probability: 0.123456, increment: 0.0123456, hard_pity: 6 }),
    });
    if (!response.ok) {
      throw new Error(`Seeding proactive reply failed: ${response.status}`);
    }
  }, GROUP);
  await page.reload();
  dialog = await openDialog();
  await expect(dialog.getByLabel('Chance on the first try (%)')).toHaveValue('12.35');
  await dialog.getByLabel('Maximum tries (guaranteed hit at this try)').fill('7');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === GROUP)?.saved?.proactive_reply).toEqual({
    enabled: true,
    base_probability: 0.123456,
    increment: 0.0123456,
    hard_pity: 7,
  });

  await removeChat(page, groupRow());
  await expect(groupRow()).toHaveCount(0);
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
