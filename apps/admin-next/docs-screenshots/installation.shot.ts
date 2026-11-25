/**
 * Installation screenshots: the sign-in page a fresh deployment shows.
 *
 * The panel has no web setup form; the only way in is a password (after the
 * first code) or a one-time code minted on the server. The screenshot shows
 * that form, empty and without a real code: nothing here mints one.
 */
import { adminBase } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

// A fresh instance has no session, and this is the one scenario that must not
// have one: the stored session cookie would otherwise skip the login gate.
test.use({ signedIn: false });

test('installation/sign-in-one-time-code', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminBase());
  await expect(page.getByText(labels.auth.loginTitle, { exact: true })).toBeVisible();

  // Switch to the code form; it starts empty and no code is generated.
  await page.getByRole('button', { name: labels.auth.codeSignIn, exact: true }).click();
  const code = page.getByLabel(labels.auth.code, { exact: true });
  await expect(code).toBeVisible();
  await expect(code).toHaveValue('');

  await captureScreenshot(page, docLocale, 'installation/sign-in-one-time-code');
});
