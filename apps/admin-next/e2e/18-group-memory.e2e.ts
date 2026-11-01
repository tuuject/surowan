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
