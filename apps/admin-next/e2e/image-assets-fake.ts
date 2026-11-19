import type { Page } from '@playwright/test';
import sharp from 'sharp';
import type { ImageAssetInfo, ImagePromptAsset } from '../src/lib/api/images.ts';

/**
 * The stateful fake image service shared by the image-assets suites: every
 * spec file installs it in `beforeEach`, so each test seeds the same rows and
 * the recorded requests (`writes`, `extractRequests`, `updateRequests`) prove
 * what really left the page. Playwright gives each spec file its own worker,
 * and `installImageAssetsFake` resets all state per test, so no state leaks
 * between files either.
 */

const NOW = '2026-10-03T01:00:00.000Z';

let prompts: ImagePromptAsset[];
let images: ImageAssetInfo[];
let png: Buffer;
let writes: string[];
let uploads: { name: string; base64: string; mime: string }[];
/** Scripted extraction responses, in call order; every spec queues what its fake model proposes. */
let extracts: Array<{ status: number; body: Record<string, unknown> }>;
/** Every extraction request body, in call order (the one-off model included). */
let extractRequests: Record<string, unknown>[];
/** Every asset update body, in call order. */
let updateRequests: Record<string, unknown>[];

export function fakePng(): Buffer {
  return png;
}

export function fakeWrites(): string[] {
  return writes;
}

export function fakeUploads(): { name: string; base64: string; mime: string }[] {
  return uploads;
}

/** Queue the fake model's next extraction reply (or the tool-model refusal). */
export function queueExtract(response: { status: number; body: Record<string, unknown> }): void {
  extracts.push(response);
}

export function fakeExtractRequests(): Record<string, unknown>[] {
  return extractRequests;
}

export function fakeUpdateRequests(): Record<string, unknown>[] {
  return updateRequests;
}

export async function installImageAssetsFake(page: Page): Promise<void> {
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
      keywords: '',
      agentVisible: false,
      source: 'upload',
      generationId: null,
      outputIndex: null,
      createdAt: NOW,
    },
  ];
  writes = [];
  uploads = [];
  extracts = [];
  extractRequests = [];
  updateRequests = [];
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
          keywords: '',
          agentVisible: false,
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
      if (path.endsWith('/extract')) {
        extractRequests.push(request.postDataJSON() as Record<string, unknown>);
        const scripted = extracts.shift() ?? { status: 502, body: { error: 'extraction_failed', message: 'script' } };
        await route.fulfill({ status: scripted.status, json: scripted.body });
        return;
      }
      if (method === 'PUT') {
        const body = request.postDataJSON() as {
          name?: string;
          description?: string;
          category?: string;
          keywords?: string;
          agentVisible?: boolean;
        };
        updateRequests.push(body);
        images = images.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                name: body.name ?? entry.name,
                description: body.description ?? entry.description,
                category: body.category ?? entry.category,
                keywords: body.keywords ?? entry.keywords,
                agentVisible: body.agentVisible ?? entry.agentVisible,
              }
            : entry,
        );
        await route.fulfill({ json: images.find((entry) => entry.id === id) });
      } else if (method === 'DELETE') {
        images = images.filter((entry) => entry.id !== id);
        await route.fulfill({ json: { status: 'archived' } });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}
