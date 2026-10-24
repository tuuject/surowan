import { expect, test } from '@playwright/test';
import {
  bearer,
  bodyContains,
  deferred,
  installClipboardRecorder,
  signIn,
  storageHasApiKey,
  uniqueKeyName,
} from './api-key-helpers.ts';
import { adminBase, adminUrl } from './helpers.ts';

/**
 * `API key management UI`, creation and one-time display: sidebar entry,
 * one-time plaintext, clipboard handling, storage hygiene, deep-link reload,
 * and dropping the dialog on Escape, refresh, history navigation and session
 * expiry. Revocation lives in `14-api-keys-ui-revoke.e2e.ts`; failure and
 * pending states in `14-api-keys-ui-failures.e2e.ts`.
 *
 * This spec signs in itself instead of relying on the shared storage state, so
 * it also passes when run on its own (`pnpm run admin:test:e2e 14-api-keys`).
 */
// Playwright also saves an ARIA error snapshot even with trace/screenshots off.
// This page displays a live key; failure artifacts must not capture its value.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', screenshot: 'off', video: 'off' });

let sessionToken = '';

test.beforeAll(async ({ request }) => {
  sessionToken = (await signIn(request)).sessionToken;
});

/**
 * The real key-management surface. All tests reuse the API login above by
 * injecting its session cookie, so this block stays standalone-runnable. The
 * plaintext key lives only in the browser and in test memory: clipboard writes
 * are stubbed, artifacts are off, and every secret-shaped assertion is a
 * boolean (never `expect(key)` / `toContain(key)`, which would print it).
 */
