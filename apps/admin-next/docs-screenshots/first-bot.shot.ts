/**
 * First-bot screenshots: the Chat allowlist and the Telegram page in both
 * token states.
 *
 * The fixture config already references a `telegram` keychain entry, so a
 * fresh server starts "token configured". The empty state is reached the way
 * an operator reaches it: the Clear token dialog. The connection status comes
 * from the E2E fixture hook that moves the connection registry (this process
 * runs no live connection manager) — the page then polls and renders it.
 *
 * The allowlist runs first: it shares the file's server, and a config write
 * (the token clear at the end) leaves the fixture's known `admin.port` restart
 * entry pending, which the Chats page would then show as a banner.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface TelegramView {
  readonly token_configured: boolean;
  readonly status: { readonly status: string };
}

async function setConnection(status: 'connected' | 'disabled'): Promise<void> {
  await e2eFetch('/telegram-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

test('first-bot/chat-allowlist', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/chats'));
  await expect(page.getByRole('heading', { name: labels.chats.title, exact: true })).toBeVisible();

  const row = page.locator('table tbody tr').filter({ hasText: '123456789' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(seed.chatTitle);
  await expect(row).toContainText(labels.chats.active);
  await expect(page.locator('table tbody tr')).toHaveCount(1);

  await captureScreenshot(page, docLocale, 'first-bot/chat-allowlist');
});

test('first-bot/telegram-connected', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/telegram'));
  await expect(page.getByRole('heading', { name: labels.telegram.title, exact: true })).toBeVisible();

  // The documented flow sets the token on this page. The value is a placeholder
  // that never leaves the fixture; the form must accept and persist it.
  await page.getByLabel(labels.telegram.tokenLabel, { exact: true }).fill('123456:DOCS-EXAMPLE-TOKEN');
  await page.getByRole('button', { name: labels.telegram.save, exact: true }).click();
  await expect(page.locator('[data-koi-toast]').filter({ hasText: labels.telegram.saved })).toBeVisible();
  await expect(page.getByText(labels.telegram.tokenConfigured, { exact: true })).toBeVisible();

  // The fixture runs no connection manager, so the registry is moved by hand;
  // reload once it is settled rather than racing the page's 10 s status poll.
  await setConnection('connected');
  await page.reload();
  await expect(page.getByText(labels.telegram.connected, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.telegram.tokenConfigured, { exact: true })).toBeVisible();
  await expect(page.getByText('@surowan_bot', { exact: true })).toBeVisible();

  const view = (await (await page.request.get(await adminUrl('/api/telegram'))).json()) as TelegramView;
  expect(view.status.status).toBe('connected');
  expect(view.token_configured).toBe(true);

  await captureScreenshot(page, docLocale, 'first-bot/telegram-connected');
});

test('first-bot/telegram-token-empty', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  // Without a token Telegram cannot be connected; keep the page coherent.
  await setConnection('disabled');
  await page.goto(await adminUrl('/telegram'));
  await expect(page.getByText(labels.telegram.tokenConfigured, { exact: true })).toBeVisible();

  // The real dialog deletes the keychain value and leaves the section in place.
  await page.getByRole('button', { name: labels.telegram.clear, exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: labels.telegram.clear, exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText(labels.telegram.tokenMissing, { exact: true })).toBeVisible();
  // The connection panel must show the reason the page is empty, not a stale status.
  await expect(page.getByText(labels.telegram.disabled, { exact: true })).toBeVisible();
  await expect(page.getByLabel(labels.telegram.tokenLabel, { exact: true })).toHaveValue('');

  const view = (await (await page.request.get(await adminUrl('/api/telegram'))).json()) as TelegramView;
  expect(view.token_configured).toBe(false);
  expect(view.status.status).toBe('disabled');

  await captureScreenshot(page, docLocale, 'first-bot/telegram-token-empty');
});
