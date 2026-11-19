import { expect } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';
import { fakeWrites, installImageAssetsFake } from './image-assets-fake.ts';

test.use({ signedIn: true });

/**
 * The asset manager's prompt tab against the shared stateful fake: both tabs
 * list the seeded rows, and the prompt CRUD issues the writes the API client
 * promises. The recorded requests prove the calls really leave the page
 * instead of only updating local state.
 */

test.beforeEach(async ({ page }) => {
  await installImageAssetsFake(page);
});

test('both tabs render the seeded prompt assets and reference images', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByRole('heading', { name: 'Image assets', exact: true })).toBeVisible();
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();
  await expect(
    page.locator('table tbody tr', { hasText: 'Watercolor style' }).getByRole('cell', { name: 'style', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Images', exact: true }).click();
  const preview = page.getByRole('img', { name: 'Reference garden', exact: true });
  await expect(preview).toHaveAttribute('src', '/api/image/images/image-seed/content');
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32);
  await expect(page.locator('table tbody tr', { hasText: 'Reference garden' }).getByText('upload')).toBeVisible();
});

test('a prompt asset is created, renamed and archived through real writes', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New asset', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Asset name', exact: true }).fill('E2E style');
  await dialog.getByRole('textbox', { name: 'Asset body (no {{ nesting)', exact: true }).fill('Neon nights.');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toast(page, 'Asset created')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const createdRow = page.locator('table tbody tr', { hasText: 'E2E style' });
  await expect(createdRow).toBeVisible();

  await createdRow.getByRole('button', { name: 'Rename', exact: true }).click();
  const renameDialog = page.getByRole('dialog');
  await expect(renameDialog.getByRole('heading', { name: 'Rename E2E style', exact: true })).toBeVisible();
  const nameField = renameDialog.getByRole('textbox', { name: 'Asset name', exact: true });
  await expect(nameField).toHaveValue('E2E style');
  await nameField.fill('E2E renamed');
  await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(toast(page, 'Renamed')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const renamedRow = page.locator('table tbody tr', { hasText: 'E2E renamed' });
  await expect(renamedRow).toBeVisible();
  await expect(page.locator('table tbody tr', { hasText: 'E2E style' })).toHaveCount(0);

  await renamedRow.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('heading', { name: 'Archive E2E renamed', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(toast(page, 'Archived')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('table tbody tr', { hasText: 'E2E renamed' })).toHaveCount(0);
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();
  expect(fakeWrites()).toEqual([
    'POST /api/image/prompts',
    'PUT /api/image/prompts/prompt-created-1',
    'DELETE /api/image/prompts/prompt-created-1',
  ]);
});

test('a disabled image service shows the settings gate instead of the tables', async ({ page }) => {
  await page.route('**/api/image/status', (route) => route.fulfill({ json: { enabled: false, models: [] } }));
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByRole('heading', { name: 'Image assets', exact: true })).toBeVisible();
  const gate = page.getByRole('status');
  await expect(gate).toContainText('Image generation is currently disabled');
  await expect(gate.getByRole('link', { name: 'Image settings', exact: true })).toHaveAttribute(
    'href',
    '/image-settings',
  );
  await expect(page.locator('table')).toHaveCount(0);
});