test.describe('API key management UI', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: 'surowan_admin', value: sessionToken, url: await adminBase() }]);
  });

  test('creates a key from the sidebar, shows it once, and drops the plaintext afterwards', async ({ page }) => {
    await installClipboardRecorder(page);
    await page.goto(await adminUrl('/'));
    const manageGroup = page.locator('[data-sidebar="group"]').filter({ hasText: 'Manage' });
    await expect(manageGroup.getByRole('link', { name: 'API keys', exact: true })).toBeVisible();
    await manageGroup.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page).toHaveURL(/\/api-keys$/);

    const main = page.getByRole('main');
    await expect(main.getByText('API keys', { exact: true }).first()).toBeVisible();
    // The permission note names the inspection/export surface without granting production writes.
    const permissionNote = main.getByText(/surowan-utils CLI/);
    await expect(permissionNote).toBeVisible();
    await expect(permissionNote).toContainText('read redacted configuration and global/group prompts');
    await expect(permissionNote).toContainText('export snapshot-authorized media');
    await expect(permissionNote).toContainText('temporary prompt overrides');
    await expect(permissionNote).toContainText('cannot change production prompts or configuration, or manage keys');
    await expect(permissionNote).toContainText('may incur charges');
    await expect(main.getByRole('button', { name: 'Create API key' })).toBeVisible();

    const name = uniqueKeyName('once');
    await main.getByRole('button', { name: 'Create API key' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog.getByText('Create API key', { exact: true })).toBeVisible();
    await expect(createDialog.getByLabel('Name')).toHaveAttribute('maxlength', '80');
    await createDialog.getByLabel('Name').fill(name);
    await createDialog.getByRole('button', { name: 'Create key' }).click();

    const saveDialog = page.getByRole('dialog');
    await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
    await expect(saveDialog.getByText(/shown only once/i)).toBeVisible();
    const apiKeyBox = saveDialog.getByLabel('API key');
    await expect(apiKeyBox).toBeVisible();
    expect(await apiKeyBox.evaluate((element) => (element as HTMLTextAreaElement).readOnly)).toBe(true);
    const key = await apiKeyBox.inputValue();
    expect(/^pwk_[A-Za-z0-9_-]{43}$/.test(key)).toBe(true);
    expect(await bodyContains(page, key)).toBe(true);

    // No storage wrote the plaintext while the one-time dialog was still open.
    expect(await storageHasApiKey(page)).toBe(false);

    await saveDialog.getByRole('button', { name: 'Copy API key' }).click();
    const copied = await page.evaluate((secret) => {
      const state = window as unknown as { __e2eCopiedText?: string };
      const copied = state.__e2eCopiedText === secret && secret.startsWith('pwk_');
      delete state.__e2eCopiedText;
      return copied;
    }, key);
    expect(copied).toBe(true);

    await saveDialog.getByRole('button', { name: 'Done' }).click();
    await expect(saveDialog).not.toBeVisible();
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);

    // Deep-link reload: the row keeps metadata only, the plaintext is gone.
    await page.reload();
    const row = main.locator('table tbody tr', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText(/pwk_[A-Za-z0-9_-]+/)).toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    await expect(row.getByText('Never used', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toBeVisible();
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);

    // The REST listing repeats metadata, never the key itself.
    const listing = await page.request.get(await adminUrl('/api/api-keys'));
    expect(listing.status()).toBe(200);
    const listingBody = (await listing.json()) as { items: Array<Record<string, unknown>> };
    const listed = listingBody.items.find((item) => item.name === name);
    expect(listed).toBeTruthy();
    expect(Object.hasOwn(listed ?? {}, 'key')).toBe(false);
    expect(listingBody.items.some((item) => Object.hasOwn(item, 'key'))).toBe(false);

    // A key opens the read-only invocation surface and nothing wider.
    const invocations = await page.request.get(await adminUrl('/api/invocations?limit=1'), {
      headers: bearer(key),
    });
    expect(invocations.status()).toBe(200);
    const overview = await page.request.get(await adminUrl('/api/overview'), { headers: bearer(key) });
    expect(overview.status()).toBe(403);
  });

  test('drops an open plaintext dialog on Escape, refresh and history navigation', async ({ page }) => {
    for (const dismissal of ['escape', 'refresh', 'navigation']) {
      await page.goto(await adminUrl('/'));
      await page.getByRole('link', { name: 'API keys', exact: true }).click();
      const name = uniqueKeyName(dismissal);
      await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Create key' }).click();
      await expect(dialog.getByText('Save your API key', { exact: true })).toBeVisible();
      const key = await dialog.getByLabel('API key').inputValue();
      expect(await bodyContains(page, key)).toBe(true);

      if (dismissal === 'escape') {
        await page.keyboard.press('Escape');
      } else if (dismissal === 'refresh') {
        await page.reload();
      } else {
        await page.goBack();
        await expect(page).toHaveURL(await adminUrl('/'));
        await page.getByRole('link', { name: 'API keys', exact: true }).click();
      }
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('main').locator('table tbody tr', { hasText: name })).toBeVisible();
      expect(await bodyContains(page, key)).toBe(false);
      expect(await storageHasApiKey(page)).toBe(false);
    }
  });

  test('clears the one-time dialog when the session expires during the metadata refresh', async ({ page }) => {
    const gate = deferred();
    let expired = false;
    let listCalls = 0;
    await page.route('**/api/api-keys', async (route) => {
      if (route.request().method() === 'GET') {
        listCalls += 1;
        if (listCalls > 1) {
          await gate.promise;
          await route.fulfill({
            status: 401,
            json: { error: 'unauthenticated', message: 'Admin session is required' },
          });
          return;
        }
      }
      await route.fallback();
    });
    await page.route('**/api/auth/session', async (route) => {
      if (expired) {
        await route.fulfill({
          json: {
            setup_required: false,
            authenticated: false,
            username: null,
            expires_at: null,
            passkeys_enabled: process.env.E2E_PASSKEYS === '1',
            has_password: null,
          },
        });
        return;
      }
      await route.fallback();
    });
    await page.goto(await adminUrl('/api-keys'));
    await expect(page.getByRole('columnheader', { name: 'Prefix', exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(uniqueKeyName('session'));
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByText('Save your API key', { exact: true })).toBeVisible();
    const key = await dialog.getByLabel('API key').inputValue();
    expect(await bodyContains(page, key)).toBe(true);
    expired = true;
    gate.resolve();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await bodyContains(page, key)).toBe(false);
    expect(await storageHasApiKey(page)).toBe(false);
  });
});
