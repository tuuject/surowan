import { expect, test } from '@playwright/test';
import { bearer, createKeyThroughUi, deferred, signIn, uniqueKeyName } from './api-key-helpers.ts';
import { adminBase, adminUrl } from './helpers.ts';

/**
 * `API key management UI`, revocation: cancelling the confirmation stays
 * request-free, confirming revokes exactly once, and a failed revoke keeps the
 * dialog open with a pending guard until the user retries or cancels.
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
    await context.addCookies([{ name: 'plasticwan_admin', value: sessionToken, url: await adminBase() }]);
  });

  test('keeps a cancelled revocation request-free and revokes only after confirming', async ({ page }) => {
    await page.goto(await adminUrl('/api-keys'));
    const name = uniqueKeyName('revoke');
    const key = await createKeyThroughUi(page, name);

    const main = page.getByRole('main');
    const row = main.locator('table tbody tr', { hasText: name });
    await expect(row).toBeVisible();

    let deletes = 0;
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname.startsWith('/api/api-keys/')) {
        deletes += 1;
      }
    });

    await row.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText('Revoke API key?', { exact: true })).toBeVisible();
    await expect(confirm).toContainText(name);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).not.toBeVisible();
    expect(deletes).toBe(0);
    await expect(row.getByText('Active', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    expect(deletes).toBe(1);

    const afterRevoke = await page.request.get(await adminUrl('/api/invocations'), { headers: bearer(key) });
    expect(afterRevoke.status()).toBe(401);
  });

  test('a failed revoke stays in the confirmation with a pending guard', async ({ page }) => {
    const item = {
      id: '9003',
      name: 'revoke-error-fixture',
      prefix: 'pwk_revokefix',
      created_at: '2026-01-02T03:04:05.000Z',
      last_used_at: null,
      revoked_at: null,
    };
    const gate = deferred();
    let deleteCalls = 0;
    let revoked = false;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        await route.fulfill({
          json: { items: [{ ...item, revoked_at: revoked ? '2026-01-02T03:04:05.000Z' : null }] },
        });
        return;
      }
      if (request.method() === 'DELETE') {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          await gate.promise;
          await route.fulfill({ status: 404, json: { error: 'not_found', message: 'API key does not exist' } });
        } else {
          revoked = true;
          await route.fulfill({ json: { status: 'ok' } });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    const row = main.locator('table tbody tr', { hasText: item.name });
    await row.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: 'Revoke key' }).click();

    // ConfirmDialog pending state: both buttons disabled, no second request.
    await expect.poll(() => deleteCalls).toBe(1);
    await expect(confirm.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    gate.resolve();
    await expect(confirm.getByText('API key does not exist', { exact: false })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Revoke key' })).toBeEnabled();
    expect(deleteCalls).toBe(1);

    // Cancelling closes without a second request and keeps the row active.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).not.toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    expect(deleteCalls).toBe(1);

    // A manual second attempt (error cleared on reopen) can succeed.
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    expect(deleteCalls).toBe(2);
  });
});
