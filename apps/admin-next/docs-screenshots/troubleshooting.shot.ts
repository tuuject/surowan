/**
 * Troubleshooting screenshots: the configuration drift the Settings page
 * reports, and a tool session with its calls and the Telegram send.
 *
 * The drift is produced by the documented cause: a Chat edit that only takes
 * effect after a restart, saved through the Chats dialog. The tool session is
 * the docs seed's completed run, expanded through the table's own disclosure.
 */
import { adminUrl } from '../e2e/helpers.ts';
import { DOCS_IDS } from '../e2e/server-docs-ids.ts';
import { captureScreenshot } from './capture.ts';
import { expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

// The Tool calls shot uses the docs-only completed run.
test.use({ docsRuns: true });

const GROUP = DOCS_IDS.groupChatHostId.toString();

test('troubleshooting/config-drift', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/chats'));
  const row = page.locator('table tbody tr').filter({ hasText: GROUP });
  await expect(row).toBeVisible();

  // Topic IDs are read when the allowlist loads, so the write lands in the file
  // and waits for the restart the page then warns about.
  await row.getByRole('button', { name: labels.common.edit, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(labels.chats.topicIds, { exact: true }).fill('12, 34');
  await dialog.getByRole('button', { name: labels.chats.saveChat, exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.goto(await adminUrl('/settings'));
  const card = page.getByRole('region', { name: labels.settings.configFile, exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText(labels.settings.fileHasChanges, { exact: true })).toBeVisible();
  await expect(card.getByText(`telegram.chats[${GROUP}].topic_ids`, { exact: false })).toBeVisible();
  await expect(card.getByRole('button', { name: labels.settings.applyConfigFile, exact: true })).toBeEnabled();

  await captureScreenshot(page, docLocale, 'troubleshooting/config-drift', card);
});

test('troubleshooting/tool-calls', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const id = DOCS_IDS.toolInvocation.toString();
  await page.goto(await adminUrl(`/invocations/${id}`));
  await expect(page.getByText(labels.invocations.title(id)).first()).toBeVisible();

  const tabName = labels.invocations.toolCallsTab(2);
  await page.getByRole('tab', { name: tabName, exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: tabName, exact: true });
  await expect(panel.getByText('call_read_202', { exact: true })).toBeVisible();
  await expect(panel.getByText('call_send_202', { exact: true })).toBeVisible();

  // Expanding the send row reveals the arguments and the result the runtime
  // recorded, which is what the troubleshooting guide points at.
  const sendRow = panel.locator('tr').filter({ hasText: 'call_send_202' });
  await sendRow.getByRole('button', { name: labels.invocations.toggleRowDetails }).click();
  await expect(panel.getByText(labels.invocations.arguments, { exact: true }).first()).toBeVisible();
  await expect(panel.getByText(labels.invocations.result, { exact: true }).first()).toBeVisible();
  await expect(panel.getByText('sent', { exact: true }).first()).toBeVisible();

  await captureScreenshot(page, docLocale, 'troubleshooting/tool-calls', 'viewport', {
    scrollTo: panel,
    align: 'start',
  });
});
