import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { docsLocales } from '../../scripts/docs/locales.ts';
import {
  type DocsSidebarEntry,
  type DocsSidebarGroup,
  loadLocaleNavigation,
  readMetaEntries,
} from '../../scripts/docs/navigation.ts';
import { docsRoot, repositoryRoot } from '../../scripts/docs/prepare.ts';
import { packManual } from '../../scripts/manual-prepare.ts';
import { DOC_INDEX_PATH } from '../../src/platform/doc-spaces.ts';

const contentRoot = resolve(docsRoot, 'content');
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function tempRoot(prefix = 'surowan-docs-nav-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

function isSidebarGroup(entry: DocsSidebarEntry): entry is DocsSidebarGroup {
  return 'items' in entry;
}

function collectLinks(entries: readonly DocsSidebarEntry[]): string[] {
  const links: string[] = [];
  for (const entry of entries) {
    if (isSidebarGroup(entry)) {
      if (entry.link !== undefined) {
        links.push(entry.link);
      }
      links.push(...collectLinks(entry.items));
    } else {
      links.push(entry.link);
    }
  }
  return links;
}

function collectLabels(entries: readonly DocsSidebarEntry[]): string[] {
  const labels: string[] = [];
  for (const entry of entries) {
    labels.push(entry.text);
    if (isSidebarGroup(entry)) {
      labels.push(...collectLabels(entry.items));
    }
  }
  return labels;
}

test('top navigation splits docs into three sections in both locales', () => {
  const zh = loadLocaleNavigation(contentRoot, 'zh');
  const en = loadLocaleNavigation(contentRoot, 'en');

  expect(zh.nav.map((item) => item.text)).toEqual(['用户手册', '配置参考', '开发者参考', 'GitHub']);
  expect(en.nav.map((item) => item.text)).toEqual(['User manual', 'Configuration', 'Developer', 'GitHub']);

  expect(zh.nav.slice(0, 3).map((item) => [item.link, item.activeMatch])).toEqual([
    ['/docs/guides/', '/docs/guides/'],
    ['/docs/configuration/', '/docs/configuration/'],
    ['/docs/developer/', '/docs/developer/'],
  ]);
  expect(en.nav.slice(0, 3).map((item) => [item.link, item.activeMatch])).toEqual([
    ['/en/docs/guides/', '/docs/guides/'],
    ['/en/docs/configuration/', '/docs/configuration/'],
    ['/en/docs/developer/', '/docs/developer/'],
  ]);
});

test('each top-level section gets its own scoped sidebar without cross-section leakage', () => {
  const zh = loadLocaleNavigation(contentRoot, 'zh');
  const en = loadLocaleNavigation(contentRoot, 'en');

  expect(Object.keys(zh.sidebar).sort()).toEqual(['/docs', '/docs/configuration', '/docs/developer', '/docs/guides']);
  expect(Object.keys(en.sidebar).sort()).toEqual([
    '/en/docs',
    '/en/docs/configuration',
    '/en/docs/developer',
    '/en/docs/guides',
  ]);

  // Every section sidebar links exclusively within its own route prefix.
  for (const [lang, nav] of [
    ['zh', zh],
    ['en', en],
  ] as const) {
    const prefix = lang === 'en' ? '/en' : '';
    for (const section of ['guides', 'configuration', 'developer'] as const) {
      const key = `${prefix}/docs/${section}`;
      const entries = nav.sidebar[key] ?? [];
      const links = collectLinks(entries);
      expect(links.length, `${lang}:${section}`).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.startsWith(`${key}/`), `${lang}:${section} leaked link ${link}`).toBe(true);
      }
      // Every sidebar label is non-empty.
      for (const label of collectLabels(entries)) {
        expect(label.trim().length, `${lang}:${section}`).toBeGreaterThan(0);
      }
    }
    // The `/docs` landing page links to itself and the three section roots.
    const overview = nav.sidebar[`${prefix}/docs`] ?? [];
    expect(collectLinks(overview)).toEqual([
      `${prefix}/docs/`,
      `${prefix}/docs/guides/`,
      `${prefix}/docs/configuration/`,
      `${prefix}/docs/developer/`,
    ]);
  }
});

test('zh and en sidebars mirror the same route tree and carry concise labels', () => {
  const zh = loadLocaleNavigation(contentRoot, 'zh');
  const en = loadLocaleNavigation(contentRoot, 'en');

  for (const section of ['guides', 'configuration', 'developer'] as const) {
    const zhLinks = collectLinks(zh.sidebar[`/docs/${section}`] ?? []);
    const enLinks = collectLinks(en.sidebar[`/en/docs/${section}`] ?? []).map((link) => link.replace(/^\/en/, ''));
    expect(zhLinks, section).toEqual(enLinks);
    // No duplicate links within a section.
    expect(new Set(zhLinks).size, section).toBe(zhLinks.length);
  }

  // Spot-check the requested concise Chinese guide labels.
  const zhGuides = new Map(
    (zh.sidebar['/docs/guides'] ?? [])
      .filter((entry): entry is Exclude<DocsSidebarEntry, DocsSidebarGroup> => !isSidebarGroup(entry))
      .map((entry) => [entry.link, entry.text]),
  );
  expect(zhGuides.get('/docs/guides/')).toBe('开始');
  expect(zhGuides.get('/docs/guides/installation')).toBe('安装');
  expect(zhGuides.get('/docs/guides/first-persona')).toBe('你的第一个人设');
  expect(zhGuides.get('/docs/guides/first-bot')).toBe('你的第一只 Bot');
  expect(zhGuides.get('/docs/guides/models')).toBe('配置模型');
  expect(zhGuides.get('/docs/guides/knowledge')).toBe('记忆与辞典');
  expect(zhGuides.get('/docs/guides/maintenance')).toBe('升级与备份');
  expect(zhGuides.get('/docs/guides/mcp')).toBe('使用 MCP');
  expect(zhGuides.get('/docs/guides/vision')).toBe('图片识别');
  for (const entries of Object.values(zh.sidebar)) {
    for (const label of collectLabels(entries)) {
      expect(label, `Chinese sidebar label should avoid ideographic comma: ${label}`).not.toContain('、');
    }
  }

  // Navigation payloads must never embed build-machine paths.
  for (const lang of docsLocales) {
    const serialized = JSON.stringify(loadLocaleNavigation(contentRoot, lang));
    expect(serialized).not.toContain(repositoryRoot);
  }
});

