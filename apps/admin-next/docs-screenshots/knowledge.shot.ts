/**
 * Knowledge screenshots: the memo editor, the group-memory progress panel, the
 * 30-hour clock and the dictionary import preview.
 *
 * The memo and the group summary come from the localized docs seed; the clock
 * is saved through the Chat dialog and read back; the dictionary import stops
 * at the preview, which is the state the docs describe (nothing is written).
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { DOCS_IDS } from '../e2e/server-docs-ids.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface ChatsView {
  readonly items: readonly {
    readonly id: string;
    readonly saved: { readonly group_memory: { readonly enabled: boolean } | null } | null;
  }[];
}

interface DictionaryView {
  readonly items: readonly { readonly term: string; readonly aliases: readonly string[] }[];
}

test('knowledge/memo-editor', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/memories'));
  const row = page.locator('table tbody tr').filter({ hasText: seed.memories.activeSummary });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: labels.common.edit, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(labels.memories.summary, { exact: true })).toHaveValue(seed.memories.activeSummary);
  await expect(dialog.getByLabel(labels.memories.detail, { exact: true })).toHaveValue(seed.memories.activeDetail);
  const ttl = dialog.getByLabel(labels.memories.ttl, { exact: true });
  await expect(ttl).not.toHaveValue('');

  await captureScreenshot(page, docLocale, 'knowledge/memo-editor', dialog);
});

test('knowledge/group-memory-progress', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/group-memories'));
  const panel = page.getByRole('region', { name: labels.groupMemories.progressTitle, exact: true });
  await expect(panel).toBeVisible();

  const row = panel.locator('table tbody tr').filter({ hasText: seed.chatTitle });
  await expect(row).toContainText(labels.groupMemories.statusFailing(2));
  await expect(row).toContainText('900');
  // The pending count comes from the same progress read the row renders.
  const progress = await apiJson<{
    readonly items: readonly {
      readonly chat: { readonly title: string };
      readonly lanes: readonly { readonly pending: number }[];
    }[];
  }>(page, await adminUrl('/api/group-memories/progress'));
  const pending = progress.items.find((item) => item.chat.title === seed.chatTitle)?.lanes[0]?.pending ?? 0;
  expect(pending).toBeGreaterThan(0);
  await expect(row.getByRole('cell').nth(3)).toHaveText(String(pending));
  await expect(row.getByRole('button', { name: labels.groupMemories.viewRuns, exact: true })).toBeVisible();

  await captureScreenshot(page, docLocale, 'knowledge/group-memory-progress', panel);
});

test('knowledge/thirty-hour-clock', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const group = DOCS_IDS.groupChatHostId.toString();
  await page.goto(await adminUrl('/chats'));
  const row = page.locator('table tbody tr').filter({ hasText: group });
  await expect(row).toBeVisible();

  const openDialog = async (): Promise<void> => {
    await row.getByRole('button', { name: labels.chats.moreActions, exact: true }).click();
    await page.getByRole('menuitem', { name: labels.chats.editGroupMemory, exact: true }).click();
  };

  // Group memory starts off; enabling it and picking the clock mode is one save.
  await openDialog();
  let dialog = page.getByRole('dialog', { name: labels.chats.groupMemory.title, exact: true });
  await expect(dialog.getByRole('switch', { name: labels.chats.groupMemory.enable, exact: true })).not.toBeChecked();
  await dialog.getByRole('switch', { name: labels.chats.groupMemory.enable, exact: true }).click();
  const clock = dialog.getByRole('radiogroup', { name: labels.chats.groupMemory.thirtyHour, exact: true });
  await clock.getByRole('radio', { name: labels.chats.groupMemory.thirtyHourExclusive }).click();
  await dialog.getByRole('button', { name: labels.chats.dialogSave, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Read the stored Chat back, then wait for the row to render it: the dialog
  // reopens on the row's query, so mounting it earlier can show the old value.
  const view = await apiJson<ChatsView>(page, await adminUrl('/api/chats'));
  const saved = view.items.find((item) => item.id === group)?.saved?.group_memory;
  expect(saved).toMatchObject({ enabled: true, thirty_hour_clock: 'non_overlapping' });
  await expect(row.getByRole('cell').nth(6)).toContainText(labels.chats.groupMemory.thirtyHourSummary);

  await openDialog();
  dialog = page.getByRole('dialog', { name: labels.chats.groupMemory.title, exact: true });
  await expect(clock.getByRole('radio', { name: labels.chats.groupMemory.thirtyHourExclusive })).toBeChecked();
  await expect(page.locator('[data-koi-toast]')).toHaveCount(0);

  await captureScreenshot(page, docLocale, 'knowledge/thirty-hour-clock', dialog);
});

test('knowledge/dictionary-import', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    'term,definition,aliases,enabled',
    [
      quote(seed.dictionary.importedTerm),
      quote(seed.dictionary.importedDefinition),
      quote(seed.dictionary.importedAliases.join('|')),
      'true',
    ].join(','),
    '',
  ].join('\n');

  await page.goto(await adminUrl('/dictionary'));
  await page.getByRole('button', { name: labels.dictionary.importButton, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(labels.dictionary.pasteLabel, { exact: true }).fill(csv);
  await dialog.getByRole('button', { name: labels.dictionary.previewButton, exact: true }).click();

  // The preview parses the pasted row and splits the alias cell; nothing is written.
  await expect(dialog.getByText(labels.dictionary.previewTitle(1), { exact: true })).toBeVisible();
  await expect(dialog.getByText(seed.dictionary.importedTerm, { exact: true })).toBeVisible();
  await expect(dialog.getByText(seed.dictionary.importedAliases.join(' | '), { exact: false })).toBeVisible();
  const view = await apiJson<DictionaryView>(page, await adminUrl('/api/dictionary?scope=global'));
  expect(view.items.some((entry) => entry.term === seed.dictionary.importedTerm)).toBe(false);

  await captureScreenshot(page, docLocale, 'knowledge/dictionary-import');
});
