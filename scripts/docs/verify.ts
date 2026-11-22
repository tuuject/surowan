import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Type from 'typebox';
import { Value } from 'typebox/value';

import { isGeneratedPage } from './generated-pages.ts';
import { type DocsLocale, docsLocales, localeText, provenanceText } from './locales.ts';
import { CODE_BLOCK_PATTERN } from './markdown.ts';
import { deploymentSettings, docsRoot, exampleNames, exampleSource, repositoryRoot } from './prepare.ts';
import { redirectRules, renderRedirects } from './redirects.ts';
import { ConfigSchema } from '../../src/platform/config/schema.ts';

const dist = resolve(docsRoot, 'dist');
const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((file) => file.isFile())
  .map((file) => resolve(file.parentPath, file.name));
const fileSet = new Set(files);
const read = (path: string): Promise<string> => readFile(resolve(dist, path), 'utf8');
const metadata: unknown = JSON.parse(await read('build-info.json'));
const localeTextSchema = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    provenanceLabel: Type.String({ minLength: 1 }),
    dirtyNote: Type.String({ minLength: 1 }),
    cleanNote: Type.String({ minLength: 1 }),
    llmsNotes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    llmsSourceLabel: Type.String({ minLength: 1 }),
    provenance: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const metadataSchema = Type.Object(
  {
    commit: Type.String({ pattern: '^[a-f0-9]{40}$' }),
    dirty: Type.Boolean(),
    siteOrigin: Type.String(),
    base: Type.String(),
    locale: Type.Object({ zh: localeTextSchema, en: localeTextSchema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
assert(Value.Check(metadataSchema, metadata), 'Invalid build-info.json');
const { commit, dirty, base, siteOrigin, locale } = metadata;
deploymentSettings({ DOCS_SITE_ORIGIN: siteOrigin, DOCS_BASE_PATH: base });
// A build that ignored the deployment variable must fail the subpath job, not pass
// on an artifact that quietly baked the default base.
for (const [name, artifact] of [
  ['DOCS_BASE_PATH', base],
  ['DOCS_SITE_ORIGIN', siteOrigin],
] as const) {
  const configured = process.env[name];
  if (configured !== undefined && configured !== '') {
    assert.equal(configured, artifact, `${name} does not match the built artifact`);
  }
}
for (const lang of docsLocales) {
  assert.equal(
    locale[lang].provenance,
    provenanceText(lang, commit, dirty),
    `build-info.json provenance is stale for ${lang}`,
  );
}
assert.deepEqual(
  Object.fromEntries(docsLocales.map((lang) => [lang, { ...locale[lang], provenance: '' }])),
  Object.fromEntries(docsLocales.map((lang) => [lang, { ...localeText[lang], provenance: '' }])),
  'build-info.json locale text is stale',
);
assert.equal(
  commit,
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
  'Build SHA is stale',
);
assert.deepEqual(
  JSON.parse(await read('config.schema.json')),
  JSON.parse(JSON.stringify(ConfigSchema)),
  'Schema is stale',
);
for (const name of exampleNames) {
  assert.equal(await read(`examples/${name}`), await readFile(exampleSource(name), 'utf8'), `Stale example: ${name}`);
}

const origin = siteOrigin || 'https://docs.invalid';
const localPaths = new Set<string>();
function checkLink(href: string, source: string): void {
  if (/^(?:#|mailto:|data:)/.test(href)) {
    return;
  }
  const url = new URL(href.replaceAll('&amp;', '&'), `${origin}${base}${source}`);
  if (url.origin !== origin) {
    return;
  }
  assert(url.pathname.startsWith(base), `Link lost base in ${source}: ${href}`);
  let path = decodeURIComponent(url.pathname.slice(base.length));
  if (!path || path.endsWith('/')) {
    path += 'index.html';
  }
  assert(fileSet.has(resolve(dist, path)), `Missing static target in ${source}: ${href}`);
  localPaths.add(path);
}

/**
 * A Markdown output written for one locale must not link into the other locale's
 * manual. HTML is excluded: the language switcher is supposed to cross over.
 */
function assertLocaleLink(href: string, lang: DocsLocale, source: string): void {
  if (/^(?:#|mailto:|data:)/.test(href)) {
    return;
  }
  const url = new URL(href.replaceAll('&amp;', '&'), `${origin}${base}${source}`);
  if (url.origin !== origin) {
    return;
  }
  const foreign = lang === 'en' ? `${base}docs/` : `${base}en/docs/`;
  assert(!url.pathname.startsWith(foreign), `${source} links into the other locale: ${href}`);
}

const contentRoot = resolve(docsRoot, 'content');
/** A short plain-text slice of a page body, to prove the index carries real text. */
function searchablePrefix(markdown: string): string {
  for (const line of markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const plain = line
      .trim()
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`_]/g, '')
      .trim();
    if (plain.length > 0 && !plain.startsWith('#') && !plain.startsWith('<!--') && !plain.startsWith('>')) {
      return plain.slice(0, 12);
    }
  }
  return '';
}

/** Page paths under one locale's content root, with the prefix the built site serves them under. */
async function localePages(lang: (typeof docsLocales)[number]): Promise<readonly string[]> {
  const pages = (await readdir(resolve(contentRoot, lang), { recursive: true }))
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.md'));
  return pages.map((path) => (lang === 'zh' ? path : `${lang}/${path}`)).sort();
}

const pageSets = new Map<(typeof docsLocales)[number], readonly string[]>();
for (const lang of docsLocales) {
  pageSets.set(lang, await localePages(lang));
}
assert.deepEqual(
  pageSets.get('zh') ?? [],
  (pageSets.get('en') ?? []).map((path) => path.replace(/^en\//, '')),
  'The two locales do not publish the same pages',
);

for (const [lang, pages] of pageSets) {
  const text = locale[lang];
  const prefix = lang === 'zh' ? '' : 'en/';
  const index = (await read(`${prefix}llms.txt`)).replaceAll('\r\n', '\n');
  const bundle = (await read(`${prefix}llms-full.txt`)).replaceAll('\r\n', '\n');
  for (const output of [index, bundle]) {
    assert(output.includes(text.provenance), `Missing provenance in ${prefix}llms output`);
    assert(!/<(?:!doctype|html|script)\b/i.test(output), `HTML leaked into ${prefix}llms output`);
  }
  for (const page of pages) {
    const source = await readFile(resolve(contentRoot, lang, page.slice(prefix.length)), 'utf8');
    const markdown = (await read(page)).replaceAll('\r\n', '\n');
    const htmlPath = page.replace(/\.md$/, '.html');
    const html = await read(htmlPath);
    const home = page === `${prefix}index.md`;
    assert(/^title: .+$/m.test(source) && /^description: .+$/m.test(source), `Missing frontmatter: ${page}`);
    // A colon inside an unquoted YAML scalar silently turns frontmatter into a
    // mapping; the built document title then loses the page title.
    const title = (/^title: "?(.*?)"?$/m.exec(source)?.[1] ?? '').replaceAll('\\"', '"');
    assert(html.includes(`<title>${title}`), `Frontmatter title not applied: ${page}`);
    assert.equal(
      [...markdown.replace(CODE_BLOCK_PATTERN, '').matchAll(/^# .+$/gm)].length,
      1,
      `Expected one Markdown H1: ${page}`,
    );
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `Expected one HTML H1: ${page}`);
    // The same exact sentence the theme prints, in both outputs and on home pages too.
    for (const output of [markdown, html]) {
      assert(output.includes(commit), `Missing commit link: ${page}`);
      assert.equal(output.split(text.provenance).length - 1, 1, `Duplicate provenance: ${page}`);
    }
    assert.equal(markdown.includes(text.dirtyNote), dirty, `Wrong dirty marker: ${page}`);
    if (!home) {
      assert(index.includes(`${siteOrigin}${base}${page}`), `Page missing from ${prefix}llms.txt: ${page}`);
      assert(bundle.includes(markdown.trim()), `Page missing from ${prefix}llms-full.txt: ${page}`);
      const generated = page.startsWith(`${prefix}docs/`) && isGeneratedPage(page.slice(`${prefix}docs/`.length));
      assert.equal(html.includes('rp-edit-link'), !generated, `Wrong edit-link visibility: ${page}`);
      if (generated) {
        assert(!html.includes('rp-last-updated'), 'Generated reference must not show a Git timestamp');
      }
    }
    assert(!/<(?:!doctype|html|script)\b/i.test(markdown), `HTML leaked into Markdown: ${page}`);
    for (const match of source.matchAll(CODE_BLOCK_PATTERN)) {
      assert(
        markdown.includes((match[2] ?? '').replaceAll('\r\n', '\n')),
        `Code block lost during Markdown rendering: ${page}`,
      );
    }
    for (const match of markdown.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      checkLink(match[1] ?? '', page);
      assertLocaleLink(match[1] ?? '', lang, page);
    }
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      checkLink(match[1] ?? '', htmlPath);
    }
    localPaths.add(page);
    localPaths.add(htmlPath);
  }
  const searchFiles = files.filter((file) => new RegExp(`search_index\\.${lang}\\.[^/\\\\]+\\.json$`).test(file));
  assert.equal(searchFiles.length, 1, `Expected one ${lang} search index`);
  const searchText = await readFile(searchFiles[0] ?? '', 'utf8');
  const searchData: unknown = JSON.parse(searchText);
  const searchSchema = Type.Array(
    Type.Object({ routePath: Type.String(), title: Type.String(), content: Type.String(), lang: Type.String() }),
  );
  assert(Value.Check(searchSchema, searchData), `Invalid ${lang} search index`);
  assert(!/<(?:!doctype|html|script)\b/i.test(searchText), `HTML leaked into the ${lang} search index`);
  // Directory index pages are routes in their own right (`/docs/`, `/docs/configuration/`).
  const routeOf = (page: string): string => {
    const path = page.slice(0, -'.md'.length);
    return path.endsWith('/index') ? `/${path.slice(0, -'index'.length)}` : `/${path}.html`;
  };
  // The index holds page bodies, which do not repeat the layout's commit notice;
  // its locale contract is the page set it covers, the language on each entry, and
  // real localized text rather than empty rows.
  for (const entry of searchData) {
    assert(entry.title.trim().length > 0, `Empty search title: ${entry.routePath}`);
    assert(entry.content.trim().length > 0, `Empty search content: ${entry.routePath}`);
  }
  const samplePage = `${prefix}docs/guides/installation.md`;
  const sampleSource = await readFile(resolve(contentRoot, lang, 'docs/guides/installation.md'), 'utf8');
  const sampleTitle = /^# (.+)$/m.exec(sampleSource)?.[1] ?? '';
  const sampleBody = searchablePrefix(sampleSource);
  assert(sampleTitle.length > 0 && sampleBody.length > 0, 'The sample page has no title or body to look for');
  const sampleEntry = searchData.find((entry) => entry.routePath === routeOf(samplePage));
  assert(sampleEntry, `Search index is missing its sample page: ${samplePage}`);
  assert.equal(sampleEntry.title, sampleTitle, `Search index has the wrong title for ${samplePage}`);
  assert(sampleEntry.content.includes(sampleBody), `Search index has the wrong body for ${samplePage}`);
  const expectedRoutes = pages
    .filter((page) => page !== `${prefix}index.md`)
    .map(routeOf)
    .sort();
  const indexedRoutes = searchData.map((entry) => {
    assert.equal(entry.lang, lang, `Wrong language in the ${lang} search index: ${entry.routePath}`);
    assert(!/<(?:!doctype|html|script)\b/i.test(entry.content), `HTML leaked into a search entry: ${entry.routePath}`);
    // Search routes are stored without the deployment base.
    checkLink(entry.routePath.startsWith('/') ? `${base}${entry.routePath.slice(1)}` : entry.routePath, 'index.html');
    return entry.routePath;
  });
  assert.deepEqual(indexedRoutes.sort(), expectedRoutes, `The ${lang} search index does not cover every page`);
}

assert((await read('index.md')).includes('虚构示意'), 'Homepage custom content missing from Chinese Markdown');
assert(
  (await read('en/index.md')).includes('Illustrative only'),
  'Homepage custom content missing from English Markdown',
);
for (const [source, text] of [
  ['llms.txt', await read('llms.txt')],
  ['llms-full.txt', await read('llms-full.txt')],
  ['en/llms.txt', await read('en/llms.txt')],
  ['en/llms-full.txt', await read('en/llms-full.txt')],
] as const) {
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    checkLink(match[1] ?? '', source);
    assertLocaleLink(match[1] ?? '', source.startsWith('en/') ? 'en' : 'zh', source);
  }
}

// Every old URL is redirected, and every redirect target is a page this build emitted.
assert.equal((await read('_redirects')).replaceAll('\r\n', '\n'), renderRedirects(base), 'Redirects are stale');
let redirectDirectory: string | undefined;
for (const rule of redirectRules(base)) {
  assert(rule.to.startsWith(base), `Redirect target lost the base: ${rule.to}`);
  let target = rule.to.slice(base.length);
  if (!target || target.endsWith('/')) {
    redirectDirectory ??= target;
    target += 'index.html';
  } else if (!/\.(?:html|md)$/.test(target)) {
    // The extensionless form of a page is served from its `.html` file.
    target += '.html';
  }
  assert(fileSet.has(resolve(dist, target)), `Redirect target missing: ${rule.to}`);
}

for (const file of files) {
  assert(
    !/(?:^|[/\\])(?:agent-doc|dev-data|node_modules|\.git|\.env|key\.json)(?:[/\\]|$)|\.sqlite(?:-|$)|\.map$/.test(
      file,
    ),
    `Private artifact: ${file}`,
  );
  if (/\.(?:html|md|txt|json|js|css)$/.test(file)) {
    const text = await readFile(file, 'utf8');
    assert(!text.includes('__DOCS_BASE__'), `Unresolved public-resource prefix: ${file}`);
    assert(
      !/(?:[A-Z]:[\\/](?:Users|Projects)[\\/]|\/Users\/|\/home\/(?:runner|[^/]+)\/)/.test(text),
      `Build-machine path leaked: ${file}`,
    );
  }
}

// Use the same native preview as docs:preview, not a test server that hides host behavior.
process.chdir(docsRoot);
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
delete process.env.PORT;
const docsRequire = createRequire(resolve(docsRoot, 'package.json'));
const { serve } = await import(pathToFileURL(docsRequire.resolve('@rspress/core/dist/index.js')).href);
const { loadConfigFile } = await import(
  pathToFileURL(docsRequire.resolve('@rspress/core/dist/config/loadConfigFile.js')).href
);
const preview = await serve({ config: await loadConfigFile(), host: '127.0.0.1', port: 5276 });
try {
  for (const path of [
    'llms.txt',
    'llms-full.txt',
    'en/llms.txt',
    'en/llms-full.txt',
    'build-info.json',
    'config.schema.json',
  ]) {
    localPaths.add(path);
  }
  for (const path of localPaths) {
    const response = await fetch(`${preview.urls[0]}${base}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `HTTP failed: ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await readFile(resolve(dist, path)), `Response differs from artifact: ${path}`);
    const type = response.headers.get('content-type') ?? '';
    if (/\.html$/.test(path)) {
      assert(type.includes('text/html'), `Wrong HTML MIME: ${path}`);
    }
    if (/\.(?:md|txt)$/.test(path)) {
      assert(/text\/(?:markdown|plain)/.test(type), `Wrong text MIME: ${path}`);
    }
    if (/\.json$/.test(path)) {
      assert(type.includes('application/json'), `Wrong JSON MIME: ${path}`);
    }
  }
  if (redirectDirectory !== undefined) {
    const response = await fetch(`${preview.urls[0]}${base}${redirectDirectory}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Redirect target directory is not served: ${redirectDirectory}`);
  }
  for (const prefix of ['', 'en/']) {
    const missing = await fetch(`${preview.urls[0]}${base}${prefix}does-not-exist-verification.md`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(missing.status, 404, `Missing Markdown under ${prefix} was rewritten instead of returning 404`);
  }
} finally {
  await preview.server.close();
}
console.log(
  `Verified ${[...pageSets.values()].flat().length} HTML/Markdown pages in two locales, search, examples, schema, provenance, redirects and ${localPaths.size} HTTP resources (base ${base}).`,
);
