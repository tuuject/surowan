import { expect } from '@playwright/test';
import {
  ACTIVE_CHAT,
  chatRow,
  editElsewhere,
  inherited,
  openChatAction,
  prepareChatsPage,
  refetchAfterReconnect,
  saveDialog,
  viewOf,
} from './chats-fixture.ts';
import { adminUrl, clickNav, e2eFetch, test, watchPageIssues } from './helpers.ts';

test.use({ signedIn: true });

test.beforeEach(async ({ page }) => {
  await prepareChatsPage(page);
});

test('navigation, exact string IDs and hot add work; removal is immediate', async ({ page }) => {
  const finish = watchPageIssues(page);
  await clickNav(page, 'Telegram', 'Chats');
  await page.getByRole('button', { name: 'Add Chat', exact: true }).click();
  await page.getByLabel('Telegram Chat ID').fill('9007199254740992');
  await page.getByRole('button', { name: 'Save Chat' }).click();
  await expect(page.getByRole('alert')).toContainText('safe integer');
  await page.getByLabel('Telegram Chat ID').fill('9007199254740991');
  await page.getByLabel('Topic IDs').fill('12, 12');
  await page.getByRole('button', { name: 'Save Chat' }).click();
  await expect(page.getByRole('alert')).toContainText('unique positive');
  await page.getByLabel('Topic IDs').fill('');
  await saveDialog(page);
  const added = chatRow(page, '9007199254740991');
  await expect(added).toContainText('Private');
  // The addition is hot: the running allowlist adopts it without a restart.
  await expect(added).toContainText('Active');
  const view = await viewOf(page);
  expect(view.items.find((chat) => chat.id === '9007199254740991')).toMatchObject({
    saved: inherited,
    active: inherited,
  });
  // The fixture's in-memory admin port override keeps a permanent restart
  // entry, so only assert the added chat is not among the pending paths.
  expect(view.restart_required).not.toContain('telegram.chats[9007199254740991]');

  await added.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Memo Pad entries and Blob files');
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  // Removal is hot: the Chat leaves both the saved and the running view at once.
  await expect(chatRow(page, '9007199254740991')).toHaveCount(0);
  expect((await viewOf(page)).restart_required).not.toContain('telegram.chats[9007199254740991]');
  expect((await viewOf(page)).items.find((chat) => chat.id === '9007199254740991')).toBeUndefined();
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});

test('Topic edits show saved and running scopes separately and cancel leaves them unchanged', async ({ page }) => {
  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Topic IDs').fill('12, 34');
  await saveDialog(page);
  const row = chatRow(page);
  await expect(row.getByRole('cell').nth(1)).toContainText('12, 34');
  await expect(row.getByRole('cell').nth(1)).toContainText('Running: All topics');
  await expect(row).toContainText('Changes pending');
  await expect(page.getByRole('button', { name: 'Restart now' })).toBeVisible();
  const before = await viewOf(page);
  expect(before.restart_required).toContain(`telegram.chats[${ACTIVE_CHAT}].topic_ids`);
  expect(before.items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.topic_ids).toBeNull();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Topic IDs').fill('56');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await viewOf(page)).revision).toBe(before.revision);
});

test('Chat models apply hot, thinking options match the model, and global default clears overrides', async ({
  page,
}) => {
  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ label: 'vision / vision-model' });
  const thinking = page.getByRole('combobox', { name: 'Thinking effort' });
  await expect(thinking).toHaveValue('off');
  await expect(page.locator('#chat-thinking option[value="high"]')).toHaveCount(0);
  await expect(page.locator('#chat-thinking option[value="inherit"]')).toHaveCount(0);
  await thinking.selectOption('off');
  await saveDialog(page);
  await expect(chatRow(page).getByRole('cell').nth(2)).toContainText('vision / vision-model');
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.effective).toEqual({
    provider: 'vision',
    model: 'vision-model',
    thinking_level: 'off',
  });

  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ label: 'agent / agent-model' });
  await thinking.selectOption('high');
  await saveDialog(page);
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.thinking_level).toBe('high');

  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ index: 0 });
  await expect(thinking).toHaveValue('inherit');
  await saveDialog(page);
  const reset = await viewOf(page);
  expect(reset.items.find((chat) => chat.id === ACTIVE_CHAT)).toMatchObject({
    saved: { ...inherited, effective: reset.defaults },
    active: { ...inherited, effective: reset.defaults },
  });
});

