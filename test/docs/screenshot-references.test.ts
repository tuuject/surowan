import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { DOCS_SCENARIOS } from '../../apps/admin-next/docs-screenshots/scenarios.ts';
import { SCREENSHOT_LOCALES } from '../../scripts/docs/screenshot-assets.ts';
import { checkScreenshotReferences, PAGE_LOCALES } from '../../scripts/docs/screenshot-references.ts';

/**
 * The page side of the screenshot contract: every image is the locale of the
 * page that embeds it, names a real scenario and file, and every scenario is
 * used by both locales. The fixtures write their own manifest so a rule can be
 * proven broken; the last test stands on the committed tree.
 */

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

interface FixtureOptions {
  /** Page source, keyed by `<locale>/<path>` relative to the content root. */
  readonly pages: Readonly<Record<string, string>>;
  /** Manifest scenario ids. */
  readonly scenarios?: readonly string[];
  /** Screenshot files to create, relative to the screenshots directory. */
  readonly files?: readonly string[];
  /** Omit the manifest entirely. */
  readonly noManifest?: boolean;
}

async function fixture(options: FixtureOptions): Promise<{ contentRoot: string; screenshotsDirectory: string }> {
  const contentRoot = await mkdtemp(join(tmpdir(), 'surowan-screenshot-pages-'));
  directories.push(contentRoot);
  const screenshotsDirectory = join(contentRoot, 'public', 'screenshots');
  await mkdir(screenshotsDirectory, { recursive: true });
  for (const [path, text] of Object.entries(options.pages)) {
    const target = join(contentRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  if (options.noManifest !== true) {
    const scenarios = options.scenarios ?? ['admin/navigation'];
    await writeFile(
      join(screenshotsDirectory, 'manifest.json'),
      JSON.stringify({ version: 1, generator: {}, scenarios: scenarios.map((id) => ({ id })) }),
      'utf8',
    );
  }
  for (const file of options.files ?? []) {
    const target = join(screenshotsDirectory, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'png');
  }
  return { contentRoot, screenshotsDirectory };
}

const both = (id: string): string[] => [`${id}.zh-CN.light.png`, `${id}.en.light.png`];
const image = (alt: string, file: string): string => `![${alt}](__DOCS_BASE__/screenshots/${file})`;

/** A page pair that both embed `admin/navigation` correctly. */
function healthyPages(): Record<string, string> {
  return {
    'zh/docs/guide.md': `# 指南\n\n${image('概览页', 'admin/navigation.zh-CN.light.png')}\n`,
    'en/docs/guide.md': `# Guide\n\n${image('The overview page', 'admin/navigation.en.light.png')}\n`,
  };
}

describe('the committed pages', () => {
  test('embed the screenshot their locale owns and cover every scenario', async () => {
    const report = await checkScreenshotReferences();
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.referenceCount).toBeGreaterThanOrEqual(2 * DOCS_SCENARIOS.length);
    // Each locale uses the whole catalog: no captured pair is dead weight and
    // neither tree lost an image during a refactor.
    expect(report.referenced['zh-CN']).toEqual(DOCS_SCENARIOS.map((scenario) => scenario.id).sort());
    expect(report.referenced.en).toEqual(DOCS_SCENARIOS.map((scenario) => scenario.id).sort());
  });

  test('the page locales are exactly the captured locales', () => {
    expect(PAGE_LOCALES.map((page) => page.locale)).toEqual([...SCREENSHOT_LOCALES]);
    expect(PAGE_LOCALES.map((page) => page.directory)).toEqual(['zh', 'en']);
  });
});

describe('the reference check', () => {
  test('accepts a healthy page pair', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: healthyPages(),
      files: both('admin/navigation'),
    });
    await expect(checkScreenshotReferences({ contentRoot, screenshotsDirectory })).resolves.toMatchObject({
      ok: true,
      errors: [],
      pageCount: 2,
      referenceCount: 2,
    });
  });

  test('rejects a Chinese page embedding the English pixels and the reverse', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': image('概览页', 'admin/navigation.en.light.png'),
        'en/docs/guide.md': image('The overview page', 'admin/navigation.zh-CN.light.png'),
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      'zh/docs/guide.md:1: zh pages must embed *.zh-CN.light.png, not the en file',
      'en/docs/guide.md:1: en pages must embed *.en.light.png, not the zh-CN file',
    ]);
  });

  test('rejects an image whose scenario is not in the manifest', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `${image('概览页', 'admin/navigation.zh-CN.light.png')}
${image('幽灵截图', 'admin/ghost.zh-CN.light.png')}
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: [...both('admin/navigation'), ...both('admin/ghost')],
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual(['zh/docs/guide.md:2: screenshot is not a manifest scenario: admin/ghost']);
  });

  test('rejects a manifest scenario on disk but on no Chinese page', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: healthyPages(),
      scenarios: ['admin/navigation', 'admin/keychain'],
      files: [...both('admin/navigation'), ...both('admin/keychain')],
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'Screenshot is on no zh page: admin/keychain (add it to a page or drop the scenario)',
      'Screenshot is on no en page: admin/keychain (add it to a page or drop the scenario)',
    ]);
  });

  test('rejects a reference whose file is missing', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: healthyPages(),
      files: ['admin/navigation.zh-CN.light.png'],
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual(['en/docs/guide.md:3: missing screenshot file: admin/navigation.en.light.png']);
  });

  test('rejects a leftover placeholder and an unstyled destination', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `${image('概览页', 'admin/navigation.zh-CN.light.png')}\n\n<!-- screenshot: admin/navigation | 概览页 -->\n`,
        'en/docs/guide.md': `${image('The overview page', 'admin/navigation.en.light.png')}\n\n![The overview](../../screenshots/admin/navigation.en.light.png)\n`,
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'Screenshot placeholder left in zh/docs/guide.md:3',
      'en/docs/guide.md:3: screenshot must be referenced through __DOCS_BASE__/screenshots/: ../../screenshots/admin/navigation.en.light.png',
    ]);
  });

  test('rejects an empty alt text, which the offline manual needs as the caption', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `![](__DOCS_BASE__/screenshots/admin/navigation.zh-CN.light.png)\n`,
        'en/docs/guide.md': `${image('The overview page', 'admin/navigation.en.light.png')}\n`,
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'zh/docs/guide.md:1: screenshot needs an alt text; the offline manual prints it as the caption: admin/navigation',
    ]);
  });

  test('rejects a file name that does not follow the id and locale pattern', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `${image('概览页', 'admin/navigation.zh-CN.light.png')}
${image('概览页', 'admin/navigation.zh-CN.png')}
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: [...both('admin/navigation'), 'admin/navigation.zh-CN.png'],
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'zh/docs/guide.md:2: screenshot file name is not <topic>/<state>.<locale>.light.png: admin/navigation.zh-CN.png',
    ]);
  });

  test('reads a titled image whose locale is wrong', async () => {
    // The title and the empty alt must not hide the crossed pair: this is the
    // shape a hand-written page is most likely to use.
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `![](<__DOCS_BASE__/screenshots/admin/navigation.en.light.png> "Overview")
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'zh/docs/guide.md:1: zh pages must embed *.zh-CN.light.png, not the en file',
      'zh/docs/guide.md:1: screenshot needs an alt text; the offline manual prints it as the caption: admin/navigation',
    ]);
  });

  test('counts a reference-style image through its definition', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `![概览页][nav]

[nav]: __DOCS_BASE__/screenshots/admin/navigation.zh-CN.light.png
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([]);
    expect(report.referenced['zh-CN']).toEqual(['admin/navigation']);
  });

  test('rejects an image the page renders as raw HTML', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `${image('概览页', 'admin/navigation.zh-CN.light.png')}

<img src="__DOCS_BASE__/screenshots/admin/navigation.zh-CN.light.png" alt="重复的图">
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'zh/docs/guide.md:3: write the screenshot as Markdown, not raw <img>: <img src="__DOCS_BASE__/screenshots/admin/navigation.zh-CN.light.png" alt="重复的图">',
    ]);
  });

  test('does not count an image that only appears inside a code sample', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': `
\`\`\`md
${image('概览页', 'admin/navigation.zh-CN.light.png')}
\`\`\`
`,
        'en/docs/guide.md': image('The overview page', 'admin/navigation.en.light.png'),
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([
      'Screenshot is on no zh page: admin/navigation (add it to a page or drop the scenario)',
    ]);
    expect(report.referenced['zh-CN']).toEqual([]);
  });

  test('scans an .mdx page like a Markdown one', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({
      pages: {
        'zh/docs/guide.md': image('概览页', 'admin/navigation.zh-CN.light.png'),
        'en/docs/guide.mdx': `${image('The overview page', 'admin/navigation.en.light.png')}

<Callout>Room only.</Callout>
`,
      },
      files: both('admin/navigation'),
    });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.errors).toEqual([]);
    expect(report.pageCount).toBe(2);
    expect(report.referenced.en).toEqual(['admin/navigation']);
  });

  test('reports a missing manifest instead of throwing', async () => {
    const { contentRoot, screenshotsDirectory } = await fixture({ pages: healthyPages(), noManifest: true });
    const report = await checkScreenshotReferences({ contentRoot, screenshotsDirectory });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/Cannot read the screenshot manifest/);
  });
});
