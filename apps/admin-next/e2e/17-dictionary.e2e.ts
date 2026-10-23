import { expect } from '@playwright/test';
import { adminUrl, test, toast, watchPageIssues } from './helpers.ts';
import { findEntry, removeEntry, resetDictionaries } from './dictionary-fixture.ts';

/**
 * Dictionary page against the real AdminServer + real SQLite: rendering, entry
 * CRUD and aliases typed straight into the dialog.
 *
 * Search, conflict reporting, import/export live in
 * `17-dictionary-entries.e2e.ts`; scopes and injection settings in
 * `17-dictionary-scopes.e2e.ts`; the two-step merge in
 * `17-dictionary-merge.e2e.ts`.
 */
test.use({ signedIn: true });

test.describe('dictionary page', () => {
  test.beforeEach(async ({ page }) => {
    // Every test here starts from an empty dictionary in both scopes.
    await resetDictionaries(page);
  });

  test('renders the sidebar entry, the scope picker and the injection settings', async ({ page }) => {
    const finish = watchPageIssues(page);
    await page.goto(await adminUrl('/dictionary'));
    await expect(page.getByText('Automatic injection')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New entry' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();

    // The global mode is readable and defaults to On Demand.
    await expect(page.getByRole('combobox', { name: 'Global mode' })).toContainText('On Demand');

    await page.goto(await adminUrl('/'));
    await page.getByRole('link', { name: 'Dictionary' }).click();
    await expect(page.getByText('Automatic injection')).toBeVisible();

    const issues = finish();
    expect(issues.pageErrors, JSON.stringify(issues.pageErrors)).toEqual([]);
    expect(issues.consoleErrors, JSON.stringify(issues.consoleErrors)).toEqual([]);
  });

  test('creates, edits, disables and deletes an entry through the UI', async ({ page }) => {
    const term = `e2e-entry-${Date.now()}`;
    await page.goto(await adminUrl('/dictionary'));
    const dialog = page.getByRole('dialog');

    await page.getByRole('button', { name: 'New entry' }).click();
    await dialog.getByLabel('Term', { exact: true }).fill(term);
    await dialog.getByLabel('Definition', { exact: true }).fill('Created by the E2E suite');
    const aliases = dialog.getByLabel('Aliases', { exact: true });
    await aliases.fill('e2e-alias');
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(toast(page, 'Entry created')).toBeVisible();

    const row = page.locator('table tbody tr', { hasText: term });
    await expect(row).toBeVisible();
    await expect(row).toContainText('e2e-alias');

    // server state
    const created = await findEntry(page, term);
    expect(created).not.toBeNull();
    expect(created?.aliases).toEqual(['e2e-alias']);

    // edit: clearing the textarea removes every alias in one save
    await row.getByRole('button', { name: `Edit ${term}` }).click();
    await dialog.getByLabel('Definition', { exact: true }).fill('Edited by the E2E suite');
    await dialog.getByLabel('Aliases', { exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(toast(page, 'Entry updated')).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: term })).toContainText('Edited by the E2E suite');
    expect((await findEntry(page, term))?.aliases).toEqual([]);

    // disable - a plain toggle write, still revision-checked
    await page.locator('table tbody tr', { hasText: term }).getByRole('button', { name: 'Enabled' }).click();
    await expect(page.locator('table tbody tr', { hasText: term })).toContainText('Disabled');
    const disabled = await findEntry(page, term);
    expect(disabled?.enabled).toBe(false);

    // delete with confirmation
    await page
      .locator('table tbody tr', { hasText: term })
      .getByRole('button', { name: `Delete ${term}` })
      .click();
    await page.getByRole('button', { name: 'Delete entry' }).click();
    await expect(toast(page, 'Entry deleted')).toBeVisible();
    await expect(page.locator('table tbody tr', { hasText: term })).toHaveCount(0);
    expect(await findEntry(page, term)).toBeNull();
  });

  test('an alias typed and saved directly is persisted, one per line, with commas and pipes kept literal', async ({
    page,
  }) => {
    const term = `e2e-alias-direct-${Date.now()}`;
    await page.goto(await adminUrl('/dictionary'));
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'New entry' }).click();
    await dialog.getByLabel('Term', { exact: true }).fill(term);
    await dialog.getByLabel('Definition', { exact: true }).fill('Typed aliases, saved without an Add button');

    // This is the reported bug: the alias text is typed, then Save is pressed
    // straight away. There is no Add button to forget any more.
    const aliases = dialog.getByLabel('Aliases', { exact: true });
    await aliases.fill('AB 钙');
    await expect(dialog.getByRole('button', { name: 'Add alias' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(toast(page, 'Entry created')).toBeVisible();

    // Reload proves the write went through the API, not just the dialog state.
    await page.reload();
    const row = page.locator('table tbody tr', { hasText: term });
    await expect(row).toBeVisible();
    await expect(row).toContainText('AB 钙');
    expect((await findEntry(page, term))?.aliases).toEqual(['AB 钙']);

    // Edit: three lines, a comma and a pipe stay inside their alias.
    await row.getByRole('button', { name: `Edit ${term}` }).click();
    await dialog.getByLabel('Aliases', { exact: true }).fill('AB 钙\n带,逗号\n带|竖线');
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(toast(page, 'Entry updated')).toBeVisible();
    await page.reload();
    await expect(page.locator('table tbody tr', { hasText: term })).toContainText('带,逗号');
    expect((await findEntry(page, term))?.aliases).toEqual(['AB 钙', '带,逗号', '带|竖线']);

    const cleanup = await findEntry(page, term);
    if (cleanup !== null) {
      await removeEntry(page, cleanup);
    }
  });

  test('the alias textarea keeps the caret and blank lines while typing', async ({ page }) => {
    const term = `e2e-alias-caret-${Date.now()}`;
    await page.goto(await adminUrl('/dictionary'));
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'New entry' }).click();
    await dialog.getByLabel('Term', { exact: true }).fill(term);
    await dialog.getByLabel('Definition', { exact: true }).fill('Caret stability');
    const aliases = dialog.getByLabel('Aliases', { exact: true });
    await aliases.click();

    // Pressing Enter after the first alias starts a new line at the caret and
    // the raw text keeps the trailing newline instead of being re-joined away.
    await aliases.type('one');
    await aliases.press('Enter');
    await aliases.type('two');
    await expect(aliases).toHaveValue('one\ntwo');

    // A blank line in the middle is preserved verbatim while editing.
    await aliases.fill('one\n\ntwo');
    await expect(aliases).toHaveValue('one\n\ntwo');

    // Saving still normalizes to the two non-empty aliases (the blank line and
    // any duplicate are dropped), independently of the raw display text.
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(toast(page, 'Entry created')).toBeVisible();
    expect((await findEntry(page, term))?.aliases).toEqual(['one', 'two']);

    const cleanup = await findEntry(page, term);
    if (cleanup !== null) {
      await removeEntry(page, cleanup);
    }
  });
});
