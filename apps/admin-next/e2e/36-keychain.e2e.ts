import { expect } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';

/**
 * The keychain manager against the real server: create an unused entry, rotate
 * it, watch a rotation show up in the provider connection, delete the unused
 * entry, and purge. Values never appear in any response or on the page.
 *
 * The suite is self-contained (it creates and removes its own entries), so
 * `--repeat-each` re-runs stay meaningful.
 */
test.use({ signedIn: true });

const UNUSED = 'e2e-keychain-spare';
const USED = 'e2e-builtin';
const USED_ALIAS = 'openrouter';
const USED_PATH = 'providers.openrouter.api_key';

test('create, rotate, delete and purge run end to end without showing a value', async ({ page }) => {
  await page.goto(await adminUrl('/keychain'));
  await expect(page.getByRole('heading', { name: 'Keychain' })).toBeVisible();
  const usedRow = page.getByRole('row', { name: new RegExp(USED) });
  await expect(usedRow).toBeVisible();
  // A used entry shows its config path.
  await expect(page.getByText(USED_PATH, { exact: true })).toBeVisible();
  // The delete action is only enabled for unused entries.
  await expect(usedRow.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(usedRow.getByRole('button', { name: 'Rotate' })).toBeEnabled();

  // --- create -------------------------------------------------------------
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(UNUSED);
  await dialog.getByLabel('Value', { exact: true }).fill('e2e-keychain-spare-secret');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Entry e2e-keychain-spare created')).toBeVisible();
  const spareRow = page.getByRole('row', { name: new RegExp(UNUSED) });
  await expect(spareRow).toBeVisible();
  await expect(spareRow.getByText('Unused', { exact: true })).toBeVisible();
  // The submitted value never appears as page text, and the closed dialog's
  // value input is empty again: the plaintext outlives no dialog.
  expect(await page.content()).not.toContain('e2e-keychain-spare-secret</');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page.getByRole('dialog').getByLabel('Value', { exact: true })).toHaveValue('');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // --- rotate -------------------------------------------------------------
  await spareRow.getByRole('button', { name: 'Rotate' }).click();
  const rotateDialog = page.getByRole('dialog');
  await rotateDialog.getByLabel('Value', { exact: true }).fill('e2e-keychain-spare-secret-2');
  await rotateDialog.getByRole('button', { name: 'Rotate' }).click();
  await expect(toast(page, 'Entry e2e-keychain-spare rotated')).toBeVisible();

  // --- delete the unused entry --------------------------------------------
  await spareRow.getByRole('button', { name: 'Delete' }).click();
  const deleteDialog = page.getByRole('alertdialog');
  await expect(deleteDialog).toContainText('Delete e2e-keychain-spare?');
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page, 'Entry e2e-keychain-spare deleted')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(UNUSED) })).toHaveCount(0);
});

test('the used entry rotates in place and the provider view follows', async ({ page }) => {
  await page.goto(await adminUrl('/keychain'));
  const usedRow = page.getByRole('row', { name: new RegExp(USED) });
  await usedRow.getByRole('button', { name: 'Rotate' }).click();
  const rotateDialog = page.getByRole('dialog');
  await rotateDialog.getByLabel('Value', { exact: true }).fill('e2e-keychain-builtin-rotated');
  await rotateDialog.getByRole('button', { name: 'Rotate' }).click();
  await expect(toast(page, `Entry ${USED} rotated`)).toBeVisible();

  // The provider still names the same entry (an in-place rotation), and the
  // keychain rotation survives the reload.
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: `Provider ${USED_ALIAS}` }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.goto(await adminUrl('/keychain'));
  await expect(page.getByRole('row', { name: new RegExp(USED) })).toBeVisible();
});

test('purge only removes entries that are still unused', async ({ page }) => {
  await page.goto(await adminUrl('/keychain'));
  // Two orphans of this suite's own making plus the used entry: the confirmed
  // set is what the server deletes, and a used entry is skipped, not removed.
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('e2e-keychain-orphan');
  await dialog.getByLabel('Value', { exact: true }).fill('e2e-keychain-orphan-secret');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Entry e2e-keychain-orphan created')).toBeVisible();

  await page.getByRole('button', { name: 'Purge orphans' }).click();
  const purgeDialog = page.getByRole('alertdialog');
  await expect(purgeDialog).toContainText('These entries are deleted permanently');
  await expect(purgeDialog).toContainText('e2e-keychain-orphan');
  // The used entry is not part of the confirmation: it would be skipped anyway.
  await expect(purgeDialog).not.toContainText(USED);
  await purgeDialog.getByRole('button', { name: 'Purge', exact: true }).click();
  await expect(toast(page, 'Deleted 1 orphan')).toBeVisible();
  await expect(page.getByRole('row', { name: /e2e-keychain-orphan/ })).toHaveCount(0);
  // The used entry survived the purge.
  await expect(page.getByRole('row', { name: new RegExp(USED) })).toBeVisible();
});
