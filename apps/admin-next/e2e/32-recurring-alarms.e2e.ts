import { stat } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

/**
 * Recurring alarms page against the real AdminServer + real SQLite: build a
 * schedule with the rule controls, read its preview, switch to cron, disable,
 * Run now and delete. No Scheduler runs in the E2E backend, so a manual run
 * stays undelivered: the detail shows it queued, and a second run is refused.
 */
test.use({ signedIn: true });

test.describe('recurring alarms page', () => {
  test('create with rule controls, edit as cron, disable, run now and delete', async ({ page }) => {
    const title = `e2e-greeting-${Date.now()}`;
    await page.goto(await adminUrl('/recurring-alarms'));
    await expect(page.getByRole('heading', { name: 'Recurring alarms', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'New recurring alarm' }).click();
    const form = page.getByRole('dialog', { name: 'New recurring alarm' });
    await form.getByLabel('Title').fill(title);
    await form.getByLabel('Prompt').fill('Say good morning to everyone.');
    // The default rule is every day at 08:00; the preview lists five runs.
    const preview = form.getByLabel('Next runs');
    await expect(preview.locator('li')).toHaveCount(5);
    await expect(preview.locator('li').first()).toContainText('08:00');
    // Every 2 minutes is allowed but warned about.
    await form.getByRole('combobox', { name: 'Minute mode' }).selectOption('every');
    await form.getByRole('textbox', { name: 'Minute step' }).fill('2');
    await form.getByRole('combobox', { name: 'Hour mode' }).selectOption('every');
    await expect(preview.getByText('Two runs are less than 5 minutes apart.')).toBeVisible();
    await form.getByRole('combobox', { name: 'Minute mode' }).selectOption('at');
    await form.getByRole('textbox', { name: 'Minute', exact: true }).fill('0,30');
    await form.getByRole('combobox', { name: 'Hour mode' }).selectOption('at');
    await form.getByRole('textbox', { name: 'Hour', exact: true }).fill('8');
    await expect(preview.locator('li')).toHaveCount(5);
    await expect(preview.getByText('Two runs are less than 5 minutes apart.')).toHaveCount(0);
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(form).toBeHidden();

    const row = page.locator('table tbody tr', { hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText('0,30 8 * * *');

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: `Edit ${title}` });
    await edit.getByRole('radio', { name: 'Cron' }).check();
    const cron = edit.getByRole('textbox', { name: 'Cron' });
    await expect(cron).toHaveValue('0,30 8 * * *');
    await cron.fill('0 8 L * *');
    await expect(edit.getByLabel('Next runs')).toContainText('Rule 1:');
    await cron.fill('30 9 * * 1-5');
    await expect(edit.getByLabel('Next runs').locator('li')).toHaveCount(5);
    // `1-5` has no rule-control form, so switching back is refused.
    await edit.getByRole('radio', { name: 'Rules' }).click();
    await expect(edit.getByText(/Some rules use syntax the rule builder cannot show/)).toBeVisible();
    await expect(edit.getByRole('radio', { name: 'Cron' })).toBeChecked();
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(row).toContainText('30 9 * * 1-5');

    const toggle = row.getByRole('switch', { name: `Enable ${title}` });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // A disabled alarm still runs on demand.
    await row.getByRole('button', { name: 'Run now' }).click();
    const confirmRun = page.getByRole('alertdialog');
    await expect(confirmRun.getByRole('heading', { name: `Run “${title}” now?` })).toBeVisible();
    await confirmRun.getByRole('button', { name: 'Run now' }).click();
    const details = page.getByRole('dialog', { name: title });
    await expect(details.getByRole('cell', { name: 'Manual', exact: true })).toBeVisible();
    await expect(details.getByRole('cell', { name: 'Queued', exact: true })).toBeVisible();
    // Artifact: the run history as the admin sees it right after Run now.
    const screenshotPath = test.info().outputPath('recurring-alarm-run-now.png');
    await details.screenshot({ path: screenshotPath });
    expect((await stat(screenshotPath)).size).toBeGreaterThan(0);
    await details.getByRole('button', { name: 'Dismiss' }).click();

    await row.getByRole('button', { name: 'Run now' }).click();
    await confirmRun.getByRole('button', { name: 'Run now' }).click();
    await expect(confirmRun.getByText('The previous run has not been delivered yet.')).toBeVisible();
    await confirmRun.getByRole('button', { name: 'Dismiss' }).click();

    await row.getByRole('button', { name: 'Delete' }).click();
    const confirmDelete = page.getByRole('alertdialog');
    await expect(confirmDelete.getByRole('heading', { name: `Delete “${title}”?` })).toBeVisible();
    await confirmDelete.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('table tbody tr', { hasText: title })).toHaveCount(0);
  });
});
