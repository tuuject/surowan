import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

/**
 * Regression: while the mode is "system", an OS scheme change must update the
 * theme context value and not only the DOM class. The JSON viewer derives its
 * palette from `resolved`, so before the fix its inline theme variables kept the
 * previous scheme until the provider re-rendered for some other reason.
 */
test.use({ signedIn: true });

test('system color scheme change updates the theme context value', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(await adminUrl('/invocations/4001'));

  const overview = page.getByRole('tabpanel', { name: /Overview/ });
  await overview.getByText('View details').first().click();
  await overview
    .getByText(/Payload \(\d+ chars\) — click to expand/)
    .first()
    .click();

  const tree = page.locator('.w-rjv').first();
  await expect(tree).toBeVisible();
  const lightStyle = await tree.getAttribute('style');

  await page.emulateMedia({ colorScheme: 'dark' });

  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect.poll(() => tree.getAttribute('style')).not.toBe(lightStyle);
});

test('Panel preferences set theme and language alongside the header toggles', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(await adminUrl('/preferences'));
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await expect(theme).toHaveText('System');
  await theme.click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  // The header toggle stays and reads the same mode.
  await expect(page.getByRole('button', { name: 'Toggle theme: Dark' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: '中文', exact: true }).click();
  await expect(page.getByRole('link', { name: '面板偏好', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: '主题' })).toHaveText('深色');
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('combobox', { name: '语言' })).toHaveText('中文');

  // The header language toggle still switches, and the page follows it.
  await page.getByRole('button', { name: '切换语言' }).click();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveText('English');
});
