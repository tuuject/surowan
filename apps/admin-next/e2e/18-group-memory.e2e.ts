import { expect } from '@playwright/test';
import { adminUrl, test, watchPageIssues } from './helpers.ts';

test.use({ signedIn: true });

test('group memories can be audited, edited and deleted from the panel', async ({ page }) => {
  const finish = watchPageIssues(page);
  const response = await page.request.get(await adminUrl('/api/group-memories?limit=100'));
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: { id: string; summary: string }[] };
  const seeded = body.items.find((item) => item.summary === 'Alice discussed the fixture data.');
  expect(seeded).toBeDefined();

  await page.goto(await adminUrl('/group-memories'));
  await expect(page.getByText('Alice discussed the fixture data.')).toBeVisible();
  const row = page.locator('table tbody tr').filter({ hasText: 'Alice discussed the fixture data.' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByLabel('Summary').fill('Alice discussed the fixture data, edited.');
  await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Alice discussed the fixture data, edited.')).toBeVisible();
  const updated = await page.request.get(await adminUrl(`/api/group-memories?search=edited`));
  expect(updated.ok()).toBe(true);
  expect(((await updated.json()) as { items: { summary: string }[] }).items.map((item) => item.summary)).toContain(
    'Alice discussed the fixture data, edited.',
  );

  await page
    .locator('table tbody tr')
    .filter({ hasText: 'Alice discussed the fixture data, edited.' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('Delete this group memory?');
  await page.getByRole('button', { name: 'Delete group memory', exact: true }).click();
  await expect(page.getByText('Alice discussed the fixture data, edited.')).toHaveCount(0);
  const remaining = await page.request.get(await adminUrl('/api/group-memories?limit=100'));
  const after = (await remaining.json()) as { items: { id: string }[] };
  expect(after.items.some((item) => item.id === seeded?.id)).toBe(false);

  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});

test('consolidation progress shows each Chat and opens its failed batches', async ({ page }) => {
  const finish = watchPageIssues(page);
  const response = await page.request.get(await adminUrl('/api/group-memories/progress'));
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: { chat: { title: string }; lanes: { pending: number }[] }[] };
  const seeded = body.items.find((item) => item.chat.title === 'Surowan Test Group');
  expect(seeded?.lanes[0]?.pending).toBeGreaterThan(0);

  await page.goto(await adminUrl('/group-memories'));
  const panel = page.getByRole('region', { name: 'Consolidation progress', exact: true });
  await expect(panel).toBeVisible();
  const row = panel.locator('table tbody tr').filter({ hasText: 'Surowan Test Group' });
  await expect(row).toContainText('Failing (2 in a row)');
  await expect(row).toContainText('Message 900');
  await expect(row).toContainText(String(seeded?.lanes[0]?.pending));

  await row.getByRole('button', { name: 'View batches', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Consolidation batches')).toBeVisible();
  const failed = dialog.locator('table tbody tr').filter({ hasText: 'Invalid model output' });
  await expect(failed).toContainText('The tool model returned invalid JSON');
  await expect(failed).toContainText('901–902');
  await expect(dialog.locator('table tbody tr').filter({ hasText: '1 event(s)' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const issues = finish();
  expect(issues.pageErrors).toEqual([]);
  expect(issues.externalRequests).toEqual([]);
});
