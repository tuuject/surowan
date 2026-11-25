/**
 * Admin screenshots: the panel's navigation frame, the keychain and the API
 * key permission modes.
 *
 * Every write below goes through the page's own dialog and is read back through
 * the API afterwards. The API key plaintext is never captured: the one-time
 * dialog is dismissed before the shutter.
 */
import { DOCS_KEYCHAIN, DOCS_PROVIDERS, docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl, e2eFetch } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface KeychainView {
  readonly entries: readonly { readonly name: string }[];
  /** Entry name → the config paths that reference it; null when the file cannot be parsed. */
  readonly usage: {
    readonly file: Readonly<Record<string, readonly string[]>> | null;
    readonly active: readonly string[];
  };
}

interface ApiKeyView {
  readonly items: readonly { readonly name: string; readonly mode: string }[];
}

test('admin/navigation', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  // The fixture runs no live connection manager; this hook moves the shared
  // registry so the dashboard renders a connected bot instead of "loading".
  await e2eFetch('/telegram-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'connected' }),
  });
  await page.goto(await adminUrl('/'));
  const nav = page.getByRole('navigation', { name: labels.nav.mainNavigation, exact: true });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: labels.nav.overview, exact: true })).toBeVisible();
  await expect(page.getByText(labels.overview.storedMessages, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.overview.botStatus, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.overview.recentInvocations, { exact: true })).toBeVisible();
  await expect(page.getByText('@surowan_bot', { exact: true })).toBeVisible();
  // The dashboard loads its cards independently: wait for the rendered run row
  // and the settled warning summary, not just the Telegram identity.
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByText(labels.overview.warningsNone, { exact: true })).toBeVisible();

  await captureScreenshot(page, docLocale, 'admin/navigation');
});

test('admin/keychain', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/keychain'));
  await expect(page.getByRole('heading', { name: labels.keychain.title, exact: true })).toBeVisible();

  // Used entries name the config path that references them; the unused entry is
  // the one the docs seed leaves behind on purpose.
  const used = page.getByRole('row', { name: new RegExp(DOCS_KEYCHAIN.relay) });
  await expect(used).toContainText(`providers.${DOCS_PROVIDERS.relay}.api_key`);
  // The row's own name cell, not its text: another entry's usage path may
  // contain this entry's name (the image credential is named `openrouter`).
  const unused = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: DOCS_KEYCHAIN.unused, exact: true }),
  });
  await expect(unused).toContainText(labels.keychain.unused);

  const view = await apiJson<KeychainView>(page, await adminUrl('/api/keychain'));
  const relay = view.usage.file?.[DOCS_KEYCHAIN.relay] ?? [];
  expect(relay).toContain(`providers.${DOCS_PROVIDERS.relay}.api_key`);
  expect(view.usage.file?.[DOCS_KEYCHAIN.unused] ?? []).toEqual([]);
  expect(view.usage.active).not.toContain(DOCS_KEYCHAIN.unused);

  await captureScreenshot(page, docLocale, 'admin/keychain');
});

test('admin/api-keys', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/api-keys'));
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: labels.apiKeys.create, exact: true })).toBeVisible();

  const keys = [
    { name: seed.apiKeys.read, mode: 'read' },
    { name: seed.apiKeys.readWrite, mode: 'read_write' },
    { name: seed.apiKeys.readPaid, mode: 'read_paid' },
  ] as const;
  for (const key of keys) {
    await main.getByRole('button', { name: labels.apiKeys.create, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(labels.apiKeys.create, { exact: true })).toBeVisible();
    await dialog.getByLabel(labels.apiKeys.name, { exact: true }).fill(key.name);
    await dialog.getByRole('combobox', { name: labels.apiKeys.mode, exact: true }).selectOption(key.mode);
    await dialog.getByRole('button', { name: labels.apiKeys.createConfirm, exact: true }).click();

    // The plaintext is shown once; close it without reading or capturing it.
    await expect(dialog.getByText(labels.apiKeys.saveTitle, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: labels.apiKeys.done, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('table tbody tr').filter({ hasText: key.name })).toBeVisible();
  }

  const view = await apiJson<ApiKeyView>(page, await adminUrl('/api/api-keys'));
  expect(view.items.map((item) => ({ name: item.name, mode: item.mode }))).toEqual(
    expect.arrayContaining(keys.map((key) => ({ name: key.name, mode: key.mode }))),
  );
  await expect(page.locator('table tbody tr')).toHaveCount(keys.length);

  await captureScreenshot(page, docLocale, 'admin/api-keys');
});
