/**
 * Image screenshots: the settings page, the workbench, a completed generation
 * record, the asset editor with AI extraction, and the sticker sets.
 *
 * The whole file needs the docs image service the E2E backend starts
 * (`server-boot.ts` + `server-docs-image.ts`): a real `ImageService`, a real
 * worker and real database rows, with the vendor answered in-process. The
 * reference image and the prompt asset are created through the panel's own API,
 * and the workbench resolves and submits through its real buttons.
 */
import type { Page } from '@playwright/test';
import { docsSeedText } from '../e2e/docs-locale.ts';
import { adminUrl } from '../e2e/helpers.ts';
import { docsIllustration } from '../e2e/server-docs-image.ts';
import { captureScreenshot } from './capture.ts';
import { apiJson, expect, test } from './fixtures.ts';
import { docsLabels } from './labels.ts';

interface ImageAsset {
  readonly id: string;
  readonly name: string;
}

interface ImageConfigView {
  readonly enabled: boolean;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly credential_key_sources?: Readonly<Record<string, { readonly kind: string; readonly name?: string }>>;
}

interface GenerationView {
  readonly id: string;
  readonly status: string;
}

/** Uploads the docs illustration as the reference image and returns the asset. */
async function uploadReference(
  page: Page,
  name: string,
  description: string,
  category: string,
  keywords: string,
): Promise<ImageAsset> {
  // This file's tests share one server, so a second scenario reuses the asset
  // the first one already uploaded instead of adding a duplicate row.
  const listed = await page.request.get(await adminUrl(`/api/image/images?q=${encodeURIComponent(name)}`));
  expect(listed.ok(), await listed.text()).toBe(true);
  const existing = ((await listed.json()) as { items: readonly ImageAsset[] }).items.find((item) => item.name === name);
  if (existing !== undefined) {
    return existing;
  }
  const response = await page.request.post(await adminUrl('/api/image/images'), {
    data: { name, base64: await docsIllustration(), mime: 'image/png', description, category },
  });
  expect(response.status(), await response.text()).toBe(201);
  const asset = (await response.json()) as ImageAsset;
  const updated = await page.request.put(await adminUrl(`/api/image/images/${asset.id}`), {
    data: { keywords, agentVisible: true },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  return asset;
}

test('images/image-settings', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/image-settings'));
  await expect(page.getByRole('heading', { name: labels.images.settingsTitle, level: 1 })).toBeVisible();

  // The section the docs seed wrote is what the page reads back: enabled, one
  // model, and the model card carrying the configured notes.
  const enable = page.getByRole('checkbox', { name: labels.images.enableLabel, exact: true });
  await expect(enable).toBeChecked();
  const models = page.getByRole('region', { name: labels.images.modelsPanel, exact: true });
  await expect(models).toBeVisible();
  await expect(models.getByRole('button', { name: labels.images.removeModel(seed.images.modelName) })).toBeVisible();
  await expect(models.getByLabel(labels.images.modelNotes, { exact: true })).toHaveValue(seed.images.modelNotes);
  await expect(page.getByText(labels.images.readyToSave, { exact: true })).toBeVisible();

  const view = await apiJson<ImageConfigView>(page, await adminUrl('/api/image/config'));
  expect(view.enabled).toBe(true);
  expect(view.models.map((model) => model.name)).toContain(seed.images.modelName);
  expect(view.credential_key_sources?.openrouter).toEqual({ kind: 'entry', name: 'image' });

  // Taller than the project frame on purpose: the shot holds the enable switch
  // with its credential row and the saved model row, and the sticky save bar
  // ends up below both instead of across the model card.
  await page.setViewportSize({ width: 1440, height: 1400 });
  const credential = page.getByRole('region', { name: labels.images.enablePanel, exact: true });
  await expect(credential).toBeVisible();
  await expect(enable).toBeInViewport();
  await expect(models.getByLabel(labels.images.modelNotes, { exact: true })).toBeInViewport();
  await expect(page.getByText(labels.images.readyToSave, { exact: true })).toBeInViewport();

  await captureScreenshot(page, docLocale, 'images/image-settings');
});

test('images/generate-workbench', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  const reference = await uploadReference(
    page,
    seed.images.referenceName,
    seed.images.referenceDescription,
    seed.images.referenceCategory,
    seed.images.referenceKeywords,
  );
  const prompt = await page.request.post(await adminUrl('/api/image/prompts'), {
    data: { name: seed.images.promptAssetName, body: seed.images.promptAssetBody },
  });
  expect(prompt.status(), await prompt.text()).toBe(201);

  await page.goto(await adminUrl('/image-generate'));
  await expect(page.getByRole('heading', { name: labels.images.generateTitle, level: 1 })).toBeVisible();

  // The typed reference is the documented inline token; the prompt asset is
  // attached through its own tag, exactly as an operator builds the request.
  const promptField = page.getByLabel(labels.images.promptLabel, { exact: true });
  await promptField.fill(`${seed.images.promptPrefix}{{image:${reference.id}}}${seed.images.promptSuffix}`);
  await page.getByText(seed.images.promptAssetName, { exact: true }).click();
  await expect(page.getByText(seed.images.referenceName, { exact: true }).first()).toBeVisible();

  // The panel's "Default (only model)" choice sends no model id and the
  // workspace rejects that, so the shot documents the explicit selection.
  await page
    .getByRole('combobox', { name: labels.images.generationModel, exact: true })
    .selectOption({ label: seed.images.modelName });
  await page.getByRole('button', { name: labels.images.resolvePreview, exact: true }).click();
  const resolved = page.getByText(labels.images.resolvedPrompt, { exact: true });
  await expect(resolved).toBeVisible();
  // The resolution expands the attached asset's body and numbers the reference,
  // which is what the final prompt sent to the model looks like.
  const resolvedPrompt = page.locator('pre');
  await expect(resolvedPrompt).toContainText('图 1');
  await expect(resolvedPrompt).toContainText(seed.images.promptAssetBody);

  await captureScreenshot(page, docLocale, 'images/generate-workbench');

  // The same request, submitted for real: the worker runs and the record opens.
  await page.getByRole('button', { name: labels.images.generate, exact: true }).click();
  const audit = page.getByRole('link', { name: labels.images.auditDetail, exact: true });
  await expect(audit).toBeVisible({ timeout: 30_000 });
  await audit.click();
  await expect(page).toHaveURL(/\/image-generations\/[\w-]+$/);
  const generationId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(generationId.length).toBeGreaterThan(0);

  await expect
    .poll(
      async () =>
        (await apiJson<GenerationView>(page, await adminUrl(`/api/image/generations/${generationId}`))).status,
      { timeout: 60_000 },
    )
    .toBe('succeeded');
  await page.reload();
  await expect(page.getByText(labels.images.finalPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText('图 1', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(labels.images.generationId, { exact: true })).toBeVisible();
  // The output and the reference preview come from the image API: wait until
  // every picture on the page has decoded, or the shot catches empty boxes.
  await expect
    .poll(() =>
      page
        .locator('main img')
        .evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);

  await captureScreenshot(page, docLocale, 'images/generation-record');
});

test('images/image-assets', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await uploadReference(
    page,
    seed.images.referenceName,
    seed.images.referenceDescription,
    seed.images.referenceCategory,
    seed.images.referenceKeywords,
  );

  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByRole('heading', { name: labels.images.assetsTitle, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: labels.images.tabImages, exact: true }).click();
  const row = page.locator('table tbody tr').filter({ hasText: seed.images.referenceName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: labels.common.edit, exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const agentVisible = dialog.getByRole('switch', { name: labels.images.agentVisible, exact: true });
  await expect(agentVisible).toBeChecked();
  const extract = dialog.getByRole('button', { name: labels.images.extract, exact: true });
  await expect(extract).toBeEnabled();

  // The extraction really calls the Tool Model; the fixture upstream answers
  // with a proposal, which fills the name and keyword fields.
  await extract.click();
  await expect(dialog.getByLabel(labels.images.assetName, { exact: true })).toHaveValue(seed.images.extractedName, {
    timeout: 30_000,
  });

  await captureScreenshot(page, docLocale, 'images/image-assets', dialog);
});

test('images/sticker-sets', async ({ page, docLocale }) => {
  const labels = docsLabels(docLocale);
  const seed = docsSeedText(docLocale);
  await page.goto(await adminUrl('/stickers'));
  await expect(page.getByRole('region', { name: labels.stickers.setsTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: labels.stickers.indexTitle, exact: true })).toBeVisible();

  // The seeded set is configured and synced; the indexed sticker carries the
  // localized description the vision model wrote.
  const setRow = page.locator('table tbody tr').filter({ hasText: 'surowan_mascot' });
  await expect(setRow.first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: labels.stickers.description, exact: true })).toBeVisible();
  // The index holds the whole fixture, so the docs shot narrows it to the one
  // sticker whose analysis the vision model wrote. Both index assertions stay
  // inside that filtered table, which must hold exactly one row.
  const search = page.getByLabel(labels.stickers.search, { exact: true });
  await search.fill('👋');
  await search.press('Enter');
  // The sets table sits above the index; only the last table is the index.
  const indexRows = page.locator('table').last().locator('tbody tr');
  await expect(indexRows).toHaveCount(1);
  const indexRow = indexRows.first();
  await expect(indexRow.getByRole('cell', { name: seed.memories.stickerDescription, exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: labels.stickers.description, exact: true })).toHaveCount(1);

  await captureScreenshot(page, docLocale, 'images/sticker-sets');
});
