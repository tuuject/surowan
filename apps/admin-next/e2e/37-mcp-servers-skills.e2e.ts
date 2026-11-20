import { expect, type Page, type TestInfo } from '@playwright/test';
import { adminUrl, test, toast } from './helpers.ts';

// The live MCP manager runs the skills fixture, which publishes two verified
// skills. Every test restores the switch it flips, so each passes alone.
test.use({ signedIn: true, mcpManager: true });

async function revision(page: Page): Promise<string> {
  const response = await page.request.get(await adminUrl('/api/mcp-servers'));
  return ((await response.json()) as { revision: string }).revision;
}

async function setSkills(page: Page, skills: boolean): Promise<void> {
  const response = await page.request.fetch(await adminUrl('/api/mcp-servers/skills-fixture'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': await revision(page) },
    data: JSON.stringify({ skills }),
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** The verifiable artifact: one screenshot per state the test asserted. */
async function capture(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  // Finite transitions fast-forward, so a dialog is captured as it settles, not mid-fade.
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('shows the skills badge, the detail section and the exposure switch', async ({ page }, testInfo) => {
  await setSkills(page, true);
  await page.goto(await adminUrl('/mcp-servers'));
  const row = page.locator('table tbody tr', { hasText: 'skills-fixture' });
  await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Skills: 2')).toBeVisible();
  // A server without skills carries no badge.
  await expect(page.locator('table tbody tr', { hasText: 'stdio-fixture' }).getByText(/^Skills:/)).toHaveCount(0);
  await capture(testInfo, page, 'mcp-servers-skills-list');

  await row.getByRole('button', { name: 'View skills-fixture' }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByText('Readable by the model')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await expect(detail.getByText('demo', { exact: true })).toBeVisible();
  await expect(detail.getByText('演示技能 — explains the ping tool')).toBeVisible();
  await expect(detail.getByText('Files: 2,')).toBeVisible();
  await expect(detail.getByText('second', { exact: true })).toBeVisible();
  await capture(testInfo, page, 'mcp-servers-skills-detail');
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toHaveCount(0);
});

test('the edit form switches skills off and the page marks them as not exposed', async ({ page }) => {
  await setSkills(page, true);
  try {
    await page.goto(await adminUrl('/mcp-servers'));
    const row = page.locator('table tbody tr', { hasText: 'skills-fixture' });
    await expect(row.getByText('Skills: 2')).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Edit skills-fixture' }).click();
    const dialog = page.getByRole('dialog');
    const toggle = dialog.getByRole('switch', { name: 'Skills for the model' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Applied')).toBeVisible();

    // The skills stay listed, the detail says they are hidden from the model.
    await expect(row.getByText('Skills: 2')).toBeVisible();
    await row.getByRole('button', { name: 'View skills-fixture' }).click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByText('Hidden from the model')).toBeVisible();
    await expect(detail.getByText('demo', { exact: true })).toBeVisible();
  } finally {
    await setSkills(page, true);
  }
});