test('file entry labels override frontmatter titles while plain strings fall back to frontmatter', async () => {
  const root = await tempRoot();
  const docs = join(root, 'zh', 'docs');
  const guides = join(docs, 'guides');
  await mkdir(guides, { recursive: true });
  await writeFile(
    join(root, 'zh', '_nav.json'),
    JSON.stringify([{ text: '用户手册', link: '/docs/guides/', activeMatch: '/docs/guides/' }]),
  );
  await writeFile(
    join(docs, '_meta.json'),
    JSON.stringify(['index', { type: 'dir', name: 'guides', label: '用户手册', collapsible: false }]),
  );
  await writeFile(join(docs, 'index.md'), '---\ntitle: 使用文档\ndescription: Docs\n---\n\n# 使用文档\n');
  await writeFile(
    join(guides, '_meta.json'),
    JSON.stringify([{ type: 'file', name: 'index', label: '开始' }, 'plain']),
  );
  await writeFile(join(guides, 'index.md'), '---\ntitle: 从这里开始\ndescription: Start\n---\n\n# 从这里开始\n');
  await writeFile(join(guides, 'plain.md'), '---\ntitle: 完整标题\ndescription: Plain\n---\n\n# 完整标题\n');

  const nav = loadLocaleNavigation(root, 'zh');
  expect(nav.sidebar['/docs/guides']).toEqual([
    { text: '开始', link: '/docs/guides/' },
    { text: '完整标题', link: '/docs/guides/plain' },
  ]);
});

test('malformed _meta.json entries and missing pages fail fast', async () => {
  const badSegment = await tempRoot();
  await writeFile(join(badSegment, '_meta.json'), JSON.stringify([{ type: 'file', name: 'a/b', label: 'Bad' }]));
  expect(() => readMetaEntries(badSegment)).toThrow('must name a single child segment');

  const emptyLabel = await tempRoot();
  await writeFile(join(emptyLabel, '_meta.json'), JSON.stringify([{ type: 'file', name: 'guide', label: '' }]));
  expect(() => readMetaEntries(emptyLabel)).toThrow('unsupported entry');

  const badType = await tempRoot();
  await writeFile(join(badType, '_meta.json'), JSON.stringify([{ type: 'custom-link', label: 'X', link: '/' }]));
  expect(() => readMetaEntries(badType)).toThrow('unsupported entry');

  const missingFile = await tempRoot();
  await mkdir(join(missingFile, 'zh', 'docs', 'guides'), { recursive: true });
  await writeFile(join(missingFile, 'zh', '_nav.json'), JSON.stringify([]));
  await writeFile(
    join(missingFile, 'zh', 'docs', '_meta.json'),
    JSON.stringify([{ type: 'dir', name: 'guides', label: 'Guides' }]),
  );
  await writeFile(join(missingFile, 'zh', 'docs', 'guides', '_meta.json'), JSON.stringify(['ghost']));
  expect(() => loadLocaleNavigation(missingFile, 'zh')).toThrow('Missing documentation page');
});

test('manual pack accepts file navigation entries with labels and keeps frontmatter titles', async () => {
  const fixtureRoot = await tempRoot('surowan-manual-content-');
  await writeFile(
    join(fixtureRoot, '_meta.json'),
    JSON.stringify(['index', { type: 'dir', name: 'guides', label: 'User manual' }]),
  );
  await writeFile(join(fixtureRoot, 'index.md'), '---\ntitle: Docs\ndescription: Docs\n---\n\n# Docs\n');
  await mkdir(join(fixtureRoot, 'guides'), { recursive: true });
  await writeFile(
    join(fixtureRoot, 'guides', '_meta.json'),
    JSON.stringify([{ type: 'file', name: 'installation', label: 'Install' }]),
  );
  await writeFile(
    join(fixtureRoot, 'guides', 'installation.md'),
    '---\ntitle: Install and sign in\ndescription: Full install steps\n---\n\n# Install and sign in\n',
  );
  const outDir = await tempRoot('surowan-manual-out-');
  const packed = await packManual({ outDir, contentRoot: fixtureRoot });
  expect(packed.documents).toContain('guides/installation.md');
  const index = await readFile(join(outDir, DOC_INDEX_PATH), 'utf8');
  expect(index).toContain('## User manual');
  expect(index).toContain('- [Install and sign in](guides/installation.md): Full install steps');

  const badFile = await tempRoot('surowan-manual-bad-');
  await writeFile(join(badFile, '_meta.json'), JSON.stringify([{ type: 'file', name: 'a/b', label: 'Bad' }]));
  await expect(packManual({ outDir: await tempRoot('surowan-manual-out-'), contentRoot: badFile })).rejects.toThrow(
    'must name a single child segment',
  );
});
