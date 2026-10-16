import { expect, type Locator, type Page } from '@playwright/test';
import type { ChatsView, ChatSettings } from '../src/lib/api.ts';
import { adminUrl, e2eFetch, test, watchPageIssues } from './helpers.ts';

const ACTIVE_CHAT = '123456789';
const inherited: ChatSettings = { topic_ids: null, provider: null, model: null, thinking_level: null };

test.use({ signedIn: true });

async function viewOf(page: Page): Promise<ChatsView> {
  const response = await page.request.get(await adminUrl('/api/chats'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as ChatsView;
}

async function editElsewhere(page: Page, settings: ChatSettings): Promise<void> {
  await page.evaluate(
    async ({ id, settings }) => {
      const view = await (await fetch('/api/chats')).json();
      const response = await fetch(`/api/chats/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': view.revision },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        throw new Error(`Concurrent Chat edit failed: ${response.status}`);
      }
    },
    { id: ACTIVE_CHAT, settings },
  );
}

/**
 * The suite shares one server, so each test starts from the fixture allowlist:
 * only ACTIVE_CHAT, inheriting everything. A failed test may have left extra
 * Chats, removed ACTIVE_CHAT or armed an apply failure that still has to fire.
 * Chats removed after a hot add stay in the running allowlist as
 * "Removal pending" until a restart, and the fixture server never restarts, so
 * such pending rows are expected residue for the rest of the suite.
 */
async function restoreBaseline(page: Page): Promise<void> {
  await page.evaluate(
    async ({ id, settings }) => {
      for (let step = 0; step < 20; step += 1) {
        const view = await (await fetch('/api/chats')).json();
        const saved = view.items.filter((chat: { saved: unknown }) => chat.saved !== null);
        const baseline = saved.find((chat: { id: string }) => chat.id === id);
        const extra = saved.find((chat: { id: string }) => chat.id !== id);
        const inherits =
          baseline !== undefined &&
          ['topic_ids', 'provider', 'model', 'thinking_level'].every((key) => baseline.saved[key] === null) &&
          ['topic_ids', 'provider', 'model', 'thinking_level'].every((key) => baseline.active?.[key] === null);
        let request: [string, string, unknown];
        if (baseline === undefined) {
          request = ['/api/chats', 'POST', { id, ...settings }];
        } else if (extra !== undefined) {
          request = [`/api/chats/${extra.id}`, 'DELETE', null];
        } else if (!inherits) {
          request = [`/api/chats/${id}`, 'PUT', settings];
        } else {
          return;
        }
        const [route, method, body] = request;
        const response = await fetch(route, {
          method,
          headers: { 'content-type': 'application/json', 'if-match': view.revision },
          body: body === null ? null : JSON.stringify(body),
        });
        // An armed apply failure still writes the file; the next pass applies it.
        const error = response.ok ? null : await response.json();
        if (error !== null && !String(error.message).startsWith('config.jsonc was updated but not applied:')) {
          throw new Error(`Restoring the Chat baseline failed: ${response.status} ${error.message}`);
        }
      }
      throw new Error('The Chat baseline did not settle');
    },
    { id: ACTIVE_CHAT, settings: inherited },
  );
}

function chatRow(page: Page, id = ACTIVE_CHAT) {
  return page.locator('table tbody tr').filter({ has: page.getByText(id, { exact: true }) });
}

async function saveDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save Chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function refetchAfterReconnect(page: Page): Promise<void> {
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/chats') && response.request().method() === 'GET',
  );
  // Window-focus refetching is disabled; reconnect still refreshes stale queries.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });
  await refreshed;
}

test.beforeEach(async ({ page }) => {
  await page.goto(await adminUrl('/chats'));
  await restoreBaseline(page);
  await page.reload();
  await expect(chatRow(page)).toBeVisible();
});

test('navigation, exact string IDs and hot add work; removal waits for a restart', async ({ page }) => {
  const finish = watchPageIssues(page);
  await page.getByLabel('Chats', { exact: true }).click();
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
  await expect(page.getByRole('alertdialog')).toContainText('Stored history is kept');
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  // The chat just hot-applied stays in the running allowlist: the removal is
  // only written to the file and waits for a restart.
  await expect(added).toContainText('Removal pending');
  expect((await viewOf(page)).restart_required).toContain('telegram.chats[9007199254740991]');
  await expect(chatRow(page).getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
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
  await page.getByRole('combobox', { name: 'Agent model' }).click();
  await page.getByRole('option', { name: 'vision / vision-model', exact: true }).click();
  const thinking = page.getByRole('combobox', { name: 'Thinking effort' });
  await expect(thinking).toHaveText('off');
  await thinking.click();
  await expect(page.getByRole('option', { name: 'high', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /^Global default/ })).toHaveCount(0);
  await page.getByRole('option', { name: 'off', exact: true }).click();
  await saveDialog(page);
  await expect(chatRow(page).getByRole('cell').nth(2)).toContainText('vision / vision-model');
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.effective).toEqual({
    provider: 'vision',
    model: 'vision-model',
    thinking_level: 'off',
  });

  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).click();
  await page.getByRole('option', { name: 'agent / agent-model', exact: true }).click();
  await thinking.click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await saveDialog(page);
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)?.active?.thinking_level).toBe('high');

  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).click();
  await page.getByRole('option', { name: /^Global default/ }).click();
  await expect(thinking).toContainText('Global default');
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

test('remove confirmation retains its original revision and shows removed active Chats as pending', async ({
  page,
}) => {
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
  await expect(chatRow(page)).toContainText('Removal pending');
  expect((await viewOf(page)).items.find((chat) => chat.id === ACTIVE_CHAT)).toMatchObject({
    saved: null,
    active: inherited,
  });

  await page.getByRole('button', { name: 'Add Chat', exact: true }).click();
  await page.getByLabel('Telegram Chat ID').fill(ACTIVE_CHAT);
  await saveDialog(page);
  await chatRow(page, '-1009876543210').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
  // The hot-added Chat stays in the running allowlist: removal waits for a
  // restart and the row remains visible as pending.
  await expect(chatRow(page, '-1009876543210')).toContainText('Removal pending');
});

test('saved-but-not-applied errors refresh both views and Settings can apply the saved model', async ({ page }) => {
  const before = await viewOf(page);
  await chatRow(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent model' }).click();
  await page.getByRole('option', { name: 'agent / agent-model', exact: true }).click();
  await page.getByRole('combobox', { name: 'Thinking effort' }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
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
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText(`telegram.chats[${ACTIVE_CHAT}].thinking_level`, { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Chats', exact: true }).click();
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
  await chatRow(page).getByRole('button', { name: 'Open related pages' }).click();
  await page.getByRole('menuitem', { name: 'Tool sessions' }).click();
  await expect(page).toHaveURL(/\/invocations\?chat=123456789$/);
  await expect(page.getByRole('combobox', { name: 'State' })).toBeVisible();
  await page.goto(await adminUrl('/chats'));
  await chatRow(page).getByRole('button', { name: 'Open related pages' }).click();
  await page.getByRole('menuitem', { name: 'Prompts' }).click();
  await expect(page).toHaveURL(/\/prompts\?chat=123456789$/);
  await expect(page.getByRole('combobox', { name: 'Scope' })).toContainText('123456789');
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
  await expect(groupRow()).toContainText('Removal pending');
  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
