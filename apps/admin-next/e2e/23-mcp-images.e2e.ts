import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { adminUrl, test } from './helpers.ts';

test.use({ signedIn: true, mcpImages: true });

test('native tool images load, enlarge and survive refresh in audit, Transcript and Context', async ({ page }) => {
  await page.goto(await adminUrl('/invocations/4001'));
  await page.getByRole('tab', { name: /Tool calls/ }).click();
  const row = page.getByRole('row').filter({ hasText: 'call_mcp_images' });
  await row.getByRole('button', { name: 'Toggle row details' }).click();
  const result = page.locator('[data-tool-result]').first();
  await expect(result.getByText('Before MCP images', { exact: true })).toBeVisible();
  await expect(result.locator('img')).toHaveCount(2);
  for (const image of await result.locator('img').all()) {
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(480);
  }
  await expect(result.locator('p, img').evaluateAll((nodes) => nodes.map((node) => node.tagName))).resolves.toEqual([
    'P',
    'IMG',
    'P',
    'IMG',
    'P',
  ]);
  await page.screenshot({ path: join(tmpdir(), 'surowan-mcp-images-audit.png'), fullPage: true });
  await result.getByRole('button', { name: 'Enlarge tool image 1' }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('dialog')
        .getByRole('img')
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBe(480);
  await page.screenshot({ path: join(tmpdir(), 'surowan-mcp-images-enlarged.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Agent transcript/ }).click();
  await expect(page.getByRole('tabpanel').locator('[data-tool-result] img')).toHaveCount(2);
  await page.reload();
  await page.getByRole('tab', { name: /Agent transcript/ }).click();
  await expect
    .poll(() =>
      page
        .getByRole('tabpanel')
        .locator('[data-tool-result] img')
        .first()
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBe(480);
  await page.goto(await adminUrl('/contexts/2001'));
  const contextRow = page.getByRole('row').filter({ hasText: 'toolResult' });
  await contextRow.getByRole('button', { name: 'Toggle row details' }).click();
  await expect(page.locator('[data-tool-result] img')).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator('[data-tool-result] img')
        .first()
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBe(480);
  await page.screenshot({ path: join(tmpdir(), 'surowan-mcp-images-context.png'), fullPage: true });
});