test('a background refetch cannot upgrade the revision of an open Chat edit', async ({ page }) => {
  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Topic IDs').fill('99');
  await editElsewhere(page, { ...inherited, topic_ids: ['45'] });
  await refetchAfterReconnect(page);
  await expect(page.getByLabel('Topic IDs')).toHaveValue('99');
  await page.getByRole('button', { name: 'Save Chat' }).click();
  await expect(page.getByText('Nothing was saved - reopen the Chat', { exact: false })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(chatRow(page).getByRole('cell').nth(1)).toContainText('45');
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.saved?.topic_ids).toEqual(['45']);
});

test('remove confirmation retains its original revision and removes Chats immediately', async ({ page }) => {
  await page.getByRole('button', { name: 'Add Chat', exact: true }).click();
  await page.getByLabel('Telegram Chat ID').fill('-1009876543210');
  await saveDialog(page);
  await chatRow(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await editElsewhere(page, { ...inherited, topic_ids: ['67'] });
  await refetchAfterReconnect(page);
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  await expect(page.getByText('Nothing was removed', { exact: false })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chatRow(page).getByRole('cell').nth(1)).toContainText('67');

  await chatRow(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  await expect(chatRow(page)).toHaveCount(0);
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)).toBeUndefined();

  await page.getByRole('button', { name: 'Add Chat', exact: true }).click();
  await page.getByLabel('Telegram Chat ID').fill(ACTIVE_CHAT);
  await saveDialog(page);
  await chatRow(page, '-1009876543210').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  // A hot-added Chat is removed just as immediately.
  await expect(chatRow(page, '-1009876543210')).toHaveCount(0);
});

test('saved-but-not-applied errors refresh both views and Settings can apply the saved model', async ({ page }) => {
  const before = await viewOf(page);
  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).selectOption({ label: 'agent / agent-model' });
  await page.getByRole('combobox', { name: 'Thinking effort' }).selectOption('high');
  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await page.getByRole('button', { name: 'Save Chat' }).click();
  await expect(page.getByRole('alert')).toContainText('config.jsonc was updated but not applied:');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(chatRow(page)).toContainText('Changes pending');
  await expect(chatRow(page).getByRole('cell').nth(2)).toContainText('high');
  const failed = await viewOf(page);
  expect(failed.items.find((chat) => chat.id === ACTIVE_CHAT)?.active).toEqual(
    before.items.find((chat) => chat.id === ACTIVE_CHAT)?.active,
  );
  await clickNav(page, 'System', 'Settings');
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText(`telegram.chats[${ACTIVE_CHAT}].thinking_level`, { exact: false })).toBeVisible();
  await clickNav(page, 'Telegram', 'Chats');
  await expect(chatRow(page).getByRole('cell').nth(2)).toContainText('high');
  await expect(chatRow(page).getByText('Active', { exact: true })).toBeVisible();
});

test('mobile dark layout keeps the form and actions usable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.setItem('admin-theme', 'dark');
  });
  await page.reload();
  await expect(page.getByText('Chat allowlist')).toBeVisible();
  await page.getByRole('button', { name: 'Add Chat', exact: true }).click();
  await expect(page.getByLabel('Telegram Chat ID')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Chat' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('quick links open chat-scoped pages', async ({ page }) => {
  await page.goto(await adminUrl('/chats'));
  await openChatAction(page, chatRow(page), 'Tool sessions');
  await expect(page).toHaveURL(/\/invocations\?chat=123456789$/);
  await expect(page.getByRole('combobox', { name: 'State' })).toBeVisible();
  await page.goto(await adminUrl('/chats'));
  await openChatAction(page, chatRow(page), 'Prompts');
  await expect(page).toHaveURL(/\/prompts\?chat=123456789$/);
  await expect(page.getByRole('combobox', { name: 'Scope' })).toHaveValue('chat:123456789');
});
