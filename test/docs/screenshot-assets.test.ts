import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, test } from 'vitest';
import { DOCS_SCENARIOS } from '../../apps/admin-next/docs-screenshots/scenarios.ts';
import {
  checkScreenshotAssets,
  MANIFEST_MAX_BYTES,
  SCREENSHOTS_DIRECTORY,
} from '../../scripts/docs/screenshot-assets.ts';

/**
 * The docs screenshot checker against the real committed assets and against
 * synthetic failure fixtures.
 *
 * The fixtures write a genuinely decodable 2×2 PNG (`sharp`), because the
 * checker now decodes pixels: a right-sized header with a truncated body is a
 * broken asset, not a PNG. Nothing here reads the public directory except the
 * one test that guards the committed set.
 */

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const PNG_BYTES = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
  .png()
  .toBuffer();

interface FixtureScenario {
  readonly id: string;
  readonly description?: string;
  readonly target?: string;
  readonly locales?: readonly string[];
  readonly pages?: readonly string[];
}

function manifestOf(
  scenarios: readonly FixtureScenario[],
  generator: Record<string, unknown> = {
    commit: '86db554f6a64',
    playwright: '1.64.0',
    chromium: '156.0.8078.4',
    platform: 'linux-x64',
    viewport: { width: 1440, height: 1000 },
    device_scale_factor: 1,
    worktree_dirty: false,
  },
): string {
  return JSON.stringify(
    {
      version: 1,
      generator,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        description: scenario.description ?? 'A documented panel state.',
        target: scenario.target ?? 'The panel shows that state.',
        locales: scenario.locales ?? ['zh-CN', 'en'],
        pages: scenario.pages ?? ['guides/admin'],
      })),
    },
    null,
    2,
  );
}

interface ExtraFile {
  readonly path: string;
  readonly bytes?: Buffer;
}

/**
 * Creates a fixture directory: the manifest text, the expected files and any
 * extra files that are not in the manifest.
 */
async function fixture(options: {
  readonly manifest: string;
  readonly files?: readonly string[];
  readonly bytes?: Buffer;
  readonly extra?: readonly ExtraFile[];
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'surowan-screenshot-assets-'));
  directories.push(directory);
  await writeFile(join(directory, 'manifest.json'), options.manifest, 'utf8');
  const write = async (file: string, bytes: Buffer): Promise<void> => {
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  for (const file of options.files ?? []) {
    await write(file, options.bytes ?? PNG_BYTES);
  }
  for (const file of options.extra ?? []) {
    await write(file.path, file.bytes ?? PNG_BYTES);
  }
  return directory;
}

function both(id: string): string[] {
  return [`${id}.zh-CN.light.png`, `${id}.en.light.png`];
}

describe('the committed docs screenshots', () => {
  test('manifest and files are complete, paired and real PNGs', async () => {
    const report = await checkScreenshotAssets();
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.scenarioCount).toBeGreaterThanOrEqual(15);
    expect(report.fileCount).toBe(report.scenarioCount * 2);
    // A guard against a future run writing into the wrong tree.
    expect(SCREENSHOTS_DIRECTORY.endsWith(join('apps', 'docs', 'content', 'public', 'screenshots'))).toBe(true);
  });

  test('the committed manifest lists exactly the scenario catalog', async () => {
    // The checker validates the manifest against itself, so deleting a scenario
    // from both the manifest and the disk would still pass. The catalog is the
    // contract the docs placeholders and epic B2 rely on.
    const report = await checkScreenshotAssets({
      expectedIds: DOCS_SCENARIOS.map((scenario) => scenario.id),
    });
    expect(report.errors).toEqual([]);
    expect(report.scenarioCount).toBe(DOCS_SCENARIOS.length);
  });
});

