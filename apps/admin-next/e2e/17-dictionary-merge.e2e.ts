import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL, E2E_MERGE_SUGGESTION } from './models-fixture.ts';
import { createEntry, draft, listView, removeEntry, resetDictionaries } from './dictionary-fixture.ts';

/**
 * The two-step dictionary merge against the real AdminServer + real SQLite and
 * a real model: the preview must write nothing before confirmation, and
 * deleting the sources must remove exactly the selected entries.
 */
test.use({ signedIn: true });

test.describe('dictionary merge', () => {
  test.beforeEach(async ({ page }) => {
    await resetDictionaries(page);
    // Merges call a real model through the provider registry, so the fixture
    // points the Tool Model at the loopback upstream that answers with a
    // canned JSON suggestion (see e2e/server.ts).
    const providers = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as {
      readonly revision: string;
    };
    const response = await page.request.put(await adminUrl('/api/tool-model'), {
      headers: { 'if-match': providers.revision },
      data: { provider: E2E_MERGE_ALIAS, model: E2E_MERGE_MODEL, thinking_level: 'low' },
    });
    expect(response.ok(), 'fixture Tool Model write failed').toBe(true);
  });

  test.afterEach(async ({ page }) => {
    const view = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as {
      readonly revision: string;
    };
    await page.request.put(await adminUrl('/api/tool-model'), {
      headers: { 'if-match': view.revision },
      data: { inherit: true },
    });
  });

  test('merge previews a suggestion and only writes after an explicit confirm', async ({ page }) => {
    const stamp = Date.now();
    const first = await createEntry(page, draft(`e2e-merge-a-${stamp}`, { aliases: ['e2e-merge-x'] }));
    const second = await createEntry(page, draft(`e2e-merge-b-${stamp}`, { aliases: ['e2e-merge-x'] }));
    const sourceIds = [first.id, second.id];
    try {
      await page.goto(await adminUrl('/dictionary'));
      await page.getByRole('checkbox', { name: `Select ${first.term}` }).check();
      await page.getByRole('checkbox', { name: `Select ${second.term}` }).check();
      await page.getByRole('button', { name: /Merge selected/ }).click();
      const dialog = page.getByRole('dialog');

      await expect(dialog.getByText('Sources (2)')).toBeVisible();
      await dialog.getByRole('button', { name: 'Generate suggestion' }).click();
      // The dialog carries the model's proposal in its editable fields.
      const mergeTerm = dialog.locator('#merge-term');
      await expect(mergeTerm).toBeVisible();
      await expect(mergeTerm).toHaveValue(E2E_MERGE_SUGGESTION.term);
      await expect(dialog.locator('#merge-definition')).toHaveValue(E2E_MERGE_SUGGESTION.definition);
      await mergeTerm.fill(`e2e-merged-${stamp}`);

      // Nothing persisted yet: the sources are still there, no merged entry exists.
      const beforeConfirm = await listView(page, { scope: 'global' });
      expect(beforeConfirm.items.filter((entry) => sourceIds.includes(entry.id)).length).toBe(2);
      expect(beforeConfirm.items.some((entry) => entry.term === `e2e-merged-${stamp}`)).toBe(false);

      await dialog.getByRole('button', { name: 'Save merged entry' }).click();
      await expect(page.getByText('Merged entry saved')).toBeVisible();

      const afterConfirm = await listView(page, { scope: 'global' });
      const merged = afterConfirm.items.find((entry) => entry.term === `e2e-merged-${stamp}`);
      expect(merged).not.toBeUndefined();
      // Keeping the sources is the default; both survive the merge.
      expect(afterConfirm.items.filter((entry) => sourceIds.includes(entry.id)).length).toBe(2);
    } finally {
      const remaining = (await listView(page, { scope: 'global' })).items;
      for (const entry of remaining) {
        if (sourceIds.includes(entry.id) || entry.term === `e2e-merged-${stamp}`) {
          await removeEntry(page, entry);
        }
      }
    }
  });

  test('a merge that deletes its sources removes exactly the selected entries', async ({ page }) => {
    const stamp = Date.now();
    const keep = await createEntry(page, draft(`e2e-merge-keep-${stamp}`));
    const first = await createEntry(page, draft(`e2e-merge-del-a-${stamp}`));
    const second = await createEntry(page, draft(`e2e-merge-del-b-${stamp}`));
    const sourceIds = [first.id, second.id];
    try {
      await page.goto(await adminUrl('/dictionary'));
      await page.getByRole('checkbox', { name: `Select ${first.term}` }).check();
      await page.getByRole('checkbox', { name: `Select ${second.term}` }).check();
      await page.getByRole('button', { name: /Merge selected/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Generate suggestion' }).click();
      await expect(dialog.locator('#merge-term')).toBeVisible();
      await dialog.locator('#merge-term').fill(`e2e-merge-collapsed-${stamp}`);
      await dialog.getByRole('checkbox', { name: 'Delete the source entries' }).check();
      await dialog.getByRole('button', { name: 'Save merged entry' }).click();
      await expect(page.getByText('Merged entry saved')).toBeVisible();

      const after = await listView(page, { scope: 'global' });
      expect(after.items.filter((entry) => sourceIds.includes(entry.id)).length).toBe(0);
      expect(after.items.some((entry) => entry.term === keep.term)).toBe(true);
      expect(after.items.some((entry) => entry.term === `e2e-merge-collapsed-${stamp}`)).toBe(true);
    } finally {
      const remaining = (await listView(page, { scope: 'global' })).items;
      for (const entry of remaining) {
        if (sourceIds.includes(entry.id) || entry.term === keep.term || entry.term === `e2e-merge-collapsed-${stamp}`) {
          await removeEntry(page, entry);
        }
      }
    }
  });
});
