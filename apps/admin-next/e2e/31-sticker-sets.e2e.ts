import { writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { adminUrl, clickNav, test, toast } from './helpers.ts';

/**
 * Telegram → Sticker sets manages `telegram.sticker_sets` in place. The E2E
 * server runs the product's publish hook, so every write lands in the store
 * the page lists; no sticker worker runs, so an added set stays `pending`.
 */
test.use({ signedIn: true });

interface StickerSetView {
  readonly id: string;
  readonly alias: string;
  readonly telegram_name: string;
  readonly note: string | null;
  readonly configured: boolean;
  readonly sync_state: string;
}

async function stickerSets(page: Page): Promise<readonly StickerSetView[]> {
  const response = await page.request.get(await adminUrl('/api/sticker-sets'));
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: readonly StickerSetView[] }).items;
}

function setsPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Configured sticker sets' });
}

function setRow(page: Page, alias: string): Locator {
  return setsPanel(page)
    .locator('tbody tr')
    .filter({ has: page.getByText(alias, { exact: true }) });
}

test('the sticker set page lives under Telegram', async ({ page }) => {
  await page.goto(await adminUrl('/'));
  await clickNav(page, 'Telegram', 'Bot sticker sets');
  await expect(page).toHaveURL(/\/stickers$/);
  await expect(setRow(page, 'mascot')).toBeVisible();
  // The seeded `legacy` row is a removed set: kept in the store, not managed.
  await expect(setRow(page, 'legacy')).toHaveCount(0);
});

test('adds a set from its link, renames it, edits its note and removes it', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/stickers'));

  await setsPanel(page).getByRole('button', { name: 'Add sticker set' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Telegram sticker set').fill('https://t.me/addstickers/e2e_cats');
  await dialog.getByLabel('Alias').fill('1cats');
  await dialog.getByRole('button', { name: 'Add' }).click();
  // Caught before any write: a write would stop running replies.
  await expect(dialog.getByText('Use 1–64 letters, digits, "_" or "-", starting with a letter.')).toBeVisible();
  expect((await stickerSets(page)).map((set) => set.alias)).not.toContain('1cats');

  await dialog.getByLabel('Alias').fill('cats');
  await dialog.getByLabel('Note (optional)').fill('Teasing friends; avoid in serious topics');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(toast(page, 'Sticker set added')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(setRow(page, 'cats')).toContainText('e2e_cats');
  await expect(setRow(page, 'cats')).toContainText('Teasing friends; avoid in serious topics');

  const added = (await stickerSets(page)).find((set) => set.alias === 'cats');
  expect(added).toMatchObject({
    telegram_name: 'e2e_cats',
    note: 'Teasing friends; avoid in serious topics',
    configured: true,
    sync_state: 'pending',
  });

  // The Telegram set is fixed; only the nickname and the note change.
  await setRow(page, 'cats').getByRole('button', { name: 'Edit' }).click();
  const nameField = dialog.getByLabel('Telegram sticker set');
  await expect(nameField).toHaveValue('e2e_cats');
  await expect(nameField).toHaveAttribute('readonly', '');
  await dialog.getByLabel('Alias').fill('kitties');
  await dialog.getByLabel('Note (optional)').fill('Only for cute moments');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Sticker set updated')).toBeVisible();
  await expect(setRow(page, 'kitties')).toContainText('Only for cute moments');
  await expect(setRow(page, 'cats')).toHaveCount(0);

  const renamed = (await stickerSets(page)).find((set) => set.alias === 'kitties');
  // Same store row: a rename keeps the synchronized stickers and their index.
  expect(renamed?.id).toBe(added?.id);
  expect(renamed?.telegram_name).toBe('e2e_cats');

  await setRow(page, 'kitties').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove set' }).click();
  await expect(toast(page, 'Sticker set removed')).toBeVisible();
  await expect(setRow(page, 'kitties')).toHaveCount(0);
  const removed = (await stickerSets(page)).find((set) => set.id === added?.id);
  expect(removed?.configured).toBe(false);

  // Adding the same set again reuses the kept row under the new alias.
  await setsPanel(page).getByRole('button', { name: 'Add sticker set' }).click();
  await dialog.getByLabel('Telegram sticker set').fill('E2E_CATS');
  await dialog.getByLabel('Alias').fill('cats_again');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(toast(page, 'Sticker set added')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const readded = (await stickerSets(page)).find((set) => set.alias === 'cats_again');
  expect(readded).toMatchObject({ id: added?.id, configured: true, note: null, sync_state: 'pending' });

  const screenshot = testInfo.outputPath('sticker-sets.png');
  await setsPanel(page).screenshot({ path: screenshot });
  await testInfo.attach('sticker-sets', { path: screenshot, contentType: 'image/png' });
  const report = testInfo.outputPath('sticker-sets.json');
  await writeFile(report, JSON.stringify(await stickerSets(page), null, 2));
  await testInfo.attach('sticker-sets-api', { path: report, contentType: 'application/json' });
});

test('a duplicate set is refused with the reason', async ({ page }) => {
  await page.goto(await adminUrl('/stickers'));
  await setsPanel(page).getByRole('button', { name: 'Add sticker set' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Telegram sticker set').fill('Surowan_Mascot');
  await dialog.getByLabel('Alias').fill('mascot_copy');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already configured');
  await expect(dialog).toBeVisible();
});
