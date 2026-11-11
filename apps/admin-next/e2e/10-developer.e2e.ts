import { expect } from '@playwright/test';
import { adminUrl, e2eFetch, test } from './helpers.ts';

test.use({ signedIn: true });

test('Developer persists recording preferences and confirms payload-only cleanup', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/settings'));
  await page.getByRole('link', { name: 'Developer', exact: true }).click();
  const recording = page.getByRole('switch', { name: 'Record raw request payloads for debugging' });
  await expect(recording).not.toBeChecked();
  const replayWarning = 'Replay inputs are also deleted; affected historical Invocations can no longer be replayed.';
  await expect(page.getByText(replayWarning, { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('developer-desktop.png'), fullPage: true });
  await recording.click();
  await expect(recording).toBeChecked();
  await page.reload();
  await expect(recording).toBeChecked();
  await recording.click();
  await expect(recording).not.toBeChecked();
  await expect(recording).toBeEnabled();
  const detailUrl = await adminUrl('/api/invocations/4001');
  const before = await (await page.request.get(detailUrl)).json();
  expect(before.model_calls.some((call: { request_json: string | null }) => call.request_json !== null)).toBe(true);

  await page.getByRole('button', { name: 'Clear payloads', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(replayWarning);
  await expect(dialog).toContainText('The database file is not compacted.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await (await page.request.get(detailUrl)).json()).toEqual(before);

  await page.getByRole('button', { name: 'Clear payloads', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm clear', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Cleared debug payloads' })).toBeVisible();
  const after = await (await page.request.get(detailUrl)).json();
  expect(after).toEqual({
    ...before,
    model_calls: before.model_calls.map((call: Record<string, unknown>) => ({
      ...call,
      request_json: null,
      response_json: null,
    })),
  });
  await page.goto(await adminUrl('/invocations/4001'));
  await expect(page.getByText('Raw payloads unavailable (not recorded or cleared).').first()).toBeVisible();
  await page.getByRole('tab', { name: /^Model calls/ }).click();
  await expect(page.getByText('Raw payloads may be unavailable', { exact: false })).toBeVisible();
});

test('Developer reports saved-but-not-applied settings and recovers through Settings', async ({ page }) => {
  await page.goto(await adminUrl('/developer'));
  const recording = page.getByRole('switch', { name: 'Record raw request payloads for debugging' });
  await expect(recording).not.toBeChecked();
  await e2eFetch('/fail-next-config-apply', { method: 'POST' });
  await recording.click();
  await expect(page.getByRole('alert').filter({ hasText: 'updated but not applied' })).toBeVisible();
  await expect(recording).toBeChecked();
  await expect(page.getByRole('alert').filter({ hasText: 'Current running state: Off' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText('developer.record_model_payloads', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Developer', exact: true }).click();
  await expect(recording).toBeChecked();
  await expect(page.getByText('The file setting differs from the running state.', { exact: false })).not.toBeVisible();
  await recording.click();
  await expect(recording).not.toBeChecked();
});

test('Developer records agent thinking separately from payload recording', async ({ page }) => {
  await page.goto(await adminUrl('/developer'));
  const thinking = page.getByRole('switch', { name: 'Record agent thinking (CoT)' });
  await expect(thinking).not.toBeChecked();
  await thinking.click();
  await expect(thinking).toBeChecked();
  // Payload recording stays untouched by a CoT-only update.
  await expect(page.getByRole('switch', { name: 'Record raw request payloads for debugging' })).not.toBeChecked();
  await page.reload();
  await expect(thinking).toBeChecked();
  await thinking.click();
  await expect(thinking).not.toBeChecked();
  await expect(thinking).toBeEnabled();
});

test('Developer actions and confirmation fit a mobile dark viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await adminUrl('/developer'));
  await page.evaluate(() => {
    localStorage.setItem('admin-theme', 'dark');
  });
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Record raw request payloads for debugging' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('developer-mobile-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Clear payloads', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm clear', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('developer-confirm-mobile-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Developer saves the model details source address, and clearing it falls back to models.dev', async ({ page }) => {
  const settings = async () => (await page.request.get(await adminUrl('/api/developer'))).json();
  await page.goto(await adminUrl('/developer'));
  const panel = page.getByRole('region', { name: 'Model details source', exact: true });
  const address = panel.getByLabel('Catalog address', { exact: true });
  await expect(address).toHaveValue('');
  await expect(address).toHaveAttribute('placeholder', 'https://models.dev/api.json');
  await expect(panel.getByRole('button', { name: 'Use the default', exact: true })).toBeDisabled();

  await address.fill('https://mirror.example.test/api.json');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Use the default', exact: true })).toBeEnabled();
  expect(await settings()).toMatchObject({
    models_dev_url: 'https://mirror.example.test/api.json',
    active_models_dev_url: 'https://mirror.example.test/api.json',
  });
  await page.reload();
  await expect(address).toHaveValue('https://mirror.example.test/api.json');

  // Only an HTTP(S) address is accepted; the saved one stays.
  await address.fill('ftp://mirror.example.test/api.json');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('models_dev.api_url');
  expect((await settings()).models_dev_url).toBe('https://mirror.example.test/api.json');

  await panel.getByRole('button', { name: 'Use the default', exact: true }).click();
  await expect(address).toHaveValue('');
  // The button is disabled while the write is in flight too; the view settles it.
  await expect.poll(settings).toMatchObject({ models_dev_url: null, active_models_dev_url: null });
  await expect(panel.getByRole('button', { name: 'Use the default', exact: true })).toBeDisabled();
});
