import { type CDPSession, expect } from '@playwright/test';
import { adminBase, adminUrl, test as base, E2E_USERNAME, e2eFetch, watchPageIssues } from './helpers.ts';
import { PASSKEYS_ENABLED, RESTORED_PASSWORD, registerPasskey, test } from './passkeys-fixtures.ts';

/**
 * Real-browser passkey E2E against the real AdminServer + real WebAuthn stack.
 *
 * Mode selection (`E2E_PASSKEYS`), the worker-scoped CDP fixtures and
 * `registerPasskey` live in `./passkeys-fixtures.ts`. The enabled tests share
 * one browser context, so their order matters: the enabled suite is serial.
 */

// ---------------------------------------------------------------------------
// Disabled mode: no admin.public_url → no passkey surface at all.
// ---------------------------------------------------------------------------

if (!PASSKEYS_ENABLED) {
  base.use({ signedIn: true });

  test.describe('passkeys disabled without admin.public_url', () => {
    test('login page offers no passkey entry', async ({ page }) => {
      // Do not revoke the shared storageState session used by the next tests.
      await page.context().clearCookies();
      await page.goto(await adminUrl('/'));
      await expect(page.getByText('Surowan admin sign-in')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
      await expect(page.getByText('Passkeys are unavailable', { exact: false })).toHaveCount(0);
    });

    test('settings page hides the passkey card', async ({ page }) => {
      await page.goto(await adminUrl('/settings'));
      await expect(page.getByText('Admin credentials', { exact: true })).toBeVisible();
      await expect(page.getByText('Passkeys', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Add passkey' })).toHaveCount(0);
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    });

    test('the passkey API answers 404 passkeys_disabled', async ({ page }) => {
      await page.goto(await adminUrl('/settings'));
      const result = await page.evaluate(async () => {
        const probe = async (path: string, method = 'POST'): Promise<{ status: number; error: string | null }> => {
          const response = await fetch(path, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          const body = (await response.json()) as { error?: string };
          return { status: response.status, error: body.error ?? null };
        };
        return {
          list: await probe('/api/auth/passkeys', 'GET'),
          login: await probe('/api/auth/passkeys/login/options'),
          register: await probe('/api/auth/passkeys/register/options'),
        };
      });
      for (const probe of [result.list, result.login, result.register]) {
        expect(probe.status).toBe(404);
        expect(probe.error).toBe('passkeys_disabled');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Enabled mode: real WebAuthn ceremonies via a CDP virtual authenticator.
// ---------------------------------------------------------------------------

if (PASSKEYS_ENABLED) {
  test.describe('passkeys enabled via admin.public_url', () => {
    test.describe.configure({ mode: 'serial' });

    test('does not claim the password is absent while the list is loading or unavailable', async ({ sharedPage }) => {
      const gate = Promise.withResolvers<void>();
      await sharedPage.route('**/api/auth/passkeys', async (route) => {
        await gate.promise;
        await route.fulfill({
          status: 500,
          json: { error: 'fixture_unavailable', message: 'Passkey list unavailable for test' },
        });
      });
      try {
        await sharedPage.goto(await adminUrl('/settings'));
        await expect(sharedPage.getByText('Passkeys', { exact: true })).toBeVisible();
        await expect(sharedPage.getByRole('button', { name: 'Delete password' })).toBeDisabled();
        await expect(sharedPage.getByText('No password is set.', { exact: false })).toHaveCount(0);
        await expect(sharedPage.getByText('not set', { exact: true })).toHaveCount(0);
        gate.resolve();
        await expect(sharedPage.getByRole('alert')).toContainText('Passkey list unavailable for test');
        await expect(sharedPage.getByText('No password is set.', { exact: false })).toHaveCount(0);
        await expect(sharedPage.getByText('not set', { exact: true })).toHaveCount(0);
      } finally {
        gate.resolve();
        await sharedPage.unroute('**/api/auth/passkeys');
      }
      await sharedPage.reload();
      await expect(sharedPage.getByText('set', { exact: true })).toBeVisible();
    });

    test('registers two passkeys through the real WebAuthn ceremony', async ({
      sharedPage,
      cdpSession,
      authenticatorId,
    }) => {
      expect(cdpSession).not.toBeNull();
      expect(authenticatorId).not.toBeNull();
      const cdp = cdpSession as CDPSession;
      const authId = authenticatorId as string;

      const finish = watchPageIssues(sharedPage);
      await sharedPage.goto(await adminUrl('/settings'));
      await expect(sharedPage.getByText('Passkeys', { exact: true })).toBeVisible();
      await expect(sharedPage.getByText('No passkeys registered yet.')).toBeVisible();
      await expect(sharedPage.getByText('set', { exact: true })).toBeVisible();

      await registerPasskey(sharedPage, 'E2E Laptop A');
      // See the header comment: the virtual authenticator environment enforces
      // `excludeCredentials`, so the local store must be cleared before the
      // second real ceremony. The server keeps both genuine credentials.
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId: authId });
      await registerPasskey(sharedPage, 'E2E Phone B');

      await expect(sharedPage.locator('table tbody tr')).toHaveCount(2);
      await expect(sharedPage.getByRole('row', { name: /E2E Laptop A/ })).toBeVisible();
      await expect(sharedPage.getByRole('row', { name: /E2E Phone B/ })).toBeVisible();
      await expect(sharedPage.getByText('Never used')).toHaveCount(2);

      const issues = finish();
      expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
      expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
    });

    test('retains old-RP keys but counts only usable credentials for password removal', async ({ sharedPage }) => {
      await e2eFetch('/passkeys-rp-fixture?active=none', { method: 'POST' });
      await sharedPage.goto(await adminUrl('/settings'));
      await expect(sharedPage.locator('table tbody tr')).toHaveCount(2);
      await expect(sharedPage.getByText('Registered for a different panel URL;', { exact: false })).toHaveCount(2);
      await expect(sharedPage.getByRole('button', { name: 'Delete password' })).toBeDisabled();
      const guard = await sharedPage.evaluate(async () => {
        const response = await fetch('/api/auth/password', { method: 'DELETE' });
        return { status: response.status, body: await response.json() };
      });
      expect(guard).toMatchObject({ status: 409, body: { error: 'passkey_required' } });

      await e2eFetch('/passkeys-rp-fixture?active=latest', { method: 'POST' });
      await sharedPage.reload();
      await expect(sharedPage.getByText('Registered for a different panel URL;', { exact: false })).toHaveCount(1);
      await expect(sharedPage.getByRole('button', { name: 'Delete password' })).toBeEnabled();
    });

    test('deleting the password rotates the session and stays signed in', async ({ sharedPage, sharedContext }) => {
      const base = await adminBase();
      const sessionCookie = async (): Promise<string | null> => {
        const cookies = await sharedContext.cookies(base);
        return cookies.find((cookie) => cookie.name === 'plasticwan_admin')?.value ?? null;
      };
      const before = await sessionCookie();
      expect(before).not.toBeNull();

      const countBefore = await e2eFetch<{ count: number }>('/session-count');
      expect(countBefore.count).toBeGreaterThanOrEqual(1);

      await sharedPage.goto(await adminUrl('/settings'));
      await sharedPage.getByRole('button', { name: 'Delete password' }).click();
      const dialog = sharedPage.getByRole('alertdialog');
      await expect(dialog.getByText('Delete your password?')).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete password' }).click();
      await expect(sharedPage.locator('[data-sonner-toast]').filter({ hasText: 'Password deleted' })).toBeVisible();

      // The old session is gone and exactly one rotated session remains.
      const after = await sessionCookie();
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
      const countAfter = await e2eFetch<{ count: number }>('/session-count');
      expect(countAfter.count).toBe(1);

      // The rotated session still works: a reload stays inside the shell.
      await sharedPage.goto(await adminUrl('/settings'));
      await expect(sharedPage.getByText('Admin credentials', { exact: true })).toBeVisible();
      await expect(sharedPage.getByText('not set', { exact: true })).toBeVisible();
      await expect(sharedPage.getByText('No password is set.', { exact: false })).toBeVisible();
      await expect(sharedPage.getByText('Something went wrong')).toHaveCount(0);
    });

    test('signs in with a passkey without a username', async ({ sharedPage }) => {
      const finish = watchPageIssues(sharedPage);
      await sharedPage.goto(await adminUrl('/'));
      await sharedPage.getByText('Sign out').click();
      await expect(sharedPage.getByText('Surowan admin sign-in')).toBeVisible();
      // Username-less: the discoverable ceremony runs without touching the form.
      await expect(sharedPage.getByLabel('Username')).toHaveValue('');
      const passkeySignIn = sharedPage.getByRole('button', { name: 'Sign in with a passkey' });
      await expect(passkeySignIn).toBeVisible();
      await passkeySignIn.click();
      await expect(sharedPage.getByText('Stored messages')).toBeVisible();
      await expect(sharedPage.getByText('Something went wrong')).toHaveCount(0);

      const issues = finish();
      expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
      expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
    });

    test('protects the last passkey while no password exists', async ({ sharedPage }) => {
      await sharedPage.goto(await adminUrl('/settings'));

      // The current-RP key is already protected even while an old-RP key remains.
      await expect(
        sharedPage.getByRole('row', { name: /E2E Phone B/ }).getByRole('button', { name: 'Delete' }),
      ).toBeDisabled();
      const rowA = sharedPage.getByRole('row', { name: /E2E Laptop A/ });
      await expect(rowA.getByText('Registered for a different panel URL;', { exact: false })).toBeVisible();
      await expect(rowA.getByRole('button', { name: 'Delete' })).toBeEnabled();
      await rowA.getByRole('button', { name: 'Delete' }).click();
      const dialog = sharedPage.getByRole('alertdialog');
      await expect(dialog.getByText('Delete passkey "E2E Laptop A"?')).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete passkey' }).click();
      await expect(sharedPage.locator('[data-sonner-toast]').filter({ hasText: 'Passkey deleted' })).toBeVisible();
      await expect(sharedPage.locator('table tbody tr')).toHaveCount(1);

      // The last key is locked in the UI...
      const rowB = sharedPage.getByRole('row', { name: /E2E Phone B/ });
      await expect(rowB.getByRole('button', { name: 'Delete' })).toBeDisabled();
      await expect(sharedPage.getByText('This is the last sign-in method.')).toBeVisible();

      // ...and the server independently refuses the delete.
      const guard = await sharedPage.evaluate(async () => {
        const list = await fetch('/api/auth/passkeys');
        const listData = (await list.json()) as { items?: { id?: string }[] };
        const id = listData.items?.[0]?.id;
        if (id === undefined) {
          return { status: 0, error: 'no_keys' };
        }
        const response = await fetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
        const body = (await response.json()) as { error?: string };
        return { status: response.status, error: body.error ?? null };
      });
      expect(guard.status).toBe(409);
      expect(guard.error).toBe('password_required');
    });

    test('restores a password, then allows deleting the last passkey', async ({ sharedPage }) => {
      await sharedPage.goto(await adminUrl('/settings'));

      // Real recovery path: set a new password from the Admin credentials card.
      await sharedPage.getByLabel('New username').fill(E2E_USERNAME);
      await sharedPage.getByLabel('New password').fill(RESTORED_PASSWORD);
      await sharedPage.getByRole('button', { name: 'Update credentials' }).click();
      await expect(sharedPage.getByText('Credentials updated; all other sessions were signed out.')).toBeVisible();
      await expect(sharedPage.getByText('set', { exact: true })).toBeVisible();

      // With a password back, the last passkey can be removed.
      const rowB = sharedPage.getByRole('row', { name: /E2E Phone B/ });
      await rowB.getByRole('button', { name: 'Delete' }).click();
      const dialog = sharedPage.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Delete passkey' }).click();
      await expect(sharedPage.locator('[data-sonner-toast]').filter({ hasText: 'Passkey deleted' })).toBeVisible();
      await expect(sharedPage.getByText('No passkeys registered yet.')).toBeVisible();
      await expect(sharedPage.getByText('set', { exact: true })).toBeVisible();
    });

    test('shows the cancel message for a failed or dismissed ceremony', async ({
      sharedPage,
      cdpSession,
      authenticatorId,
    }) => {
      expect(cdpSession).not.toBeNull();
      expect(authenticatorId).not.toBeNull();
      const cdp = cdpSession as CDPSession;
      const authId = authenticatorId as string;

      // Registration with user verification failing is a genuine NotAllowedError
      // from the real ceremony; the UI must map it to the cancel copy.
      await sharedPage.goto(await adminUrl('/settings'));
      await sharedPage.getByRole('button', { name: 'Add passkey' }).click();
      const dialog = sharedPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Passkey name').fill('E2E Cancel');
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId: authId, isUserVerified: false });
      await dialog.getByRole('button', { name: 'Register passkey' }).click();
      await expect(dialog.getByText('Passkey request cancelled')).toBeVisible();
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId: authId, isUserVerified: true });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();

      // Login ceremony with no registered credentials: also a NotAllowedError.
      // The virtual authenticator still holds key B from earlier tests, so
      // clear it first — the account itself has no passkeys left at this point.
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId: authId });
      await sharedPage.getByText('Sign out').click();
      await expect(sharedPage.getByText('Surowan admin sign-in')).toBeVisible();
      await sharedPage.getByRole('button', { name: 'Sign in with a passkey' }).click();
      await expect(sharedPage.getByText('Passkey request cancelled')).toBeVisible();

      // The restored password signs in again.
      await sharedPage.getByLabel('Username').fill(E2E_USERNAME);
      await sharedPage.getByLabel('Password').fill(RESTORED_PASSWORD);
      await sharedPage.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(sharedPage.getByText('Stored messages')).toBeVisible();
    });
  });
}
