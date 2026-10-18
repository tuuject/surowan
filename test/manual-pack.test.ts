import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { exampleNames, exampleSource, renderConfigFields } from '../scripts/docs-prepare.ts';
import { manualContentRoot, packManual } from '../scripts/manual-prepare.ts';
import { bundledManualSpace, FileSystemDocSpaces } from '../src/adapters/local-monolith/doc-spaces.ts';
import { DOC_INDEX_PATH } from '../src/platform/doc-spaces.ts';
import { PRODUCT_KNOWLEDGE_INDEX } from '../src/platform/product-knowledge.ts';

const directories: string[] = [];
const examplePages = [
  'examples/config.example.jsonc.md',
  'examples/docker-compose.yml.md',
  'examples/system-prompt.example.md',
];

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
  const pages = [...new Set([...sources, 'reference/fields.md'])].sort();
  const expected = [...pages, ...examplePages].sort();
  expect([...result.documents].sort()).toEqual(expected);

  const packed = await markdownFiles(outDir);
  expect(packed).toEqual([...expected, DOC_INDEX_PATH].sort());
  for (const path of expected) {
    const text = await readFile(join(outDir, path), 'utf8');
    expect(text.length, path).toBeGreaterThan(0);
    // `__DOCS_BASE__/` only resolves on the published site; nothing in the pack may keep it.
    expect(text, path).not.toContain('__DOCS_BASE__');
  }
  for (const path of pages) {
    const text = await readFile(join(outDir, path), 'utf8');
    const source =
      path === 'reference/fields.md' ? renderConfigFields() : await readFile(join(manualContentRoot, path), 'utf8');
    if (!source.includes('__DOCS_BASE__')) {
      expect(text, path).toBe(source);
      continue;
    }
    // Only the public links change: every other line is the source verbatim.
    const sourceLines = source.split('\n');
    const packedLines = text.split('\n');
    expect(packedLines, path).toHaveLength(sourceLines.length);
    packedLines.forEach((line, index) => {
      if (!sourceLines[index]?.includes('__DOCS_BASE__')) {
        expect(line, `${path}:${index + 1}`).toBe(sourceLines[index]);
      }
    });
  }
  for (const name of exampleNames) {
    const text = await readFile(join(outDir, 'examples', name.endsWith('.md') ? name : `${name}.md`), 'utf8');
    expect(text.startsWith(`# ${name}\n`)).toBe(true);
    expect(text, name).toContain((await readFile(exampleSource(name), 'utf8')).trimEnd());
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
  expect(index).toContain('## 示例文件');
  expect(index).toContain('(examples/config.example.jsonc.md)');
});

test('public download links point at the packed examples or lose their link', async () => {
  const outDir = await tempRoot();
  await packManual({ outDir });
  const quickStart = await readFile(join(outDir, 'start/quick-start.md'), 'utf8');
  expect(quickStart).toContain('[Compose 模板](../examples/docker-compose.yml.md)');
  expect(quickStart).toContain('[配置示例](../examples/config.example.jsonc.md)');
  expect(quickStart).toContain('[人格 Prompt 示例](../examples/system-prompt.example.md)');
  // The runtime cannot serve llms.txt or the JSON Schema; the label stays as plain text.
  const agentAssisted = await readFile(join(outDir, 'start/agent-assisted.md'), 'utf8');
  expect(agentAssisted).toContain('部署后的文档站提供 llms.txt 与逐页 Markdown');

  const contentRoot = await tempRoot('plasticwan-manual-content-');
  await writeFile(join(contentRoot, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(
    join(contentRoot, 'guide.md'),
    '---\ntitle: Guide\ndescription: Guide page\n---\n\n<a href="__DOCS_BASE__/llms.txt">llms</a>\n',
  );
  await expect(packManual({ outDir: await tempRoot(), contentRoot })).rejects.toThrow(
    'public-resource reference the pack cannot rewrite: guide.md',
  );
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
  expect(quickStart.text).toBe(await readFile(join(outDir, 'start/quick-start.md'), 'utf8'));
  expect(quickStart.truncated).toBe(false);
  expect(quickStart.text).toContain('# 第一次运行塑料碗');

  // A relative link in the manual resolves against the page that contains it.
  const imageGuide = await spaces.read(access, 'manual', '../guides/images.md', 'configure/admin.md');
  expect(imageGuide.path).toBe('guides/images.md');
  expect(imageGuide.text).toContain('# 图片生成');

  // Links with a heading fragment, copied verbatim from the page, read the whole target page.
  const admin = await spaces.read(access, 'manual', 'configure/admin.md');
  expect(admin.text).toContain('](telegram.md#自助忽略与恢复)');
  const telegram = await spaces.read(access, 'manual', 'telegram.md#自助忽略与恢复', 'configure/admin.md');
  expect(telegram.path).toBe('configure/telegram.md');
  expect(telegram.text).toContain('## 自助忽略与恢复');

  const example = await spaces.read(access, 'manual', '../examples/config.example.jsonc.md', 'start/quick-start.md');
  expect(example.truncated).toBe(false);
  expect(example.text).toContain('```jsonc');
});

test('baked product routes resolve to readable manual pages within the context budget', async () => {
  const outDir = await tempRoot();
  const packed = await packManual({ outDir });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(outDir)]);
  const access = { conversationId: 1n, chatId: 2n };
  expect(Buffer.byteLength(PRODUCT_KNOWLEDGE_INDEX, 'utf8')).toBeLessThanOrEqual(7000);
  const paths = new Set([...PRODUCT_KNOWLEDGE_INDEX.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ''));
  expect(paths.size).toBeGreaterThan(0);
  for (const path of paths) {
    const document = await spaces.read(access, 'manual', path);
    expect(packed.documents, path).toContain(document.path);
    expect(document.truncated, path).toBe(false);
  }
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
