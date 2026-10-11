import { expect, type Page, test } from '@playwright/test';
import type {
  DictionaryDraft,
  DictionaryEntry,
  DictionaryScope,
  DictionarySettings,
  DictionaryView,
} from '../src/lib/api.ts';
import { adminUrl, authStoragePath, watchPageIssues } from './helpers.ts';
import { E2E_MERGE_ALIAS, E2E_MERGE_MODEL, E2E_MERGE_SUGGESTION } from './models-fixture.ts';

/**
 * Dictionary page against the real AdminServer + real SQLite: entry CRUD with
 * optimistic locking, scope isolation, conflict reporting, import/export and
 * the two-step merge (which must not write anything before confirmation).
 * The Tool Model settings live on the Models page and are covered by
 * `18-tool-model.e2e.ts`.
 *
 * The suite shares one server, so every test works on terms unique to itself
 * and cleans up through the API afterwards.
 */
test.use({ storageState: authStoragePath() });

/** Reset between tests: the fixture's dictionary starts empty and stays that way. */
async function clearEntries(page: Page, scope: DictionaryScope, chat: string | null): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const view = await listView(page, { scope, ...(chat === null ? {} : { chat }) });
    const entry = view.items[0];
    if (entry === undefined) {
      return;
    }
    await removeEntry(page, entry);
  }
  throw new Error('dictionary cleanup did not converge');
}

const CHAT_ID = '123456789';

async function listView(
  page: Page,
  query: { readonly scope: 'global' | 'group'; readonly chat?: string; readonly search?: string },
): Promise<DictionaryView> {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.chat !== undefined) {
    params.set('chat', query.chat);
  }
  if (query.search !== undefined) {
    params.set('search', query.search);
  }
  const response = await page.request.get(await adminUrl(`/api/dictionary?${params.toString()}`));
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionaryView;
}

async function findEntry(
  page: Page,
  term: string,
  scope: 'global' | 'group' = 'global',
): Promise<DictionaryEntry | null> {
  const view = await listView(page, { scope, ...(scope === 'group' ? { chat: CHAT_ID } : {}) });
  return view.items.find((entry) => entry.term === term) ?? null;
}

async function removeEntry(page: Page, entry: DictionaryEntry): Promise<void> {
  const response = await page.request.delete(await adminUrl(`/api/dictionary/${entry.id}`), {
    headers: { 'if-match': entry.revision },
  });
  expect(response.ok(), `cleanup delete failed for ${entry.term}`).toBe(true);
}

async function createEntry(page: Page, draft: DictionaryDraft): Promise<DictionaryEntry> {
  const response = await page.request.post(await adminUrl('/api/dictionary'), { data: draft });
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionaryEntry;
}

async function settings(page: Page, chat?: string): Promise<DictionarySettings> {
  const suffix = chat === undefined ? '' : `?chat=${chat}`;
  const response = await page.request.get(await adminUrl(`/api/dictionary/settings${suffix}`));
  if (!response.ok()) {
    console.log('DEBUG settings', response.status(), await response.text());
  }
  expect(response.ok()).toBe(true);
  return (await response.json()) as DictionarySettings;
}

/**
 * Restores an injection mode. The revision is read immediately before the
 * write (the same rule the panel follows), because any settings write moves the
 * config hash every other read was holding.
 */
async function putSettings(
  page: Page,
  chat: string | undefined,
  body: { readonly injection_mode: DictionarySettings['override_mode'] },
): Promise<void> {
  const suffix = chat === undefined ? '' : `?chat=${chat}`;
  const current = await settings(page, chat);
  const response = await page.request.put(await adminUrl(`/api/dictionary/settings${suffix}`), {
    headers: { 'if-match': current.revision },
    data: body,
  });
  expect(response.ok()).toBe(true);
}

function draft(term: string, overrides: Partial<DictionaryDraft> = {}): DictionaryDraft {
  return {
    term,
    definition: `Definition for ${term}`,
    aliases: [],
    scope: 'global',
    chat_id: null,
    enabled: true,
    ...overrides,
  };
}

test.describe('dictionary page', () => {
  test.beforeEach(async ({ page }) => {
    // The shared fixture server accumulates whatever earlier specs left behind;
    // every test here starts from an empty dictionary in both scopes.
    await clearEntries(page, 'global', null);
    await clearEntries(page, 'group', CHAT_ID);
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
    await expect(page.getByText('Entry created')).toBeVisible();

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
    await expect(page.getByText('Entry updated')).toBeVisible();
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
    await expect(page.getByText('Entry deleted')).toBeVisible();
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
    await expect(page.getByText('Entry created')).toBeVisible();

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
    await expect(page.getByText('Entry updated')).toBeVisible();
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
    await expect(page.getByText('Entry created')).toBeVisible();
    expect((await findEntry(page, term))?.aliases).toEqual(['one', 'two']);

    const cleanup = await findEntry(page, term);
    if (cleanup !== null) {
      await removeEntry(page, cleanup);
    }
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
    await expect(page.getByText('Entry created')).toBeVisible();

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

test.describe('dictionary merge', () => {
  test.beforeEach(async ({ page }) => {
    await clearEntries(page, 'global', null);
    await clearEntries(page, 'group', CHAT_ID);
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
