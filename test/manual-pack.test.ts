import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { renderConfigFields } from '../scripts/docs-prepare.ts';
import { manualContentRoot, packManual } from '../scripts/manual-prepare.ts';
import { bundledManualSpace, FileSystemDocSpaces } from '../src/adapters/local-monolith/doc-spaces.ts';
import { DOC_INDEX_PATH } from '../src/platform/doc-spaces.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function tempRoot(prefix = 'plasticwan-manual-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

test('packs the published manual into the runtime resource layout', async () => {
  const outDir = await tempRoot();
  const result = await packManual({ outDir });
  const sources = (await markdownFiles(manualContentRoot)).filter((path) => path !== 'index.md');
  const expected = [...new Set([...sources, 'reference/fields.md'])].sort();
  expect([...result.documents].sort()).toEqual(expected);

  const packed = await markdownFiles(outDir);
  expect(packed).toEqual([...expected, DOC_INDEX_PATH].sort());
  for (const path of expected) {
    const text = await readFile(join(outDir, path), 'utf8');
    expect(text.length, path).toBeGreaterThan(0);
    if (path === 'reference/fields.md') {
      expect(text).toBe(renderConfigFields());
      continue;
    }
    expect(text, path).toBe(await readFile(join(manualContentRoot, path), 'utf8'));
  }
  // Navigation metadata is build input; only documents reach the runtime tree.
  expect(packed.some((path) => path.endsWith('_meta.json'))).toBe(false);

  const index = await readFile(join(outDir, DOC_INDEX_PATH), 'utf8');
  expect(index.startsWith('# 塑料碗用户手册\n')).toBe(true);
  expect(index).toContain(`共 ${expected.length} 篇`);
  for (const path of expected) {
    expect(index.split(`](${path})`), path).toHaveLength(2);
  }
  const order = ['开始使用', '配置与接入', '把碗配置成自己的', '维护与排障', '参考'].map((label) =>
    index.indexOf(`## ${label}`),
  );
  expect(order.every((position) => position >= 0)).toBe(true);
  expect([...order].sort((left, right) => left - right)).toEqual(order);
  // The site links this page without listing it in its sidebar; the pack still ships and indexes it.
  expect(index.indexOf('## 其他页面')).toBeGreaterThan(index.indexOf('## 参考'));
  expect(index).toContain('(guides/images.md)');
});

test('the packed manual is readable through the document spaces contract', async () => {
  const outDir = await tempRoot();
  const result = await packManual({ outDir });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(outDir)]);
  const access = { conversationId: 1n, chatId: 2n };
  expect(spaces.missing).toEqual([]);

  const [manual] = await spaces.spaces(access);
  expect(manual?.id).toBe('manual');
  expect(manual?.documents).toBe(result.documents.length);

  const index = await spaces.index(access, 'manual');
  expect(index.path).toBe(DOC_INDEX_PATH);
  expect(index.text.startsWith('# 塑料碗用户手册\n')).toBe(true);

  const quickStart = await spaces.read(access, 'manual', 'start/quick-start.md');
  expect(quickStart.text).toBe(await readFile(join(manualContentRoot, 'start/quick-start.md'), 'utf8'));
  expect(quickStart.truncated).toBe(false);
  expect(quickStart.text).toContain('# 第一次运行塑料碗');

  // A relative link in the manual resolves against the page that contains it.
  const imageGuide = await spaces.read(access, 'manual', '../guides/images.md', 'configure/admin.md');
  expect(imageGuide.path).toBe('guides/images.md');
  expect(imageGuide.text).toContain('# 图片生成');
});

test('every relative markdown link stays inside the packed manual', async () => {
  const outDir = await tempRoot();
  await packManual({ outDir });
  const root = resolve(outDir);
  for (const path of await markdownFiles(outDir)) {
    const text = await readFile(join(outDir, path), 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? '';
      if (
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('mailto:') ||
        target.startsWith('__DOCS_BASE__/') ||
        target.startsWith('#') ||
        !target.split('#')[0]?.endsWith('.md')
      ) {
        continue;
      }
      const resolved = resolve(root, dirname(path), target.split('#')[0] ?? '');
      expect(resolved.startsWith(`${root}${sep}`), `${path} -> ${target}`).toBe(true);
      await expect(access(resolved), `${path} -> ${target}`).resolves.toBeUndefined();
    }
  }
});

test('re-packing removes documents that are no longer published', async () => {
  const outDir = await tempRoot();
  await packManual({ outDir });
  const stale = join(outDir, 'guides', 'removed.md');
  await mkdir(dirname(stale), { recursive: true });
  await writeFile(stale, '# Removed\n');
  await packManual({ outDir });
  await expect(access(stale)).rejects.toThrow();
  expect(await markdownFiles(outDir)).not.toContain('guides/removed.md');
});

test('unsupported navigation fails the pack instead of dropping pages', async () => {
  const contentRoot = await tempRoot('plasticwan-manual-content-');
  await writeFile(
    join(contentRoot, '_meta.json'),
    JSON.stringify(['index', { type: 'dir', name: 'start', label: '开始' }]),
  );
  await mkdir(join(contentRoot, 'start'), { recursive: true });
  await writeFile(join(contentRoot, 'start', '_meta.json'), JSON.stringify(['missing']));
  await expect(packManual({ outDir: await tempRoot(), contentRoot })).rejects.toThrow(
    'Manual page listed in navigation does not exist: start/missing.md',
  );

  const noFrontmatter = await tempRoot('plasticwan-manual-content-');
  await writeFile(join(noFrontmatter, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(join(noFrontmatter, 'guide.md'), '# Guide\n');
  await expect(packManual({ outDir: await tempRoot(), contentRoot: noFrontmatter })).rejects.toThrow(
    'missing frontmatter',
  );

  const noNavigation = await tempRoot('plasticwan-manual-content-');
  await expect(packManual({ outDir: await tempRoot(), contentRoot: noNavigation })).rejects.toThrow(
    'Documentation navigation is missing or invalid',
  );
});