describe('the checker', () => {
  test('accepts a complete fixture', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/navigation' }]),
      files: both('admin/navigation'),
    });
    await expect(checkScreenshotAssets({ directory })).resolves.toMatchObject({
      ok: true,
      errors: [],
      scenarioCount: 1,
      fileCount: 2,
    });
  });

  test('reports a missing locale', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/keychain' }]),
      files: ['admin/keychain.zh-CN.light.png'],
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['Missing screenshot: admin/keychain.en.light.png']);
  });

  test('reports a PNG no scenario names', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/api-keys' }]),
      files: both('admin/api-keys'),
      extra: [{ path: 'admin/api-keys.zh-CN.dark.png' }],
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['Unlisted file in the screenshots directory: admin/api-keys.zh-CN.dark.png']);
  });

  test('reports any other file that is not a manifest or an expected PNG', async () => {
    // A case variant of an expected name is the same file on Windows, so the
    // stray names here are distinct on every platform.
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/navigation' }]),
      files: both('admin/navigation'),
      extra: [
        { path: 'notes.tmp', bytes: Buffer.from('scratch') },
        { path: 'admin/navigation.en.light.jpeg' },
        { path: 'admin/extra.png' },
      ],
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'Unlisted file in the screenshots directory: admin/extra.png',
      'Unlisted file in the screenshots directory: admin/navigation.en.light.jpeg',
      'Unlisted file in the screenshots directory: notes.tmp',
    ]);
  });

  test('rejects a scenario id that is not <topic>/<state>', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'Admin Navigation' }]),
      files: [],
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/manifest\.json at \/scenarios\/0\/id/);
  });

  test('rejects a file whose bytes cannot be decoded as a PNG', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'models/model-roles' }]),
      files: both('models/model-roles'),
      bytes: Buffer.from('<html>not an image</html>'),
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'Not a decodable PNG: models/model-roles.en.light.png',
      'Not a decodable PNG: models/model-roles.zh-CN.light.png',
    ]);
  });

  test('rejects a truncated PNG whose header is intact', async () => {
    const truncated = PNG_BYTES.subarray(0, 32);
    const directory = await fixture({
      manifest: manifestOf([{ id: 'models/model-roles' }]),
      files: both('models/model-roles'),
      bytes: truncated,
    });
    expect(truncated.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'Not a decodable PNG: models/model-roles.en.light.png',
      'Not a decodable PNG: models/model-roles.zh-CN.light.png',
    ]);
  });

  test('rejects a duplicate scenario id and a wrong locale set', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/passkeys' }, { id: 'admin/passkeys', locales: ['en', 'en'] }]),
      files: both('admin/passkeys'),
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'Duplicate scenario id: admin/passkeys',
        'admin/passkeys: locales must be exactly zh-CN + en',
      ]),
    );
  });

  test('rejects a manifest that is too large to review', async () => {
    const filler = 'x'.repeat(MANIFEST_MAX_BYTES);
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/navigation', description: filler }]),
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors.join('\n')).toMatch(/manifest\.json is \d+ bytes; keep it under 20000/);
  });

  test('reports a missing manifest instead of throwing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'surowan-screenshot-assets-'));
    directories.push(directory);
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/Missing manifest/);
  });

  test('reports invalid JSON instead of throwing', async () => {
    const directory = await fixture({ manifest: '{ "version": 1,' });
    const report = await checkScreenshotAssets({ directory });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/not valid JSON/);
  });

  test('reports a scenario the catalog requires but the manifest omits', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/navigation' }]),
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotAssets({
      directory,
      expectedIds: ['admin/navigation', 'admin/keychain'],
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['Manifest is missing scenario: admin/keychain']);
  });

  test('reports a manifest scenario the catalog does not know', async () => {
    const directory = await fixture({
      manifest: manifestOf([{ id: 'admin/navigation' }, { id: 'admin/ghost' }]),
      files: [...both('admin/navigation'), ...both('admin/ghost')],
    });
    const report = await checkScreenshotAssets({ directory, expectedIds: ['admin/navigation'] });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(['Manifest lists a scenario outside the catalog: admin/ghost']);
  });
});
