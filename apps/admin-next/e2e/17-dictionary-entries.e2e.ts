import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';
import { createEntry, draft, findEntry, listView, removeEntry, resetDictionaries } from './dictionary-fixture.ts';

/**
 * Dictionary page entry operations against the real AdminServer + real SQLite:
 * search, duplicate-term conflicts, stale-revision refusal and the CSV
 * import/export flows. Rendering and entry CRUD from the UI live in
 * `17-dictionary.e2e.ts`; scopes and injection settings in
 * `17-dictionary-scopes.e2e.ts`; the merge in `17-dictionary-merge.e2e.ts`.
 */
test.use({ signedIn: true });

test.describe('dictionary page', () => {
  test.beforeEach(async ({ page }) => {
    // Every test here starts from an empty dictionary in both scopes.
    await resetDictionaries(page);
  });

  test('search narrows by term and alias without hiding other entries', async ({ page }) => {
    const stamp = Date.now();
    const alpha = await createEntry(page, draft(`e2e-search-alpha-${stamp}`, { aliases: ['e2e-search-marker'] }));
    const beta = await createEntry(page, draft(`e2e-search-beta-${stamp}`));
    try {
      await page.goto(await adminUrl('/dictionary'));
      const search = page.getByRole('textbox', { name: 'Search term or alias' });
      // A search that only matches the alias must still find its entry.
      await search.fill('e2e-search-marker');
      await search.press('Enter');
      await expect(page.locator('table tbody tr', { hasText: alpha.term })).toBeVisible();
      await expect(page.locator('table tbody tr', { hasText: beta.term })).toHaveCount(0);

      await search.fill(stamp.toString());
      await search.press('Enter');
      await expect(page.locator('table tbody tr', { hasText: alpha.term })).toBeVisible();
      await expect(page.locator('table tbody tr', { hasText: beta.term })).toBeVisible();
    } finally {
      await removeEntry(page, (await findEntry(page, alpha.term)) ?? alpha);
      await removeEntry(page, beta);
    }
  });

  test('a duplicate term is allowed and reported as a conflict, not blocked', async ({ page }) => {
    const term = `e2e-conflict-${Date.now()}`;
    const first = await createEntry(page, draft(term, { aliases: ['e2e-conflict-alias'] }));
    await createEntry(page, draft(term, { aliases: ['e2e-conflict-alias'] }));
    try {
      await page.goto(await adminUrl('/dictionary'));
      await expect(page.getByRole('alert').filter({ hasText: 'Conflicts' })).toBeVisible();
      const conflictRow = page.locator('li', { hasText: term }).first();
      await expect(conflictRow).toBeVisible();
      await expect(conflictRow).toContainText('2 entries');
      // Both entries stay listed: a conflict never blocks or merges by itself.
      await expect(page.locator('table tbody tr', { hasText: term })).toHaveCount(2);
    } finally {
      await removeEntry(page, (await findEntry(page, first.term)) ?? first);
      const remaining = (await listView(page, { scope: 'global' })).items.filter((entry) => entry.term === term);
      for (const entry of remaining) {
        await removeEntry(page, entry);
      }
    }
  });

  test('a stale revision is refused instead of overwriting a concurrent edit', async ({ page }) => {
    const term = `e2e-stale-${Date.now()}`;
    const entry = await createEntry(page, draft(term));
    try {
      await page.goto(await adminUrl('/dictionary'));
      await page
        .locator('table tbody tr', { hasText: term })
        .getByRole('button', { name: `Edit ${term}` })
        .click();
      await page.getByRole('dialog').getByLabel('Definition', { exact: true }).fill('form value');

      // Somebody else moves the entry on while the form is open.
      const current = await findEntry(page, term);
      const concurrent = await page.request.put(await adminUrl(`/api/dictionary/${entry.id}`), {
        headers: { 'if-match': current?.revision ?? '' },
        data: { ...draft(term), definition: 'concurrent value' },
      });
      expect(concurrent.ok()).toBe(true);

      await page.getByRole('dialog').getByRole('button', { name: 'Save entry' }).click();
      await expect(page.getByText('This entry changed while you were editing')).toBeVisible();
      // The dialog closes rather than offering a retry built on stale data.
      await expect(page.getByRole('button', { name: 'Save entry' })).toHaveCount(0);
      const after = await findEntry(page, term);
      expect(after?.definition).toBe('concurrent value');
    } finally {
      await removeEntry(page, (await findEntry(page, term)) ?? entry);
    }
  });

  test('import previews a CSV file and writes nothing before confirmation', async ({ page }) => {
    const stamp = Date.now();
    const term = `e2e-import-${stamp}`;
    const csv = `term,definition,aliases,enabled\n${term},Imported via CSV,alias-one|alias-two,true\n`;

    await page.goto(await adminUrl('/dictionary'));
    await page.getByRole('button', { name: 'Import' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Or paste the content', { exact: true }).fill(csv);
    await dialog.getByRole('button', { name: 'Preview' }).click();

    // Preview shows the parsed row and its split aliases.
    await expect(dialog.getByText('Preview (1 entries)')).toBeVisible();
    await expect(dialog.getByText('alias-one | alias-two')).toBeVisible();
    // Nothing is written yet.
    expect(await findEntry(page, term)).toBeNull();

    await dialog.getByRole('button', { name: 'Import 1 entries' }).click();
    await expect(page.getByText('Imported 1 entries')).toBeVisible();
    const imported = await findEntry(page, term);
    expect(imported?.aliases).toEqual(['alias-one', 'alias-two']);
    if (imported !== null) {
      await removeEntry(page, imported);
    }
  });

  test('export downloads the selected scope in the selected format', async ({ page }) => {
    const stamp = Date.now();
    const term = `e2e-export-${stamp}`;
    const entry = await createEntry(page, draft(term, { aliases: ['e2e-export-alias'] }));
    try {
      await page.goto(await adminUrl('/dictionary'));
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const download = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('dictionary-global.csv');
      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      expect(text).toContain(term);
      expect(text).toContain('e2e-export-alias');
    } finally {
      await removeEntry(page, (await findEntry(page, term)) ?? entry);
    }
  });
});
