import { expect } from '@playwright/test';
import { adminUrl, e2eFetch, test } from './helpers.ts';

test.use({ signedIn: true });

async function harnessApi(page: import('@playwright/test').Page) {
  return (await (await page.request.get(await adminUrl('/api/harness'))).json()) as {
    saved: Record<string, unknown>;
    active: Record<string, unknown>;
  };
}

test('Harness tuning saves several fields at once and hot-applies them', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/'));
  await page.getByRole('link', { name: 'Harness tuning', exact: true }).click();
  const ttl = page.getByLabel('Reference TTL (hours)');
  const cache = page.getByLabel('Agent cache size');
  const nudge = page.getByRole('switch', { name: 'Send nudge' });
  const save = page.getByRole('button', { name: 'Save and apply' });
  await expect(ttl).toHaveValue('72');
  await expect(nudge).toBeChecked();
  await expect(page.getByLabel('Max text length')).toHaveValue('');
  // Config key names are a per-browser display preference, off by default.
  await expect(page.getByText('agent.context.ref_ttl_hours', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Models', exact: true }).last()).toBeVisible();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('harness-desktop.png'), fullPage: true });

  await ttl.fill('24');
  await cache.fill('2');
  await nudge.click();
  await expect(page.getByText('3 unsaved changes')).toBeVisible();
  await save.click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(ttl).toHaveValue('24');
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    'context.ref_ttl_hours': 24,
    'context.agent_cache_size': 2,
    send_nudge_enabled: false,
  });
  expect(applied.active).toEqual(applied.saved);

  await page.reload();
  await expect(ttl).toHaveValue('24');
  await expect(nudge).not.toBeChecked();
  // Discarding restores the saved file values.
  await ttl.fill('48');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(ttl).toHaveValue('24');
});

test('Harness tuning flags invalid input locally and reports cross-field errors from the server', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const ttl = page.getByLabel('Reference TTL (hours)');
  await ttl.fill('721');
  await expect(page.getByText('Must be at most 720')).toBeVisible();
  await expect(page.getByText('Fix the highlighted fields before saving.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();
  await ttl.fill('72');

  // Schema-valid on its own, invalid next to retained_sends_max = 3.
  await page.getByLabel('Retained sends target').fill('3');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('retained_sends_target must be smaller than retained_sends_max');
  expect((await harnessApi(page)).saved).toMatchObject({ 'context.retained_sends_target': 2 });
});

test('Harness tuning shows the running value when a save was written but not applied', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await page.getByLabel('History messages').fill('9');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByRole('alert')).toContainText('updated but not applied');
  await expect(page.getByLabel('History messages')).toHaveValue('9');
  await expect(page.getByRole('status').filter({ hasText: 'Running: 20' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText('agent.history_messages', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Harness tuning', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Running:' })).toHaveCount(0);
});

test('Panel preferences toggle config key names for this browser only', async ({ page, browser }) => {
  await page.goto(await adminUrl('/harness'));
  await expect(page.getByLabel('Reference TTL (hours)')).toBeVisible();
  await expect(page.getByText('agent.context.ref_ttl_hours', { exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Panel preferences', exact: true }).click();
  const keys = page.getByRole('switch', { name: 'Show config.jsonc key names' });
  await expect(keys).not.toBeChecked();
  await keys.click();
  await expect(keys).toBeChecked();
  await page.reload();
  await expect(keys).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('admin-show-config-keys'))).toBe('true');

  await page.getByRole('link', { name: 'Harness tuning', exact: true }).click();
  await expect(page.getByText('agent.context.ref_ttl_hours', { exact: true })).toBeVisible();
  await expect(page.getByText('agent.rate_limits.window_seconds', { exact: true })).toBeVisible();

  // Nothing reached the server: a fresh browser context still hides the keys.
  const other = await browser.newContext({
    storageState: await page
      .context()
      .storageState({})
      .then((state) => ({
        ...state,
        origins: [],
      })),
  });
  const otherPage = await other.newPage();
  await otherPage.goto(await adminUrl('/harness'));
  await expect(otherPage.getByLabel('Reference TTL (hours)')).toBeVisible();
  await expect(otherPage.getByText('agent.context.ref_ttl_hours', { exact: true })).toHaveCount(0);
  await other.close();

  await page.getByRole('link', { name: 'Panel preferences', exact: true }).click();
  await keys.click();
  await expect(keys).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('admin-show-config-keys'))).toBeNull();
});
