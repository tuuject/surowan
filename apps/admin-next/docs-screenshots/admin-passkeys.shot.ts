/**
 * Passkey management screenshot.
 *
 * Real WebAuthn: the project runs the server in passkeys mode (`localhost`
 * origin + `admin.public_url`) and drives a Chromium virtual authenticator, so
 * both keys in the list are the product of a genuine registration ceremony
 * verified by @simplewebauthn/server inside the real AdminServer.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { type DocsLabels, docsLabels } from './labels.ts';

// A WebAuthn RP id must be a domain: the fixture binds `localhost` and sets
// `admin.public_url` to the live origin only in this mode.
test.use({ passkeys: true });

interface PasskeysView {
  readonly items: readonly { readonly name: string }[];
  readonly has_password: boolean;
}

async function registerPasskey(page: import('@playwright/test').Page, labels: DocsLabels, name: string): Promise<void> {
  await page.getByRole('button', { name: labels.passkeys.add, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(labels.passkeys.nameLabel, { exact: true }).fill(name);
  await dialog.getByRole('button', { name: labels.passkeys.registerConfirm, exact: true }).click();
  // The previous registration's toast may still be on screen; both are real.
  await expect(page.locator('[data-koi-toast]').filter({ hasText: labels.passkeys.registered }).first()).toBeVisible();
  await expect(dialog).toBeHidden();
}

test('admin/passkeys', async ({ page, context, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await page.goto(await adminUrl('/settings'));
  const card = page.getByRole('region', { name: labels.passkeys.title, exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText(labels.passkeys.empty, { exact: true })).toBeVisible();

  await registerPasskey(page, labels, seed.passkeys.laptop);
  // The virtual authenticator enforces `excludeCredentials` across its own
  // store, so clear it before the second genuine ceremony; the server keeps
  // both verified credentials.
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await registerPasskey(page, labels, seed.passkeys.phone);

  await expect(card.locator('table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('row', { name: new RegExp(seed.passkeys.laptop) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(seed.passkeys.phone) })).toBeVisible();

  const view = await apiJson<PasskeysView>(page, await adminUrl('/api/auth/passkeys'));
  expect(view.items.map((item) => item.name).sort()).toEqual([seed.passkeys.laptop, seed.passkeys.phone].sort());
  expect(view.has_password).toBe(true);

  await captureScreenshot(page, docLocale, 'admin/passkeys', card);
});
