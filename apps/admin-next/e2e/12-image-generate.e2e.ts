import { expect } from '@playwright/test';
import sharp from 'sharp';
import type { ImageAssetInfo, ImageGenerationRecord } from '../src/lib/api/images.ts';
import { adminUrl, test, toast } from './helpers.ts';

test.use({ signedIn: true });

/**
 * The image workspace against a stateful fake image service: picking a
 * reference asset inserts its token at the caret, the referenced strip mirrors
 * the prompt text and edits it on removal, submissions never carry the old
 * `input_image_refs` field, and the form and this run's outputs stack
 * vertically at every width.
 */

const NOW = '2026-10-03T01:00:00.000Z';
const PAGE_SIZE = 12;

/** Asset ids are UUIDs; the reference syntax only matches that shape. */
const assetId = (index: number) => `aaaaaaaa-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`;

let assets: ImageAssetInfo[];
let png: Buffer;
let writes: string[];
let submitted: Record<string, unknown>[];
let resolveBodies: Record<string, unknown>[];
let uploads: { name: string; base64: string; mime: string }[];
let resolveResponse: Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#7fa0c0' } })
    .png()
    .toBuffer();
  // More assets than the recent strip (8) and more than one dialog page (12),
  // so both the strip cut and the dialog pagination are exercised.
  assets = Array.from({ length: 26 }, (_, index) => ({
    id: assetId(index),
    name: index === 0 ? 'Reference garden' : `Fixture asset ${String(index).padStart(2, '0')}`,
    mime: 'image/png',
    width: 24,
    height: 24,
    bytes: png.length,
    description: '',
    category: '',
    keywords: index % 2 === 0 ? `tag-${index}` : '',
    agentVisible: false,
    source: 'upload',
    generationId: null,
    outputIndex: null,
    createdAt: NOW,
  }));
  writes = [];
  submitted = [];
  resolveBodies = [];
  uploads = [];
  resolveResponse = { finalPrompt: 'Resolved fixture prompt' };
  await page.route('**/api/image/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== 'GET') {
      writes.push(`${method} ${path}`);
    }
    const replyList = (items: readonly unknown[]) => {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const filtered = items.filter((item) => (q.length === 0 ? true : JSON.stringify(item).toLowerCase().includes(q)));
      return route.fulfill({
        json: { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset },
      });
    };
    if (path === '/api/image/status') {
      await route.fulfill({ json: { enabled: true, models: [{ id: 'fixture-image-model', name: 'Fixture Image' }] } });
      return;
    }
    if (path === '/api/image/prompts') {
      await replyList([
        {
          id: 'prompt-seed',
          name: 'Watercolor style',
          body: 'Paint everything in watercolor.',
          description: '',
          category: 'style',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);
      return;
    }
    if (path === '/api/image/images' && method === 'GET') {
      await replyList(assets);
      return;
    }
    if (path === '/api/image/images' && method === 'POST') {
      const body = request.postDataJSON() as { name: string; base64: string; mime: string };
      uploads.push(body);
      const created: ImageAssetInfo = {
        id: assetId(assets.length),
        name: body.name,
        mime: body.mime,
        width: 24,
        height: 24,
        bytes: Buffer.from(body.base64, 'base64').length,
        description: '',
        category: '',
        keywords: '',
        agentVisible: false,
        source: 'upload',
        generationId: null,
        outputIndex: null,
        createdAt: NOW,
      };
      assets = [created, ...assets];
      await route.fulfill({ status: 201, json: created });
      return;
    }
    if (path.startsWith('/api/image/images/') && path.endsWith('/content')) {
      await route.fulfill({ contentType: 'image/png', body: png });
      return;
    }
    if (path.startsWith('/api/image/images/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/image/images/'.length));
      const found = assets.find((asset) => asset.id === id);
      if (found === undefined) {
        await route.fulfill({ status: 404, json: { error: 'not_found', message: '图片不存在' } });
      } else {
        await route.fulfill({ json: found });
      }
      return;
    }
    if (path === '/api/image/generations/resolve') {
      resolveBodies.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: resolveResponse });
      return;
    }
    if (path === '/api/image/generations') {
      submitted.push(request.postDataJSON() as Record<string, unknown>);
      const generation: ImageGenerationRecord = {
        id: 'generation-fixture',
        status: 'succeeded',
        source: 'admin',
        actorName: 'e2e-admin',
        createdAt: NOW,
        finishedAt: NOW,
        snapshot: {
          authored: {
            authoredPrompt: 'fixture',
            modelId: 'fixture-image-model',
            aspectRatio: 'auto',
            resolution: 'auto',
            outputCount: 1,
          },
          resolvedPrompt: 'fixture resolved',
          finalPrompt: 'fixture resolved',
          promptAssets: [],
          imageAssets: [],
        },
        outputs: [{ id: assetId(0), name: 'Output', mime: 'image/png', width: 24, height: 24 }],
        attempts: [],
        error: null,
      };
      await route.fulfill({ status: 201, json: { generation, replayed: false } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
});

function editor(page: import('@playwright/test').Page) {
  return page.getByRole('textbox', { name: 'Generate Prompt', exact: true });
}

test('the More dialog searches, paginates and inserts at the caret', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/image-generate'));

  // The recent strip shows the first eight assets only.
  await expect(page.getByRole('button', { name: '+ Reference garden' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Fixture asset 07' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Fixture asset 08' })).toHaveCount(0);

  // A caret in the middle of the text: Home puts it at position 0.
  await editor(page).click();
  await page.keyboard.type('AB');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Reference-image library', exact: true })).toBeVisible();
  await expect(dialog.locator('img')).toHaveCount(PAGE_SIZE);
  await expect(dialog.getByText('26 records', { exact: true })).toBeVisible();

  // The search filters the whole library (13 keyword-tagged assets) and its
  // own pagination pages the filtered result.
  await dialog.getByRole('textbox', { name: 'Search name, description, category or keywords' }).fill('tag');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(PAGE_SIZE);
  await expect(dialog.getByText('13 records', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(PAGE_SIZE);

  await page.screenshot({ path: testInfo.outputPath('image-generate-library.png') });
  await testInfo.attach('image-generate-library', {
    path: testInfo.outputPath('image-generate-library.png'),
    contentType: 'image/png',
  });

  // Back to the full library: three pages, the third holding the last asset.
  // The footer ignores clicks while placeholder data is showing, so every
  // navigation waits for its target page first.
  await dialog.getByRole('textbox', { name: 'Search name, description, category or keywords' }).fill('');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(PAGE_SIZE);
  await expect(dialog.getByText('26 records', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(PAGE_SIZE);
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog.locator('img')).toHaveCount(2);

  // Picking inserts the token at the caret (position 0), not at the end.
  await dialog.getByRole('button', { name: 'Fixture asset 25' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await editor(page).textContent()).toBe(`{{image:${assetId(25)}}}AB`);

  // The referenced strip mirrors the text with the model-facing ordinal.
  const strip = page.getByRole('list', { name: 'Referenced images' });
  await expect(strip.getByRole('listitem').filter({ hasText: 'Fixture asset 25' }).getByText('图 1')).toBeVisible();
});

test('picking without a caret appends, the strip mirrors the text, and removal edits it', async ({ page }) => {
  await page.goto(await adminUrl('/image-generate'));
  const stripEntries = () => page.getByRole('list', { name: 'Referenced images' }).getByRole('listitem');

  // Never focused the editor: the insert lands at the end of the empty prompt.
  await page.getByRole('button', { name: '+ Reference garden' }).click();
  expect(await editor(page).textContent()).toBe(`{{image:${assetId(0)}}}`);

  // A second reference keeps first-appearance order in the strip.
  await page.getByRole('button', { name: '+ Fixture asset 01' }).click();
  await expect(
    page
      .getByRole('list', { name: 'Referenced images' })
      .getByRole('listitem')
      .filter({ hasText: 'Fixture asset 01' })
      .getByText('图 2'),
  ).toBeVisible();

  // Removing an entry removes every token of that asset from the text. The
  // editor mirrors the React state, which CodeMirror syncs a beat later, so
  // these assertions poll instead of reading once.
  await page.getByRole('button', { name: 'Remove Reference garden' }).click();
  await expect.poll(async () => await editor(page).textContent()).toBe(`{{image:${assetId(1)}}}`);
  await expect(stripEntries().filter({ hasText: 'Reference garden' })).toHaveCount(0);
  // The remaining entry keeps its slot, renumbered to the first position.
  await expect(stripEntries().filter({ hasText: 'Fixture asset 01' }).getByText('图 1')).toBeVisible();

  // The same asset referenced twice in the text is one strip entry, and its
  // tokens all disappear on removal.
  const manual = `前 {{image:${assetId(1)}}} 中 {{image:${assetId(1)}}} 后`;
  await editor(page).fill(manual);
  await expect(stripEntries().filter({ hasText: 'Fixture asset 01' }).getByText('图 1')).toBeVisible();
  // The same asset referenced twice is still exactly one strip entry.
  await expect(stripEntries()).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove Fixture asset 01' }).click();
  await expect.poll(async () => await editor(page).textContent()).toBe('前  中  后');
});

test('picking and removing a prompt asset is visible and reaches the submitted prompt_refs', async ({ page }) => {
  await page.goto(await adminUrl('/image-generate'));
  await editor(page).fill('A quiet pond');

  // Picking shows the asset as a removable selected tag beside the list.
  await page.getByRole('button', { name: 'Watercolor style', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Selected prompt references', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Watercolor style', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(toast(page, 'Generation submitted').last()).toBeVisible();
  expect(submitted[0]).toMatchObject({ prompt: 'A quiet pond', prompt_refs: ['prompt-seed'] });

  // Removing the tag is immediate and changes what the next submit carries.
  await page.getByRole('button', { name: 'Remove Watercolor style' }).click();
  await expect(page.getByRole('heading', { name: 'Selected prompt references', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  // The first submit's toast may still be fading; the newest one is the proof.
  await expect(toast(page, 'Generation submitted').last()).toBeVisible();
  expect(submitted[1]).toMatchObject({ prompt: 'A quiet pond' });
  expect((submitted[1] as { prompt_refs?: unknown[] }).prompt_refs).toEqual([]);
});

test('submitting sends the prompt tokens and never the legacy input_image_refs field', async ({ page }) => {
  await page.goto(await adminUrl('/image-generate'));
  await editor(page).fill(`画我的自设，三视图用 {{image:${assetId(0)}}}`);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(toast(page, 'Generation submitted')).toBeVisible();

  const body = submitted[0];
  expect(body).toMatchObject({ prompt: `画我的自设，三视图用 {{image:${assetId(0)}}}` });
  expect(Object.hasOwn(body as object, 'input_image_refs')).toBe(false);
  expect(writes.filter((entry) => entry.startsWith('POST'))).toEqual(['POST /api/image/generations']);

  // The resolve preview shows the final text the image model will receive.
  resolveResponse = {
    finalPrompt: '画我的自设，三视图用 图 1',
    resolvedPrompt: '画我的自设，三视图用 图 1',
  };
  await page.getByRole('button', { name: 'Resolve preview', exact: true }).click();
  await expect(page.locator('pre')).toHaveText('画我的自设，三视图用 图 1');
  expect(resolveBodies[0]).toMatchObject({ prompt: `画我的自设，三视图用 {{image:${assetId(0)}}}` });
});

test('a fresh upload inserts its token and the page stacks vertically at every width', async ({ page }, testInfo) => {
  await page.goto(await adminUrl('/image-generate'));

  // The form card and the outputs card stack: the outputs begin below where
  // the form ends, never beside it. The form's bottom is its actions row.
  const actions = page.getByRole('button', { name: 'Resolve preview', exact: true });
  const outputs = page.getByRole('heading', { name: "This run's outputs", exact: true });
  await expect(actions).toBeVisible();
  await expect(outputs).toBeVisible();
  const outputsStartBelowForm = async () => {
    const actionsBox = await actions.boundingBox();
    const formBottom = (actionsBox?.y ?? -1) + (actionsBox?.height ?? 0);
    const outputsTop = (await outputs.boundingBox())?.y ?? -2;
    expect(outputsTop).toBeGreaterThan(formBottom);
  };
  await outputsStartBelowForm();
  await page.setViewportSize({ width: 1440, height: 900 });
  await outputsStartBelowForm();
  await page.screenshot({ path: testInfo.outputPath('image-generate-vertical.png') });
  await testInfo.attach('image-generate-vertical', {
    path: testInfo.outputPath('image-generate-vertical.png'),
    contentType: 'image/png',
  });

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'e2e-reference.png', mimeType: 'image/png', buffer: png });
  await expect(toast(page, 'Uploaded e2e-reference.png')).toBeVisible();
  expect(uploads.map((upload) => upload.name)).toEqual(['e2e-reference.png']);
  expect(await editor(page).textContent()).toBe(`{{image:${assetId(26)}}}`);
  expect(writes).toContain('POST /api/image/images');

  // A narrow viewport never scrolls sideways and keeps the vertical stack.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(outputs).toBeVisible();
  await outputsStartBelowForm();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
