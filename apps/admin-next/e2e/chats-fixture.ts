import { expect, type Page } from '@playwright/test';

import { adminUrl } from './helpers.ts';
import type { ChatsView, ChatSettings } from '../src/lib/api/chats.ts';

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

export function chatRow(page: Page, id = ACTIVE_CHAT) {
  return page.locator('table tbody tr').filter({ has: page.getByText(id, { exact: true }) });
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
