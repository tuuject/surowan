import { expect, test } from '@playwright/test';
import { bodyContains, deferred, signIn } from './api-key-helpers.ts';
import { adminBase, adminUrl } from './helpers.ts';

/**
 * `API key management UI`, failure and layout states: a failing list offers
 * Retry and recovers, a failed create stays inline with a pending guard, and
 * the page fits a narrow dark viewport without full-page horizontal overflow.
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

  test('a list failure offers Retry and recovers without inventing rows', async ({ page }) => {
    let listCalls = 0;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        listCalls += 1;
        if (listCalls === 1) {
          await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic list failure' } });
        } else {
          await route.fulfill({
            json: {
              items: [
                {
                  id: '9001',
                  name: 'retry-fixture',
                  prefix: 'pwk_retryfix',
                  created_at: '2026-01-02T03:04:05.000Z',
                  last_used_at: null,
                  revoked_at: null,
                },
              ],
            },
          });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    await expect(main.getByText('Synthetic list failure', { exact: false })).toBeVisible();
    await expect(main.locator('table tbody tr')).toHaveCount(0);

    await main.getByRole('button', { name: 'Retry' }).click();
    const row = main.locator('table tbody tr', { hasText: 'retry-fixture' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Never used', { exact: true })).toBeVisible();
    await expect(main.getByText('Synthetic list failure', { exact: false })).toHaveCount(0);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  test('a failed create stays inline, cannot double-submit, and retries manually', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard denied');
          },
        },
      });
    });
    const gate = deferred();
    const fakeKey = `pwk_${'A'.repeat(43)}`;
    let createCalls = 0;
    await page.route('**/api/api-keys**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/api-keys')) {
        createCalls += 1;
        if (createCalls === 1) {
          await gate.promise;
          await route.fulfill({ status: 502, json: { error: 'internal', message: 'Synthetic create failure' } });
        } else {
          await route.fulfill({
            json: {
              key: fakeKey,
              item: {
                id: '9002',
                name: 'pending-guard',
                prefix: fakeKey.slice(0, 12),
                created_at: '2026-01-02T03:04:05.000Z',
                last_used_at: null,
                revoked_at: null,
              },
            },
          });
        }
        return;
      }
      await route.fallback();
    });

    await page.goto(await adminUrl('/api-keys'));
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('   ');
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByText('Enter a name of 1–80 characters.')).toBeVisible();
    expect(createCalls).toBe(0);
    await dialog.getByLabel('Name').fill('pending-guard');
    await dialog.getByRole('button', { name: 'Create key' }).click();

    // While the request is held the submit is disabled and no retry fires.
    await expect.poll(() => createCalls).toBe(1);
    await expect(dialog.getByRole('button', { name: /^Creat/ })).toBeDisabled();

    gate.resolve();
    await expect(dialog.getByText('Synthetic create failure', { exact: false })).toBeVisible();
    expect(createCalls).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Create key' })).toBeEnabled();

    // A manual retry is the only way to submit again, and it succeeds once.
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect.poll(() => createCalls).toBe(2);
    const saveDialog = page.getByRole('dialog');
    await expect(saveDialog.getByText('Save your API key', { exact: true })).toBeVisible();
    await saveDialog.getByRole('button', { name: 'Copy API key' }).click();
    await expect(saveDialog.getByText('Could not copy. Select the key and copy it manually.')).toBeVisible();

    await saveDialog.getByRole('button', { name: 'Done' }).click();
    await expect(saveDialog).not.toBeVisible();
    expect(await bodyContains(page, fakeKey)).toBe(false);
  });

  test('fits a narrow dark viewport without full-page horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('admin-theme', 'dark');
    });
    await page.goto(await adminUrl('/api-keys'));
    await expect(page.locator('html')).toHaveClass(/dark/);
    const main = page.getByRole('main');
    await expect(main.getByText('API keys', { exact: true }).first()).toBeVisible();
    await main.getByRole('button', { name: 'Create API key' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
