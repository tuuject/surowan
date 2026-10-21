import { expect, type Page, test } from '@playwright/test';
import { adminBase, E2E_PASSWORD, E2E_USERNAME, e2eFetch } from './helpers.ts';

/**
 * Auth state machine against the real AdminServer: first-run setup, logout,
 * bad-password handling, and session revocation. Every flow asserts real UI
 * state (shell content / login form), not just response codes.
 */
test.describe.configure({ mode: 'serial' });

async function fillCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
}

async function login(page: Page, base: string, username: string, password: string): Promise<void> {
  await page.goto(base);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await fillCredentials(page, username, password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
}

test('first-run setup creates the administrator and enters the shell', async ({ page }) => {
  const base = await adminBase();
  await page.goto(base);

  // setup_required gate renders the real setup form
  await expect(page.getByText('Create the administrator account')).toBeVisible();
  await fillCredentials(page, E2E_USERNAME, E2E_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // shell with the real Overview payload
  await expect(page.getByText('Stored messages')).toBeVisible();
  await expect(page.getByText('Cached media analyses')).toBeVisible();
  await expect(page.getByText('Bot status')).toBeVisible();
  await expect(page.getByText(E2E_USERNAME)).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('logout returns to the login form; bad password shows invalid_credentials and keeps the URL', async ({ page }) => {
  const base = await adminBase();
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);

  // Sign out from the shell footer → login form (not an error screen)
  await page.getByText('Sign out').click();
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // wrong password: inline error with the stable code, URL unchanged
  const before = page.url();
  await fillCredentials(page, E2E_USERNAME, 'definitely-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('invalid_credentials', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(before);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();

  // correct login restores the shell
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);
});

test('a revoked session is bounced to the login form without an error screen', async ({ page }) => {
  const base = await adminBase();
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);

  // Revoke every admin session straight from the database.
  const revoked = await e2eFetch<{ deleted: number }>('/revoke-sessions', { method: 'POST' });
  expect(revoked.deleted).toBeGreaterThanOrEqual(1);

  // The next protected request 401s; the global handler returns to the gate.
  await page.goto(await baseURLPath('/invocations'));
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // Signing in again works. The gate preserves the current route
  // (/invocations), so assert the shell, then the overview.
  await fillCredentials(page, E2E_USERNAME, E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Surowan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await page.goto(await baseURLPath('/'));
  await expect(page.getByText('Stored messages')).toBeVisible();
});

async function baseURLPath(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}
