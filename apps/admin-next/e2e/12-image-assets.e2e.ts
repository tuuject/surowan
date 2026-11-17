import { expect } from '@playwright/test';
import sharp from 'sharp';
import type { ImageAssetInfo, ImagePromptAsset } from '../src/lib/api/images.ts';
import { adminUrl, test, toast } from './helpers.ts';

test.use({ signedIn: true });

/**
 * The asset manager against a stateful fake image service: both tabs list the
 * seeded rows and every row action issues the write the API client promises.
 * The recorded `writes` prove the create/rename/archive calls really leave the
 * page instead of only updating local state.
 */

const NOW = '2026-10-03T01:00:00.000Z';

let prompts: ImagePromptAsset[];
let images: ImageAssetInfo[];
let png: Buffer;
let writes: string[];
let uploads: { name: string; base64: string; mime: string }[];

test.beforeEach(async ({ page }) => {
  png = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#88aacc' } })
    .png()
    .toBuffer();
  prompts = [
    {
      id: 'prompt-seed',
      name: 'Watercolor style',
      body: 'Paint everything in watercolor.',
      description: '',
      category: 'style',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  images = [
    {
      id: 'image-seed',
      name: 'Reference garden',
      mime: 'image/png',
      width: 32,
      height: 16,
      bytes: png.length,
      description: '',
      category: '',
      source: 'upload',
      generationId: null,
      outputIndex: null,
      createdAt: NOW,
    },
  ];
  writes = [];
  uploads = [];
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
      return route.fulfill({
        json: { items: items.slice(offset, offset + limit), total: items.length, limit, offset },
      });
    };
    if (path === '/api/image/status') {
      await route.fulfill({ json: { enabled: true, models: [] } });
      return;
    }
    if (path === '/api/image/prompts') {
      if (method === 'GET') {
        await replyList(prompts);
      } else if (method === 'POST') {
        const body = request.postDataJSON() as { name: string; body: string };
        const created: ImagePromptAsset = {
          id: `prompt-created-${prompts.length}`,
          name: body.name,
          body: body.body,
          description: '',
          category: '',
          createdAt: NOW,
          updatedAt: NOW,
        };
        prompts = [created, ...prompts];
        await route.fulfill({ status: 201, json: created });
      }
      return;
    }
    if (path.startsWith('/api/image/prompts/')) {
      const id = decodeURIComponent(path.slice('/api/image/prompts/'.length));
      if (method === 'PUT') {
        const body = request.postDataJSON() as { name?: string };
        prompts = prompts.map((entry) =>
          entry.id === id ? { ...entry, name: body.name ?? entry.name, updatedAt: NOW } : entry,
        );
        await route.fulfill({ json: prompts.find((entry) => entry.id === id) });
      } else if (method === 'DELETE') {
        prompts = prompts.filter((entry) => entry.id !== id);
        await route.fulfill({ json: { status: 'archived' } });
      }
      return;
    }
    if (path === '/api/image/images') {
      if (method === 'GET') {
        await replyList(images);
      } else if (method === 'POST') {
        const body = request.postDataJSON() as { name: string; base64: string; mime: string };
        uploads.push(body);
        const created: ImageAssetInfo = {
          id: `image-created-${images.length}`,
          name: body.name,
          mime: body.mime,
          width: 32,
          height: 16,
          bytes: Buffer.from(body.base64, 'base64').length,
          description: '',
          category: '',
          source: 'upload',
          generationId: null,
          outputIndex: null,
          createdAt: NOW,
        };
        images = [created, ...images];
        await route.fulfill({ status: 201, json: created });
      }
      return;
    }
    if (path.startsWith('/api/image/images/')) {
      if (path.endsWith('/content')) {
        await route.fulfill({ contentType: 'image/png', body: png });
        return;
      }
      const id = decodeURIComponent(path.slice('/api/image/images/'.length));
      if (method === 'PUT') {
        const body = request.postDataJSON() as { name?: string };
        images = images.map((entry) => (entry.id === id ? { ...entry, name: body.name ?? entry.name } : entry));
        await route.fulfill({ json: images.find((entry) => entry.id === id) });
      } else if (method === 'DELETE') {
        images = images.filter((entry) => entry.id !== id);
        await route.fulfill({ json: { status: 'archived' } });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
});

test('both tabs render the seeded prompt assets and reference images', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByRole('heading', { name: 'Image assets', exact: true })).toBeVisible();
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();
  await expect(
    page.locator('table tbody tr', { hasText: 'Watercolor style' }).getByRole('cell', { name: 'style', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Images', exact: true }).click();
  const preview = page.getByRole('img', { name: 'Reference garden', exact: true });
  await expect(preview).toHaveAttribute('src', '/api/image/images/image-seed/content');
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32);
  await expect(page.locator('table tbody tr', { hasText: 'Reference garden' }).getByText('upload')).toBeVisible();
});

test('a prompt asset is created, renamed and archived through real writes', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New asset', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Asset name', exact: true }).fill('E2E style');
  await dialog.getByRole('textbox', { name: 'Asset body (no {{ nesting)', exact: true }).fill('Neon nights.');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toast(page, 'Asset created')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const createdRow = page.locator('table tbody tr', { hasText: 'E2E style' });
  await expect(createdRow).toBeVisible();

  await createdRow.getByRole('button', { name: 'Rename', exact: true }).click();
  const renameDialog = page.getByRole('dialog');
  await expect(renameDialog.getByRole('heading', { name: 'Rename E2E style', exact: true })).toBeVisible();
  const nameField = renameDialog.getByRole('textbox', { name: 'Asset name', exact: true });
  await expect(nameField).toHaveValue('E2E style');
  await nameField.fill('E2E renamed');
  await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(toast(page, 'Renamed')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const renamedRow = page.locator('table tbody tr', { hasText: 'E2E renamed' });
  await expect(renamedRow).toBeVisible();
  await expect(page.locator('table tbody tr', { hasText: 'E2E style' })).toHaveCount(0);

  await renamedRow.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('heading', { name: 'Archive E2E renamed', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(toast(page, 'Archived')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('table tbody tr', { hasText: 'E2E renamed' })).toHaveCount(0);
  await expect(page.getByText('Watercolor style', { exact: true })).toBeVisible();
  expect(writes).toEqual([
    'POST /api/image/prompts',
    'PUT /api/image/prompts/prompt-created-1',
    'DELETE /api/image/prompts/prompt-created-1',
  ]);
});

test('a reference image uploads, renames and archives through real writes', async ({ page }) => {
  await page.goto(await adminUrl('/image-assets'));
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(page.getByText('Reference garden', { exact: true })).toBeVisible();

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'e2e-upload.png', mimeType: 'image/png', buffer: png });
  await expect(toast(page, 'Uploaded')).toBeVisible();
  // The fake accepts anything, so the bytes that left the page are checked
  // here: the real service decodes and validates them.
  expect(uploads.map((upload) => ({ name: upload.name, mime: upload.mime }))).toEqual([
    { name: 'e2e-upload.png', mime: 'image/png' },
  ]);
  expect(Buffer.from(uploads[0]?.base64 ?? '', 'base64').equals(png)).toBe(true);
  const uploadedRow = page.locator('table tbody tr', { hasText: 'e2e-upload.png' });
  await expect(uploadedRow).toBeVisible();

  await uploadedRow.getByRole('button', { name: 'Rename', exact: true }).click();
  const renameDialog = page.getByRole('dialog');
  await expect(renameDialog.getByRole('heading', { name: 'Rename e2e-upload.png', exact: true })).toBeVisible();
  const nameField = renameDialog.getByRole('textbox', { name: 'Asset name', exact: true });
  await expect(nameField).toHaveValue('e2e-upload.png');
  await nameField.fill('Renamed reference');
  await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(toast(page, 'Renamed')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const renamedRow = page.locator('table tbody tr', { hasText: 'Renamed reference' });
  await expect(renamedRow).toBeVisible();

  await renamedRow.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('heading', { name: 'Archive Renamed reference', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(toast(page, 'Archived')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('table tbody tr', { hasText: 'Renamed reference' })).toHaveCount(0);
  await expect(page.getByText('Reference garden', { exact: true })).toBeVisible();
  expect(writes).toEqual([
    'POST /api/image/images',
    'PUT /api/image/images/image-created-1',
    'DELETE /api/image/images/image-created-1',
  ]);
});

test('a disabled image service shows the settings gate instead of the tables', async ({ page }) => {
  await page.route('**/api/image/status', (route) => route.fulfill({ json: { enabled: false, models: [] } }));
  await page.goto(await adminUrl('/image-assets'));
  await expect(page.getByRole('heading', { name: 'Image assets', exact: true })).toBeVisible();
  const gate = page.getByRole('status');
  await expect(gate).toContainText('Image generation is currently disabled');
  await expect(gate.getByRole('link', { name: 'Image settings', exact: true })).toHaveAttribute(
    'href',
    '/image-settings',
  );
  await expect(page.locator('table')).toHaveCount(0);
});
