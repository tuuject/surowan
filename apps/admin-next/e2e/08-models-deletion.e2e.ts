import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { ProviderModelConfig, ProvidersView } from '../src/lib/api/providers.ts';
import { adminUrl, appliedToast, modelListRow, test } from './helpers.ts';
import { E2E_RELAY_ALIAS, E2E_SECRETS } from './models-fixture.ts';

test.use({ signedIn: true });

const ALIAS = 'batch-delete';
const batchModel = (id: string): ProviderModelConfig => ({
  id,
  reasoning: false,
  input: ['text'],
  context_window: 4096,
  max_tokens: 128,
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
});
const MODELS: readonly ProviderModelConfig[] = Array.from({ length: 11 }, (_, index) =>
  batchModel(`batch/model-${index}`),
);

test.beforeEach(async ({ request }) => {
  const view = (await (await request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  const relay = view.providers.find((provider) => provider.alias === E2E_RELAY_ALIAS);
  const response = await request.post(await adminUrl('/api/providers'), {
    headers: { 'if-match': view.revision },
    data: {
      alias: ALIAS,
      kind: 'custom',
      base_url: relay?.base_url,
      api: 'openai-completions',
      api_key: E2E_SECRETS.relay,
      models: MODELS,
    },
  });
  expect(response.status()).toBe(200);
});

test.afterEach(async ({ request }) => {
  const view = (await (await request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  const response = await request.delete(await adminUrl(`/api/providers/${ALIAS}`), {
    headers: { 'if-match': view.revision },
  });
  expect(response.status()).toBe(200);
});

test('deletes the selection across pages and providers only after confirmation', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete selected (0)', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await page.getByRole('button', { name: 'Next page', exact: true }).last().click();
  await expect(page.getByLabel('Select batch/model-10', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: `Provider ${E2E_RELAY_ALIAS}`, exact: true }).click();
  await page.getByLabel('Select relay-existing-model', { exact: true }).check();
  await page.getByRole('button', { name: 'Delete selected (12)', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Delete selected models?', exact: true });
  await expect(dialog.getByText(`${ALIAS}/batch/model-10`, { exact: true })).toBeVisible();
  await expect(dialog.getByText(`${E2E_RELAY_ALIAS}/relay-existing-model`, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const before = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  expect(before.providers.find((provider) => provider.alias === ALIAS)?.models).toEqual(MODELS);

  await page.getByRole('button', { name: 'Delete selected (12)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete models', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(appliedToast(page).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete selected (0)', exact: true })).toBeDisabled();
  const after = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  expect(after.providers.find((provider) => provider.alias === ALIAS)?.models).toEqual([]);
  expect(after.providers.find((provider) => provider.alias === E2E_RELAY_ALIAS)?.models).toEqual([]);
  expect(after.agent).toEqual(before.agent);
  expect(after.vision).toEqual(before.vision);
  expect(after.tool_model).toEqual(before.tool_model);
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  await expect(page.getByText('No models yet. Fetch them from the provider, or add them manually.')).toBeVisible();
  const resultPath = testInfo.outputPath('batch-deletion-result.json');
  const screenshotPath = testInfo.outputPath('batch-deletion-page.png');
  await writeFile(resultPath, JSON.stringify(after, null, 2));
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('batch-deletion-result', { path: resultPath, contentType: 'application/json' });
  await testInfo.attach('batch-deletion-page', { path: screenshotPath, contentType: 'image/png' });
});

test('blocks a batch containing a model assigned to a role', async ({ page }) => {
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: 'Provider agent', exact: true }).click();
  await page.getByLabel('Select agent-model', { exact: true }).check();
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  await page.getByLabel('Select batch/model-0', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Delete selected (2)', exact: true })).toBeDisabled();
  await expect(
    page.getByText('A selected model is in use. Deselect it or assign its role to another model first.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Provider agent', exact: true }).click();
  await page.getByLabel('Select agent-model', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Delete selected (1)', exact: true })).toBeEnabled();
});

test('blocks a selection above the 200-model request limit instead of splitting it', async ({ page }, testInfo) => {
  const view = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  const extra = Array.from({ length: 190 }, (_, index) => batchModel(`batch/extra-${index}`));
  const appended = await page.request.post(await adminUrl(`/api/providers/${ALIAS}/models`), {
    headers: { 'if-match': view.revision },
    data: { models: extra },
  });
  expect(appended.status()).toBe(200);
  let batches = 0;
  await page.route('**/api/providers/models/delete', async (route) => {
    batches += 1;
    await route.fallback();
  });

  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Delete selected (201)', exact: true })).toBeDisabled();
  await expect(page.getByText('Up to 200 models can be deleted at once. Deselect some to continue.')).toBeVisible();
  const screenshotPath = testInfo.outputPath('batch-deletion-limit.png');
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('batch-deletion-limit', { path: screenshotPath, contentType: 'image/png' });

  await page.getByLabel('Select batch/model-0', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Delete selected (200)', exact: true })).toBeEnabled();
  await expect(page.getByText('Up to 200 models can be deleted at once.', { exact: false })).toHaveCount(0);
  expect(batches).toBe(0);
});

test('keeps the whole selection after a failed batch and retries with one request', async ({ page }) => {
  let fail = true;
  let batches = 0;
  await page.route('**/api/providers/models/delete', async (route) => {
    batches += 1;
    if (fail) {
      fail = false;
      await route.fulfill({ status: 502, json: { error: 'internal', message: 'Deletion interrupted' } });
      return;
    }
    await route.fallback();
  });
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  for (const index of [0, 1, 2]) {
    await page.getByLabel(`Select batch/model-${index}`, { exact: true }).check();
  }
  await page.getByRole('button', { name: 'Delete selected (3)', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Delete models', exact: true }).click();
  await expect(dialog.getByText('Deletion interrupted', { exact: false })).toBeVisible();
  await expect(dialog.getByText(`${ALIAS}/batch/model-0`, { exact: true })).toBeVisible();
  const unchanged = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  expect(unchanged.providers.find((provider) => provider.alias === ALIAS)?.models).toEqual(MODELS);
  await dialog.getByRole('button', { name: 'Delete models', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete selected (0)', exact: true })).toBeDisabled();
  expect(batches).toBe(2);
  const after = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  expect(after.providers.find((provider) => provider.alias === ALIAS)?.models.map((model) => model.id)).toEqual(
    MODELS.slice(3).map((model) => model.id),
  );
});

test('preserves the existing single-model delete flow', async ({ page }) => {
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: `Provider ${ALIAS}`, exact: true }).click();
  await modelListRow(page, 'batch/model-0').getByRole('button', { name: 'Delete batch/model-0', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this model?', exact: true });
  await dialog.getByRole('button', { name: 'Delete model', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(modelListRow(page, 'batch/model-0')).toHaveCount(0);
  const after = (await (await page.request.get(await adminUrl('/api/providers'))).json()) as ProvidersView;
  expect(after.providers.find((provider) => provider.alias === ALIAS)?.models.map((model) => model.id)).toEqual(
    MODELS.slice(1).map((model) => model.id),
  );
});
