import { expect } from '@playwright/test';
import { adminUrl, clickNav, e2eFetch, test } from './helpers.ts';

test.use({ signedIn: true });

async function harnessApi(page: import('@playwright/test').Page) {
  return (await (await page.request.get(await adminUrl('/api/harness'))).json()) as {
    saved: Record<string, unknown>;
    active: Record<string, unknown>;
  };
}

test('Harness tuning saves several fields at once and hot-applies them', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/'));
  await clickNav(page, 'Agent setup', 'Harness tuning');
  const ttl = page.getByLabel('Reference TTL (hours)');
  const cache = page.getByLabel('Agent cache size');
  const nudge = page.getByRole('switch', { name: 'Send nudge' });
  const save = page.getByRole('button', { name: 'Save and apply' });
  await expect(ttl).toHaveValue('72');
  await expect(nudge).toBeChecked();
  await expect(page.getByLabel('Max text length')).toHaveValue('');
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

  await clickNav(page, 'System', 'Settings');
  await page.getByRole('button', { name: 'Apply config file' }).click();
  await expect(page.getByText('agent.history_messages', { exact: false })).toBeVisible();
  await clickNav(page, 'Agent setup', 'Harness tuning');
  await expect(page.getByRole('status').filter({ hasText: 'Running:' })).toHaveCount(0);
});

test('Harness tuning edits the empty-text strategy and fallback list', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const strategy = page.getByRole('combobox', { name: 'Empty-text sends' });
  const texts = page.getByLabel('Fallback texts');
  await expect(strategy).toHaveValue('reject');
  await expect(texts).toHaveValue('……');

  await texts.fill('  \n ');
  await expect(page.getByText('Enter at least one line')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();

  await strategy.selectOption('random_text');
  await texts.fill('……\n 嗯 \n\n啊这');
  await expect(page.getByText('2 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(texts).toHaveValue('……\n嗯\n啊这');
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    send_empty_text_strategy: 'random_text',
    send_empty_text_fallback_texts: ['……', '嗯', '啊这'],
  });
  expect(applied.active).toEqual(applied.saved);
});

test('Harness tuning edits the global proactive reply defaults', async ({ page }) => {
  await page.goto(await adminUrl('/harness'));
  const enabled = page.getByRole('switch', { name: 'Schedule proactive replies' });
  const base = page.getByLabel('First-try chance');
  const pity = page.getByLabel('Maximum tries');
  // Absent from the fixture file: the runtime defaults are shown.
  await expect(enabled).not.toBeChecked();
  await expect(base).toHaveValue('0.2');
  await expect(page.getByLabel('Increase after each miss')).toHaveValue('0.1');
  await expect(pity).toHaveValue('8');

  await base.fill('1.5');
  await expect(page.getByText('Must be at most 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and apply' })).toBeDisabled();

  await enabled.click();
  await base.fill('0.35');
  await pity.fill('5');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  const applied = await harnessApi(page);
  expect(applied.saved).toMatchObject({
    'proactive_reply.enabled': true,
    'proactive_reply.base_probability': 0.35,
    'proactive_reply.increment': 0.1,
    'proactive_reply.hard_pity': 5,
  });
  expect(applied.active).toEqual(applied.saved);
});
