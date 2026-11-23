import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { renderConfigFieldPages } from '../scripts/docs/config-fields/index.ts';
import { renderGeneratedPages } from '../scripts/docs/generated-pages.ts';
import { exampleNames, exampleSource } from '../scripts/docs/prepare.ts';
import { isChildSegment, manualContentRoot, packManual } from '../scripts/manual-prepare.ts';
import { bundledManualSpace, FileSystemDocSpaces } from '../src/adapters/local-monolith/doc-spaces.ts';
import { DOC_INDEX_PATH, DOC_READ_MAX_BYTES } from '../src/platform/doc-spaces.ts';
import { PRODUCT_KNOWLEDGE_INDEX } from '../src/platform/product-knowledge.ts';

const directories: string[] = [];
const examplePages = exampleNames.map((name) => `examples/${name.endsWith('.md') ? name : `${name}.md`}`);

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function tempRoot(prefix = 'surowan-manual-'): Promise<string> {
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

test('packs only the English manual into the runtime resource layout', async () => {
  const outDir = await tempRoot();
  const result = await packManual({ outDir });
  const generated = renderGeneratedPages('en');
  const sources = (await markdownFiles(manualContentRoot)).filter((path) => path !== 'index.md');
  const pages = [...new Set([...sources, ...generated.keys()])].sort();
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
    const source = generated.get(path) ?? (await readFile(join(manualContentRoot, path), 'utf8'));
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
  expect(index.startsWith('# Surowan User Manual\n')).toBe(true);
  expect(index).toContain(`ships with the running version: ${expected.length} pages`);
  for (const path of expected) {
    expect(index.split(`](${path})`), path).toHaveLength(2);
  }
  // Nested navigation (`developer/http/`) is a sub-section emitted where its parent
  // `_meta.json` lists it, not after the last direct page.
  expect(index.indexOf('### HTTP API')).toBeGreaterThan(index.indexOf('(developer/index.md)'));
  expect(index.indexOf('### HTTP API')).toBeLessThan(index.indexOf('(developer/mcp-server.md)'));
  expect(index).toContain('## Example files');
  expect(index).toContain('(examples/config.minimal.example.jsonc.md)');
});

test('generated pages are packed from the registry, not only from the sidebar', async () => {
  async function fixture(listed: boolean): Promise<string> {
    const contentRoot = await tempRoot('surowan-manual-content-');
    await writeFile(
      join(contentRoot, '_meta.json'),
      JSON.stringify(['index', 'guide', { type: 'dir', name: 'developer', label: 'Developer' }]),
    );
    await writeFile(join(contentRoot, 'index.md'), '---\ntitle: Docs\ndescription: Docs\n---\n\n# Docs\n');
    await writeFile(join(contentRoot, 'guide.md'), '---\ntitle: Guide\ndescription: Guide page\n---\n\n# Guide\n');
    await mkdir(join(contentRoot, 'developer'), { recursive: true });
    await writeFile(
      join(contentRoot, 'developer', '_meta.json'),
      JSON.stringify(listed ? ['index', 'endpoints'] : ['index']),
    );
    await writeFile(join(contentRoot, 'developer', 'index.md'), '---\ntitle: Dev\ndescription: Dev\n---\n\n# Dev\n');
    return contentRoot;
  }
  const generatedPages = new Map([
    ['developer/endpoints.md', '---\ntitle: Endpoints\ndescription: HTTP endpoints\n---\n\n# Endpoints\n'],
  ]);
  const page = 'developer/endpoints.md';

  // Listed by navigation: packed once, at its navigation position.
  const listedOutDir = await tempRoot();
  const listed = await packManual({ outDir: listedOutDir, contentRoot: await fixture(true), generatedPages });
  expect(listed.documents).toContain(page);
  expect(await readFile(join(listedOutDir, page), 'utf8')).toContain('# Endpoints');
  const listedIndex = await readFile(join(listedOutDir, DOC_INDEX_PATH), 'utf8');
  expect(listedIndex.split(`](${page})`)).toHaveLength(2);
  expect(listedIndex).not.toContain('## Other pages');

  // Not listed by navigation: still packed, exactly once, in Other pages.
  const unlistedOutDir = await tempRoot();
  const unlisted = await packManual({ outDir: unlistedOutDir, contentRoot: await fixture(false), generatedPages });
  expect(unlisted.documents).toContain(page);
  const unlistedIndex = await readFile(join(unlistedOutDir, DOC_INDEX_PATH), 'utf8');
  expect(unlistedIndex.split(`](${page})`)).toHaveLength(2);
  expect(unlistedIndex.indexOf('## Other pages')).toBeGreaterThan(unlistedIndex.indexOf('(developer/index.md)'));
});

test('public download links point at the packed examples or lose their link', async () => {
  const contentRoot = await tempRoot('surowan-manual-content-');
  await writeFile(join(contentRoot, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(
    join(contentRoot, 'guide.md'),
    [
      '---',
      'title: Guide',
      'description: Guide page',
      '---',
      '',
      '# Guide',
      '',
      '[Compose 模板](__DOCS_BASE__/examples/docker-compose.yml)',
      '[配置示例](__DOCS_BASE__/examples/config.example.jsonc)',
      '[人格 Prompt 示例](__DOCS_BASE__/examples/system-prompt.example.md)',
      '[索引](__DOCS_BASE__/llms.txt)',
      '![一次性码表单](__DOCS_BASE__/screenshots/installation/sign-in-one-time-code.zh-CN.light.png)',
      '![带标题的截图](__DOCS_BASE__/screenshots/installation/sign-in-one-time-code.zh-CN.light.png "标题")',
      '![相对路径截图](../../screenshots/relative.png "title")',
      '![](empty-alt.png)',
      '',
    ].join('\n'),
  );
  const outDir = await tempRoot();
  await packManual({ outDir, contentRoot });
  const packed = await readFile(join(outDir, 'guide.md'), 'utf8');
  expect(packed).toContain('[Compose 模板](examples/docker-compose.yml.md)');
  expect(packed).toContain('[配置示例](examples/config.example.jsonc.md)');
  expect(packed).toContain('[人格 Prompt 示例](examples/system-prompt.example.md)');
  // The runtime cannot serve llms.txt or the JSON Schema; the label stays as plain text.
  expect(packed).toContain('索引');
  expect(packed).not.toContain('](__DOCS_BASE__/llms.txt)');
  // The offline manual has no images, so every inline image becomes its caption,
  // including one with a link title and one with a relative destination.
  expect(packed).toContain('(Screenshot: 一次性码表单)');
  expect(packed).toContain('(Screenshot: 带标题的截图)');
  expect(packed).toContain('(Screenshot: 相对路径截图)');
  expect(packed).toContain('(Screenshot)');
  expect(packed).not.toContain('__DOCS_BASE__');

  const broken = await tempRoot('surowan-manual-content-');
  await writeFile(join(broken, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(
    join(broken, 'guide.md'),
    '---\ntitle: Guide\ndescription: Guide page\n---\n\n<a href="__DOCS_BASE__/llms.txt">llms</a>\n',
  );
  await expect(packManual({ outDir: await tempRoot(), contentRoot: broken })).rejects.toThrow(
    'public-resource reference the pack cannot rewrite: guide.md',
  );
});

test('image syntax inside code samples stays verbatim', async () => {
  const contentRoot = await tempRoot('surowan-manual-content-');
  await writeFile(join(contentRoot, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(
    join(contentRoot, 'guide.md'),
    [
      '---',
      'title: Guide',
      'description: Guide page',
      '---',
      '',
      '# Guide',
      '',
      '真实截图：![截图说明](__DOCS_BASE__/screenshots/admin/navigation.en.light.png)',
      '',
      '行内代码 `![截图说明](screenshots/local.png)` 是语法示例。',
      '',
      '```md',
      '![截图说明](screenshots/local.png)',
      '```',
      '',
      '半开围栏也按原文保留：',
      '',
      '~~~~',
      '![截图说明](screenshots/local.png)',
      '~~~',
      '~~~~',
      '',
      '````md',
      '```',
      '![截图说明](screenshots/local.png)',
      '```',
      '````',
      '',
    ].join('\n'),
  );
  const outDir = await tempRoot();
  await packManual({ outDir, contentRoot });
  const packed = await readFile(join(outDir, 'guide.md'), 'utf8');
  // A real image is still replaced by its caption...
  expect(packed).toContain('真实截图：(Screenshot: 截图说明)');
  // ...but a code sample that explains the syntax keeps it, so the reader can copy it.
  expect(packed).toContain('行内代码 `![截图说明](screenshots/local.png)` 是语法示例。');
  // Four code samples: the inline span, a fenced block, a tilde block and a
  // four-backtick block that contains a three-backtick one.
  expect(packed.split('![截图说明](screenshots/local.png)')).toHaveLength(5);
  expect(packed).not.toContain('__DOCS_BASE__');
});

test('the packed manual is readable through the document spaces contract', async () => {
  const outDir = await tempRoot();
  const result = await packManual({ outDir });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(outDir)]);
  const access = { conversationId: 1n, internalChatId: 2n };
  expect(spaces.missing).toEqual([]);

  const [manual] = await spaces.spaces(access);
  expect(manual?.id).toBe('manual');
  expect(manual?.title).toBe('Surowan User Manual');
  expect(manual?.documents).toBe(result.documents.length);

  const index = await spaces.index(access, 'manual');
  expect(index.path).toBe(DOC_INDEX_PATH);
  expect(index.text.startsWith('# Surowan User Manual\n')).toBe(true);

  const installation = await spaces.read(access, 'manual', 'guides/installation.md');
  expect(installation.text).toBe(await readFile(join(outDir, 'guides/installation.md'), 'utf8'));
  expect(installation.truncated).toBe(false);
  expect(installation.text).toContain('# Install and sign in');

  // A relative link in the manual resolves against the page that contains it.
  const express = await spaces.read(access, 'manual', './http/index.md', 'developer/index.md');
  expect(express.path).toBe('developer/http/index.md');
  expect(express.text).toContain('# HTTP API conventions');

  // Links with a heading fragment, copied verbatim from a page, read the whole target page.
  const withFragment = await spaces.read(access, 'manual', 'developer/http/index.md#http-api-conventions');
  expect(withFragment.path).toBe('developer/http/index.md');
  expect(withFragment.text).toContain('# HTTP API conventions');

  const example = await spaces.read(access, 'manual', '../examples/config.example.jsonc.md', 'guides/installation.md');
  expect(example.truncated).toBe(false);
  expect(example.text).toContain('```jsonc');
});

test('baked product routes resolve to readable manual pages', async () => {
  const outDir = await tempRoot();
  const packed = await packManual({ outDir });
  const spaces = await FileSystemDocSpaces.load([bundledManualSpace(outDir)]);
  const access = { conversationId: 1n, internalChatId: 2n };
  const paths = new Set([...PRODUCT_KNOWLEDGE_INDEX.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ''));
  expect(paths.size).toBeGreaterThan(0);
  for (const path of paths) {
    const document = await spaces.read(access, 'manual', path);
    expect(packed.documents, path).toContain(document.path);
    expect(document.truncated, path).toBe(false);
  }
});

test('the field reference is split so every page fits one document read', async () => {
  const outDir = await tempRoot();
  const packed = await packManual({ outDir });
  const pages = renderConfigFieldPages('en');
  expect(pages.size).toBeGreaterThan(1);
  const index = pages.get('configuration/fields.md') ?? '';
  for (const [path, content] of pages) {
    expect(packed.documents, path).toContain(path);
    expect(Buffer.byteLength(content), path).toBeLessThanOrEqual(DOC_READ_MAX_BYTES);
    if (path !== 'configuration/fields.md') {
      // Reachable from the index the sidebar and the product knowledge point at.
      expect(index, path).toContain(`](${path.slice('configuration/'.length)})`);
    }
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

test('navigation directory names must be single child segments', async () => {
  expect(isChildSegment('http')).toBe(true);
  for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
    expect(isChildSegment(name), name).toBe(false);
  }
  const contentRoot = await tempRoot('surowan-manual-content-');
  await writeFile(join(contentRoot, '_meta.json'), JSON.stringify([{ type: 'dir', name: 'a/b', label: 'Broken' }]));
  await expect(packManual({ outDir: await tempRoot(), contentRoot })).rejects.toThrow(
    'must name a single child segment',
  );
});

test('frontmatter values are decoded as the YAML writer wrote them', async () => {
  const contentRoot = await tempRoot('surowan-manual-content-');
  await writeFile(join(contentRoot, '_meta.json'), JSON.stringify(['quoted', 'plain']));
  await writeFile(
    join(contentRoot, 'quoted.md'),
    '---\ntitle: "Quoted: title"\ndescription: "Path C:\\\\data and \\"quotes\\""\n---\n\n# Quoted\n',
  );
  await writeFile(
    join(contentRoot, 'plain.md'),
    '---\ntitle: Back\\slash\ndescription: Plain description\n---\n\n# Plain\n',
  );
  const outDir = await tempRoot();
  await packManual({ outDir, contentRoot });
  const index = await readFile(join(outDir, DOC_INDEX_PATH), 'utf8');
  expect(index).toContain('- [Quoted: title](quoted.md): Path C:\\data and "quotes"');
  // A plain scalar is already the value; only a JSON-quoted one is decoded.
  expect(index).toContain('- [Back\\slash](plain.md): Plain description');
});

test('unsupported navigation fails the pack instead of dropping pages', async () => {
  const contentRoot = await tempRoot('surowan-manual-content-');
  await writeFile(
    join(contentRoot, '_meta.json'),
    JSON.stringify(['index', { type: 'dir', name: 'developer', label: 'Developer' }]),
  );
  await writeFile(join(contentRoot, 'index.md'), '---\ntitle: Docs\ndescription: Docs\n---\n\n# Docs\n');
  await mkdir(join(contentRoot, 'developer', 'http'), { recursive: true });
  await writeFile(
    join(contentRoot, 'developer', '_meta.json'),
    JSON.stringify(['index', { type: 'dir', name: 'http', label: 'HTTP API' }]),
  );
  await writeFile(join(contentRoot, 'developer', 'index.md'), '---\ntitle: Dev\ndescription: Dev\n---\n\n# Dev\n');
  await writeFile(join(contentRoot, 'developer', 'http', '_meta.json'), JSON.stringify(['missing']));
  await expect(packManual({ outDir: await tempRoot(), contentRoot })).rejects.toThrow(
    'Manual page listed in navigation does not exist: developer/http/missing.md',
  );

  const noFrontmatter = await tempRoot('surowan-manual-content-');
  await writeFile(join(noFrontmatter, '_meta.json'), JSON.stringify(['guide']));
  await writeFile(join(noFrontmatter, 'guide.md'), '# Guide\n');
  await expect(packManual({ outDir: await tempRoot(), contentRoot: noFrontmatter })).rejects.toThrow(
    'missing frontmatter',
  );

  const noNavigation = await tempRoot('surowan-manual-content-');
  await expect(packManual({ outDir: await tempRoot(), contentRoot: noNavigation })).rejects.toThrow(
    'Documentation navigation is missing or invalid',
  );
});
