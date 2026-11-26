import { expect, type Locator, type Page } from '@playwright/test';
import type { ChatSettings, ChatsView } from '../src/lib/api/chats.ts';
import { adminUrl } from './helpers.ts';

export const ACTIVE_CHAT = '123456789';
export const inherited: ChatSettings = { topic_ids: null, provider: null, model: null, thinking_level: null };

export async function viewOf(page: Page): Promise<ChatsView> {
  const response = await page.request.get(await adminUrl('/api/chats'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as ChatsView;
}

export async function editElsewhere(page: Page, settings: ChatSettings): Promise<void> {
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
          ['topic_ids', 'provider', 'model', 'thinking_level'].every((key) => baseline.active?.[key] === null) &&
          (baseline.saved.group_memory === null || baseline.saved.group_memory.enabled === false) &&
          (baseline.active?.group_memory === null || baseline.active.group_memory.enabled === false);
        let request: [string, string, unknown];
        const groupMemoryOn = baseline?.saved?.group_memory?.enabled === true;
        if (baseline === undefined) {
          request = ['/api/chats', 'POST', { id, ...settings }];
        } else if (extra !== undefined) {
          request = [`/api/chats/${extra.id}`, 'DELETE', null];
        } else if (groupMemoryOn) {
          request = [`/api/chats/${id}/group-memory`, 'PUT', { enabled: false }];
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

/**
 * A Chat's row in the wide table or its block in the narrow list: both are in
 * the page, and the list's own width decides which one shows.
 */
export function chatRow(page: Page, id = ACTIVE_CHAT): Locator {
  return page
    .locator('table tbody tr, [data-chat-card]')
    .filter({ visible: true })
    .filter({ has: page.getByText(id, { exact: true }) });
}

function exactly(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** The value beside a label in a row's policy summary, or in its full settings. */
export function labelledValue(scope: Locator, label: string): Locator {
  return scope
    .locator('dt')
    .filter({ hasText: exactly(label) })
    .locator('xpath=following-sibling::dd[1]');
}

/**
 * Opens one Chat's full settings and returns only those: inside its block in
 * the narrow list, or in the detail row right under its table row. Other Chats
 * may stay expanded at the same time.
 */
export async function openChatDetails(row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: /^(Toggle row details|Show all settings)$/ }).click();
  const details = row
    .locator('[data-chat-details]')
    .or(row.locator('xpath=following-sibling::tr[1]').locator('[data-chat-details]'));
  await expect(details).toBeVisible();
  return details;
}

/** Removal sits last in the row's "More actions" menu. */
export async function removeChat(page: Page, row: Locator): Promise<void> {
  await openChatAction(page, row, 'Remove');
  await page.getByRole('button', { name: 'Remove Chat', exact: true }).click();
}

/** Per-chat settings live in the row's "More actions" menu, next to the quick links. */
export async function openChatAction(page: Page, row: Locator, name: string): Promise<void> {
  await row.getByRole('button', { name: 'More actions', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // A separator that bleeds past the scrollable body adds a horizontal scroll container to the panel.
  // Assert the invariant, not the CSS: neither an open menu nor anything inside it may scroll sideways.
  expect(
    await menu.evaluate((panel) =>
      [panel, ...panel.querySelectorAll('*')].some((node) => {
        const style = getComputedStyle(node);
        return (style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1;
      }),
    ),
  ).toBe(false);
  await page.getByRole('menuitem', { name, exact: true }).click();
}

/** Private chats never gate, so their menu has no settings entries. */
export async function expectNoChatAction(page: Page, row: Locator, name: string): Promise<void> {
  await row.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

export async function saveDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save Chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function refetchAfterReconnect(page: Page): Promise<void> {
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

/** Opens the Chats page and restores the fixture baseline before the test runs. */
export async function prepareChatsPage(page: Page): Promise<void> {
  await page.goto(await adminUrl('/chats'));
  await restoreBaseline(page);
  await page.reload();
  await expect(chatRow(page)).toBeVisible();
}
