import { expect } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';
import { CHAT_ID, listView, putSettings, removeEntry, resetDictionaries, settings } from './dictionary-fixture.ts';

/**
 * Dictionary scopes and injection settings against the real AdminServer + real
 * SQLite: group entries stay isolated from the global dictionary and other
 * chats, the global injection mode round-trips, a group override can be set and
 * cleared, and `?chat=` opens the group scope directly.
 */
test.use({ signedIn: true });

test.describe('dictionary page', () => {
  test.beforeEach(async ({ page }) => {
    // Every test here starts from an empty dictionary in both scopes.
    await resetDictionaries(page);
  });

  test('group entries are isolated from the global dictionary and other chats', async ({ page }) => {
    const term = `e2e-scope-${Date.now()}`;
    await page.goto(await adminUrl('/dictionary'));

    // Create in the group scope from the UI.
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'New entry' }).click();
    await dialog.getByLabel('Term', { exact: true }).fill(term);
    await dialog.getByLabel('Definition', { exact: true }).fill('Group-scoped entry');
    await dialog.getByRole('button', { name: 'Group', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Chat' }).click();
    await page.getByRole('option', { name: /Plastic Wan Test Group/ }).click();
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(toast(page, 'Entry created')).toBeVisible();

    const groupView = await listView(page, { scope: 'group', chat: CHAT_ID });
    const scoped = groupView.items.find((entry) => entry.term === term);
    expect(scoped?.scope).toBe('group');
    expect(scoped?.chat_id).toBe(CHAT_ID);

    // The global dictionary does not contain it.
    const globalView = await listView(page, { scope: 'global' });
    expect(globalView.items.some((entry) => entry.term === term)).toBe(false);

    try {
      // Switching the page scope to the group shows it; switching back to
      // global hides it again.
      await page.getByRole('combobox', { name: 'Dictionary scope' }).click();
      await page.getByRole('option', { name: /Group · Plastic Wan Test Group/ }).click();
      await expect(page.locator('table tbody tr', { hasText: term })).toBeVisible();
      await page.getByRole('combobox', { name: 'Dictionary scope' }).click();
      await page.getByRole('option', { name: 'Global dictionary' }).click();
      await expect(page.locator('table tbody tr', { hasText: term })).toHaveCount(0);
    } finally {
      const current = await listView(page, { scope: 'group', chat: CHAT_ID });
      const entry = current.items.find((candidate) => candidate.term === term);
      if (entry !== undefined) {
        await removeEntry(page, entry);
      }
    }
  });

  test('the global injection mode round-trips and a group override can be set and cleared', async ({ page }) => {
    const baseline = await settings(page);
    await page.goto(await adminUrl('/dictionary'));

    // Global mode: On Demand → Off. The panel renders the effective mode from
    // the refetched settings, so waiting on that text is what proves the write
    // landed (a toast is also shown by the group override below).
    await page.getByRole('combobox', { name: 'Global mode' }).click();
    await page.getByRole('option', { name: 'Off' }).click();
    await expect(page.getByTestId('effective-mode')).toHaveText('Off');
    expect((await settings(page)).injection_mode).toBe('off');

    const groupBaseline = await settings(page, CHAT_ID);
    try {
      await page.getByRole('combobox', { name: 'Dictionary scope' }).click();
      await page.getByRole('option', { name: /Group · Plastic Wan Test Group/ }).click();
      await page.getByRole('combobox', { name: 'Override for this Chat' }).click();
      await page.getByRole('option', { name: 'Aggressive', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Override for this Chat' })).toContainText('Aggressive');
      await expect(page.getByTestId('effective-mode')).toHaveText('Aggressive');
      const overridden = await settings(page, CHAT_ID);
      expect(overridden.override_mode).toBe('aggressive');
      expect(overridden.effective_mode).toBe('aggressive');

      // Clearing the override falls back to the global mode.
      await page.getByRole('combobox', { name: 'Override for this Chat' }).click();
      await page.getByRole('option', { name: /Inherit global/ }).click();
      await expect(page.getByText('Group override cleared; the global mode applies again')).toBeVisible();
      await expect(page.getByTestId('effective-mode')).toHaveText('Off');
      const cleared = await settings(page, CHAT_ID);
      expect(cleared.override_mode).toBeNull();
      expect(cleared.effective_mode).toBe('off');
    } finally {
      // Each restore reads the current revision first: the writes above moved the
      // config file, so a revision captured at the start would be stale.
      await putSettings(page, CHAT_ID, { injection_mode: groupBaseline.override_mode });
      await putSettings(page, undefined, { injection_mode: baseline.injection_mode });
    }
  });
});

test.describe('dictionary chat deep link', () => {
  test('the chat search param opens the group scope directly', async ({ page }) => {
    await page.goto(await adminUrl(`/dictionary?chat=${CHAT_ID}`));
    await expect(page.getByRole('combobox', { name: 'Dictionary scope' })).toContainText('Plastic Wan Test Group');
    await page.getByRole('combobox', { name: 'Dictionary scope' }).click();
    await page.getByRole('option', { name: 'Global dictionary' }).click();
    await expect(page).toHaveURL(/\/dictionary$/);
    await expect(page.getByRole('combobox', { name: 'Dictionary scope' })).toContainText('Global dictionary');
  });
});
