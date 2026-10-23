import { type BrowserContext, type CDPSession, expect, type Page } from '@playwright/test';
import { authStoragePath, test as base } from './helpers.ts';

/**
 * Passkey E2E fixtures, constants and ceremony helper for the real WebAuthn
 * suite in `16-passkeys.e2e.ts`.
 *
 * Two modes, selected by `E2E_PASSKEYS`:
 *
 * - unset (default): `admin.public_url` is absent, so the panel must expose no
 *   passkey entry anywhere (login page, settings card, API → 404
 *   `passkeys_disabled`).
 * - `E2E_PASSKEYS=1`: the E2E server (see `e2e/server.ts`) binds `localhost`,
 *   sets `admin.public_url` to the live random origin, and the suite drives a
 *   CDP WebAuthn virtual authenticator through real `navigator.credentials`
 *   ceremonies: register two keys, delete the password (session rotation),
 *   sign in without a username, protect the last key, restore the password,
 *   delete the last key, and show the cancel message for failed/dismissed
 *   ceremonies. Nothing here mocks WebAuthn verification; every ceremony is
 *   performed by Chromium against the virtual authenticator and verified by
 *   @simplewebauthn/server inside the real AdminServer.
 *
 * Chrome rejects an IP literal as a WebAuthn RP ID (`SecurityError: This is
 * an invalid domain.`), so passkey mode runs on `http://localhost` — the
 * fixture binds `localhost`, not `127.0.0.1`.
 *
 * The enabled tests share one browser context (worker-scoped fixtures): the
 * virtual authenticator and its resident credentials live in that context and
 * must survive across tests. The CDP fixtures are `auto` so the virtual
 * authenticator exists before the very first ceremony. Chrome's virtual
 * authenticator environment enforces `excludeCredentials` across all
 * authenticators, so a second real ceremony for the same user would fail with
 * InvalidStateError; the local credential store is cleared between the two
 * registrations (both server-side credentials are still genuine products of
 * the real ceremony + verification stack).
 */
export const PASSKEYS_ENABLED = process.env.E2E_PASSKEYS === '1';

/** Restores a password-only account at the end of the enabled suite. */
export const RESTORED_PASSWORD = 'e2e-restored-horse-42';

interface PasskeyFixtures {
  readonly sharedContext: BrowserContext;
  readonly sharedPage: Page;
  readonly cdpSession: CDPSession | null;
  readonly authenticatorId: string | null;
}

// biome-ignore lint/complexity/noBannedTypes: Playwright's `extend` wants an empty test-args object for worker-only fixtures.
export const test = base.extend<{}, PasskeyFixtures>({
  sharedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ storageState: await authStoragePath(), locale: 'en-US' });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
  sharedPage: [
    async ({ sharedContext }, use) => {
      const page = await sharedContext.newPage();
      await use(page);
    },
    { scope: 'worker' },
  ],
  cdpSession: [
    async ({ sharedPage }, use) => {
      if (!PASSKEYS_ENABLED) {
        await use(null);
        return;
      }
      const session = await sharedPage.context().newCDPSession(sharedPage);
      await session.send('WebAuthn.enable', { enableUI: false });
      await use(session);
    },
    // Auto so the virtual authenticator exists before the FIRST test, even
    // though only the last test mentions the CDP fixtures explicitly.
    { scope: 'worker', auto: true },
  ],
  authenticatorId: [
    async ({ cdpSession }, use) => {
      if (cdpSession === null) {
        await use(null);
        return;
      }
      const added = await cdpSession.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      });
      await use(added.authenticatorId as string);
    },
    { scope: 'worker', auto: true },
  ],
});

export async function registerPasskey(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add passkey' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Passkey name').fill(name);
  await dialog.getByRole('button', { name: 'Register passkey' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Passkey registered' })).toBeVisible();
  // Radix keeps the dialog mounted during the exit animation; hidden, not gone.
  await expect(dialog).toBeHidden();
}
