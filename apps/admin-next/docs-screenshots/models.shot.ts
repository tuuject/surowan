/**
 * Models screenshots: the provider registry, a health check and the role cards.
 *
 * Nothing here mints a real connection: the providers point at the loopback
 * upstream the E2E server starts (`e2e/server-relay.ts`), whose model listing
 * and canned replies are the fixture the panel really talks to.
 */
import { DOCS_MODELS, DOCS_PROVIDERS, docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface ProvidersView {
  readonly providers: readonly {
    readonly alias: string;
    readonly models: readonly { readonly id: string }[];
  }[];
}

test('models/providers-list', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: labels.models.provider(DOCS_PROVIDERS.relay), exact: true }).click();

  // The rail selection is real: the model list belongs to the selected provider.
  const models = page.locator('[data-model-list]');
  await expect(models).toBeVisible();
  await expect(models.locator('li')).toHaveCount(2);
  await expect(models.getByText(seed.models.agent, { exact: true })).toBeVisible();
  await expect(models.getByText(seed.models.vision, { exact: true })).toBeVisible();

  // Read the same list back through the API before the shutter.
  const view = await apiJson<ProvidersView>(page, await adminUrl('/api/providers'));
  const relay = view.providers.find((provider) => provider.alias === DOCS_PROVIDERS.relay);
  expect(relay?.models.map((model) => model.id)).toEqual([DOCS_MODELS.agent, DOCS_MODELS.vision]);

  // The connection form above the list carries the loopback fixture's random
  // port, so the shot scrolls past it: the sticky provider rail stays pinned and
  // the model list sits under the app header, which is what the guide shows.
  const modelsPanel = page.getByRole('region', { name: labels.models.modelsTitle, exact: true });
  await expect(modelsPanel).toBeVisible();
  await captureScreenshot(page, docLocale, 'models/providers-list', 'viewport', {
    scrollTo: modelsPanel,
    align: 'start',
  });
});

test('models/provider-health-check', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/providers'));
  await page.getByRole('button', { name: labels.models.provider(DOCS_PROVIDERS.health), exact: true }).click();

  const row = page.locator('[data-model-list] li').filter({ hasText: DOCS_MODELS.health });
  await expect(row).toBeVisible();
  // The page runs the real probe; the local upstream answers the fixed prompt.
  await row.getByRole('button', { name: labels.models.checkHealth(DOCS_MODELS.health) }).click();
  await expect(row.getByText(labels.models.healthOk, { exact: true })).toBeVisible({ timeout: 20_000 });
  const reply = row.getByText(labels.models.modelReply, { exact: false });
  await expect(reply).toBeVisible();
  await expect(reply).toContainText('ok');
  await expect(row.getByText(seed.models.health, { exact: true })).toBeVisible();

  await captureScreenshot(page, docLocale, 'models/provider-health-check', row);
});

test('models/model-roles', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  await page.goto(await adminUrl('/models'));
  await expect(page.getByText(labels.roles.pageDescription, { exact: true })).toBeVisible();

  const agent = page.getByRole('region', { name: labels.roles.agentTitle, exact: true });
  const vision = page.getByRole('region', { name: labels.roles.visionTitle, exact: true });
  const tool = page.getByRole('region', { name: labels.roles.toolTitle, exact: true });
  await expect(agent).toBeVisible();
  await expect(vision).toBeVisible();
  await expect(tool).toBeVisible();

  // A draft change, not a write: the shot shows the save bar the page grows
  // when something is pending. Discarding it afterwards keeps the run clean.
  const effort = agent.getByRole('combobox', { name: labels.roles.thinkingEffort, exact: true });
  await expect(effort).toHaveValue('low');
  await effort.selectOption('medium');
  await expect(page.getByText(labels.roles.pending(1), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: labels.roles.save, exact: true })).toBeEnabled();

  await captureScreenshot(page, docLocale, 'models/model-roles');

  await page.getByRole('button', { name: labels.roles.discard, exact: true }).click();
  await expect(page.getByText(labels.roles.unchanged, { exact: true })).toBeVisible();
  await expect(effort).toHaveValue('low');
});
