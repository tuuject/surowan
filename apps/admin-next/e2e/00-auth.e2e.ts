import { writeFile } from 'node:fs/promises';
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
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
});

test('logout returns to the login form; bad password shows invalid_credentials and keeps the URL', async ({ page }) => {
  const base = await adminBase();
  await login(page, base, E2E_USERNAME, E2E_PASSWORD);

  // Sign out from the user menu → login form (not an error screen)
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

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
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // Signing in again works. The gate preserves the current route
  // (/invocations), so assert the shell, then the overview.
  await fillCredentials(page, E2E_USERNAME, E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);
  await page.goto(await baseURLPath('/'));
  await expect(page.getByText('Stored messages')).toBeVisible();
});

interface CliPairing {
  readonly code: string;
  readonly next: string;
  readonly pairing: { readonly id: string; readonly purpose: string };
}

interface PairingRows {
  readonly sessions: number;
  readonly rows: readonly { id: string; purpose: string; consumed: boolean; client_id: string | null }[];
}

async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
  await page.getByLabel('One-time code').fill(code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('a one-time code from the server CLI signs the browser in exactly once', async ({ page }, testInfo) => {
  const base = await adminBase();
  // The real `surowan pairing create --web`, run against this server's live database.
  const web = await e2eFetch<CliPairing>('/pairing-create?purpose=web', { method: 'POST' });
  expect(web.pairing.purpose).toBe('web');
  expect(web.next).toContain('Sign in with a one-time code');
  const before = await e2eFetch<PairingRows>('/pairing-rows');

  await page.goto(base);
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a one-time code' }).click();
  await expect(page.getByText('Paste the one-time code generated on the server.')).toBeVisible();
  await expect(page.getByText('pairing create --web')).toBeVisible();
  // Client-side shape check before any request.
  await page.getByLabel('One-time code').fill('pwp_not-a-whole-code');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Copy the whole code exactly as the server printed it')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('one-time-code-form.png') });

  // A terminal copy with stray spaces still signs in.
  await page.getByLabel('One-time code').fill(`  ${web.code}  `);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Stored messages')).toBeVisible();
  await expect(page.getByText(E2E_USERNAME)).toBeVisible();
  const signedIn = await e2eFetch<PairingRows>('/pairing-rows');
  expect(signedIn.sessions).toBe(before.sessions + 1);

  // Signed out, the same code is spent.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
  await submitCode(page, web.code);
  await expect(page.getByText('pairing_code_used', { exact: false })).toBeVisible();

  // An agent pairing code is not a sign-in code, and trying it does not spend it.
  await page.getByRole('button', { name: 'Sign in with a password' }).click();
  const client = await e2eFetch<CliPairing>('/pairing-create?purpose=client', { method: 'POST' });
  await submitCode(page, client.code);
  await expect(page.getByText('pairing_code_invalid', { exact: false })).toBeVisible();
  await expect(page.locator('[data-route-error]')).toHaveCount(0);

  // Back to the password form.
  await page.getByRole('button', { name: 'Sign in with a password' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();

  const after = await e2eFetch<PairingRows>('/pairing-rows');
  // Sign-out removed the one session the code opened; the refused codes opened none.
  expect(after.sessions).toBe(before.sessions);
  expect(after.rows).toEqual(
    expect.arrayContaining([
      { id: web.pairing.id, purpose: 'web', consumed: true, client_id: null },
      { id: client.pairing.id, purpose: 'client', consumed: false, client_id: null },
    ]),
  );
  const resultPath = testInfo.outputPath('one-time-code-result.json');
  await writeFile(resultPath, JSON.stringify({ before, signedIn, after }, null, 2));
  await testInfo.attach('one-time-code-result', { path: resultPath, contentType: 'application/json' });
  await testInfo.attach('one-time-code-form', {
    path: testInfo.outputPath('one-time-code-form.png'),
    contentType: 'image/png',
  });
});

async function baseURLPath(path: string): Promise<string> {
  return `${await adminBase()}${path}`;
}
