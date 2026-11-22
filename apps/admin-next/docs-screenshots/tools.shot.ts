/**
 * Tool screenshots: the web-search settings with one engine, and the recurring
 * alarm form with its next-run preview.
 *
 * The engine is built in the page's dialog and saved with the page's own save
 * button; the alarm stays a filled draft (the docs describe building one), so
 * its preview really comes from the schedule engine.
 */
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface SearchView {
  readonly engines: readonly {
    readonly id: string;
    readonly provider: string;
    readonly endpoint: string;
    readonly note: string;
  }[];
  readonly url_filters: readonly string[];
}

test('tools/search-settings', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/search-settings'));
  await expect(page.getByRole('heading', { name: labels.search.title, level: 1 })).toBeVisible();

  // A SearXNG engine needs an instance address and no credential, so the whole
  // flow stays inside the panel's own form.
  await page.getByRole('button', { name: labels.search.addEngine, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: labels.search.addEngine, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(labels.search.fieldId, { exact: true }).fill(seed.search.engineId);
  await dialog.getByLabel(labels.search.fieldProvider, { exact: true }).selectOption('searxng');
  await dialog.getByLabel(labels.search.fieldEndpoint, { exact: true }).fill('https://searx.example.com');
  await dialog.getByLabel(labels.search.fieldNote, { exact: true }).fill(seed.search.note);
  await dialog.getByRole('button', { name: labels.common.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const engineRow = page.locator('table tbody tr').filter({ hasText: seed.search.engineId });
  await expect(engineRow).toBeVisible();
  await expect(engineRow).toContainText('SearXNG');

  // The URL filters panel previews which rule drops which URL, then saves.
  await page.getByLabel(labels.search.filtersLabel, { exact: true }).fill(seed.search.filter);
  // The save is an ordinary config apply; wait for its answer, then read the
  // same values back from the API before the shutter.
  const write = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/search/config',
  );
  await page.getByRole('button', { name: labels.search.save, exact: true }).click();
  expect((await write).ok()).toBe(true);
  await expect(page.getByRole('button', { name: labels.search.save, exact: true })).toBeEnabled();

  const view = await apiJson<SearchView>(page, await adminUrl('/api/search/config'));
  const engine = view.engines.find((entry) => entry.id === seed.search.engineId);
  expect(engine).toMatchObject({
    provider: 'searxng',
    endpoint: 'https://searx.example.com',
    note: seed.search.note,
  });
  expect(view.url_filters).toEqual([seed.search.filter]);

  // The test box is a local preview, not a saved field, so it is filled after
  // the write (the save re-reads every stored value) and shows the saved rule.
  await page.getByLabel(labels.search.testUrls, { exact: true }).fill(seed.search.testUrl);
  const filtered = page.getByRole('listitem').filter({ hasText: seed.search.testUrl });
  await expect(filtered).toBeVisible();
  await expect(filtered).toContainText(seed.search.filter);

  const enginesHeading = page.getByRole('heading', { name: labels.search.enginesTitle, exact: true });
  await expect(enginesHeading).toBeVisible();
  await captureScreenshot(page, docLocale, 'tools/search-settings', 'viewport', {
    scrollTo: enginesHeading,
    align: 'start',
  });
});

test('tools/recurring-alarm', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/recurring-alarms'));
  await expect(page.getByRole('heading', { name: labels.alarms.title, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: labels.alarms.newAlarm, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: labels.alarms.newAlarm, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(labels.alarms.fieldTitle, { exact: true }).fill(seed.alarm.title);
  await dialog.getByLabel(labels.alarms.fieldPrompt, { exact: true }).fill(seed.alarm.prompt);

  // Cron is the schedule form that can say "weekdays at 09:30" exactly; the
  // preview lists the runs the cron engine computed.
  await dialog.getByRole('radio', { name: labels.alarms.modeCron, exact: true }).check();
  await dialog.getByRole('textbox', { name: labels.alarms.modeCron, exact: true }).fill('30 9 * * 1-5');
  const preview = dialog.getByLabel(labels.alarms.previewTitle, { exact: true });
  await expect(preview.locator('li')).toHaveCount(5);
  // The cron says weekdays at 09:30; every computed run must be one of them.
  for (const run of await preview.locator('li').all()) {
    await expect(run).toContainText('09:30');
  }
  await expect(preview.locator('li').first()).toContainText(labels.alarms.firstWeekday);
  await expect(preview.locator('li').nth(4)).toContainText(labels.alarms.lastWeekday);

  await captureScreenshot(page, docLocale, 'tools/recurring-alarm', dialog);
});
