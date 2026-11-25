import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ADMIN_SURFACE_SPECS, PANEL_SPECS, specAccess, specIsMcpExposed } from '@surowan/admin-surface';
import { expect, test } from 'vitest';
import { TOOL_CATALOG } from '../../src/ingress/admin/mcp/tools.ts';
import {
  CATALOG_HAND_WRITTEN,
  CATALOG_PAGE_MAX_BYTES,
  CLI_CATALOG_PAGE,
  HTTP_CATALOG_PATHS,
  INTERFACE_CATALOG_PAGES,
  MCP_CATALOG_PAGE,
  SESSION_ONLY_ROUTES,
  catalogAssignment,
  mcpCatalogRows,
  renderInterfaceCatalogPages,
} from '../../scripts/docs/interface-catalog/index.ts';
import { HTTP_PAGES, validateManualRoutes } from '../../scripts/docs/interface-catalog/pages.ts';
import { isGeneratedPage, renderGeneratedPages } from '../../scripts/docs/generated-pages.ts';
import { type DocsLocale, docsLocales } from '../../scripts/docs/locales.ts';
import { repositoryRoot } from '../../scripts/docs/prepare.ts';
import { pagesByLocale, rowPath, tableRows } from './interface-catalog-support.ts';

test('every admin-surface command appears in exactly one catalog page', () => {
  const assignment = catalogAssignment();
  expect(assignment.size).toBe(ADMIN_SURFACE_SPECS.length);
  for (const spec of ADMIN_SURFACE_SPECS) {
    expect(assignment.has(spec.command), spec.command).toBe(true);
  }
});

test('each route is rendered on the page its group owns, once per command', () => {
  const assignment = catalogAssignment();
  const en = pagesByLocale.get('en') ?? new Map<string, string>();
  // Two commands may share one route: `telegram token` and `telegram token
  // clear` both PUT /api/telegram, and the MCP catalog and the CLI expose both
  // (one with a fixed body). Each renders its own row with its own summary.
  const routes = new Map<string, { page: string; commands: string[] }>();
  for (const spec of ADMIN_SURFACE_SPECS) {
    const entry = assignment.get(spec.command);
    expect(entry, spec.command).toBeDefined();
    if (entry === undefined) {
      continue;
    }
    const key = `${spec.method} /api/${spec.path}`;
    const page = HTTP_CATALOG_PATHS[entry.page];
    const existing = routes.get(key);
    if (existing === undefined) {
      routes.set(key, { page, commands: [spec.command] });
      continue;
    }
    expect(existing.page, key).toBe(page);
    existing.commands.push(spec.command);
  }
  for (const [route, { page: pagePath, commands }] of routes) {
    const [method, path] = route.split(' ');
    const page = en.get(pagePath) ?? '';
    expect(page.split(`| ${method} | \`${path}\` |`), `${pagePath}: ${commands.join(', ')}`).toHaveLength(
      commands.length + 1,
    );
  }
});

test('every route of the catalog pages is one declared command or session route', () => {
  const declared = new Set(ADMIN_SURFACE_SPECS.map((spec) => `/api/${spec.path}`));
  for (const route of SESSION_ONLY_ROUTES) {
    declared.add(route.path);
  }
  for (const [path, page] of pagesByLocale.get('en') ?? []) {
    if (!path.startsWith('developer/http/')) {
      continue;
    }
    const assignment = catalogAssignment();
    const declaredHere = new Set(
      [...assignment.entries()]
        .filter(([, entry]) => HTTP_CATALOG_PATHS[entry.page] === path)
        .map(([command]) => {
          const spec = ADMIN_SURFACE_SPECS.find((candidate) => candidate.command === command);
          return spec === undefined ? '' : `/api/${spec.path}`;
        }),
    );
    for (const route of SESSION_ONLY_ROUTES) {
      declaredHere.add(route.path);
    }
    for (const row of tableRows(page)) {
      const route = rowPath(row);
      expect(declared.has(route), `${path}: undeclared route ${route}`).toBe(true);
      expect(declaredHere.has(route), `${path}: route ${route} belongs to another page`).toBe(true);
    }
  }
});

test('a session-only route is still implemented where the catalog says it is', async () => {
  // The catalog lists routes the specs do not model, so each entry names the code
  // that serves it. A renamed or deleted route fails here instead of leaving a
  // published page that documents something the server no longer answers.
  expect(SESSION_ONLY_ROUTES.length).toBeGreaterThan(0);
  const files = new Map<string, string>();
  for (const route of SESSION_ONLY_ROUTES) {
    let text = files.get(route.source.file);
    if (text === undefined) {
      text = await readFile(resolve(repositoryRoot, route.source.file), 'utf8');
      files.set(route.source.file, text);
    }
    for (const needle of route.source.needles) {
      expect(text.includes(needle), `${route.method} ${route.path}: ${needle} (${route.source.file})`).toBe(true);
    }
    // The path anchor alone cannot tell two branches of one handler apart
    // (`/api/keychain` GET and POST share `segments[0] === 'keychain'`), so every
    // route must also name its own method.
    expect(
      route.source.needles.some((needle) => needle.includes(route.method)),
      `${route.method} ${route.path} has no method-specific needle`,
    ).toBe(true);
  }
});

test('a manual route key cannot be listed twice or repeat a spec route', () => {
  // The real table is valid, which the coverage tests above rely on.
  expect(validateManualRoutes(HTTP_PAGES).size).toBe(SESSION_ONLY_ROUTES.length);
  expect(() =>
    validateManualRoutes([
      {
        id: 'session',
        groups: [{ id: 'public', routes: ['POST /api/auth/login', 'POST /api/auth/login'] }],
      },
    ]),
  ).toThrow(/route twice/);
  expect(() =>
    validateManualRoutes([{ id: 'session', groups: [{ id: 'public', routes: ['GET /api/providers'] }] }]),
  ).toThrow(/duplicates an admin-surface spec route/);
  expect(() =>
    validateManualRoutes([{ id: 'session', groups: [{ id: 'public', routes: ['GET /api/nope'] }] }]),
  ).toThrow(/unknown session route/);
});

test('every MCP tool renders with the route the server pairs it with', () => {
  // Two specs share method, path and grant (`telegram token` / `telegram token
  // clear`, both `PUT /api/telegram` with `write`), so a positional pairing could
  // swap them and still pass a description check. The association must come from
  // the server's own catalog entries.
  expect(TOOL_CATALOG.entries).toHaveLength(TOOL_CATALOG.tools.length);
  const byPath = new Map(mcpCatalogRows().map((row) => [row.tool, row.spec.command]));
  expect(byPath.get('surowan_telegram_token')).toBe('telegram token');
  expect(byPath.get('surowan_telegram_token_clear')).toBe('telegram token clear');
  for (const entry of TOOL_CATALOG.entries) {
    expect(entry.spec.command.length).toBeGreaterThan(0);
    expect(TOOL_CATALOG.tools.find((tool) => tool.name === entry.tool.name)).toBe(entry.tool);
  }
});

test('the MCP catalog is the real tool catalog, with the account routes excluded', () => {
  const rows = mcpCatalogRows();
  expect(rows).toHaveLength(ADMIN_SURFACE_SPECS.filter(specIsMcpExposed).length);
  for (const { tool, spec } of rows) {
    expect(tool.startsWith('surowan_'), tool).toBe(true);
    expect(tool.length).toBeLessThanOrEqual(64);
    expect(spec.path.startsWith('auth/'), spec.path).toBe(false);
    expect(spec.path.startsWith('api-keys'), spec.path).toBe(false);
    expect(spec.mcp).not.toBe(false);
  }
  expect(rows.some((entry) => entry.spec.path.startsWith('keychain'))).toBe(false);
  for (const lang of docsLocales) {
    const page = pagesByLocale.get(lang)?.get(MCP_CATALOG_PAGE) ?? '';
    for (const { tool } of rows) {
      expect(page.includes(`| \`${tool}\``), `${lang}: ${tool}`).toBe(true);
    }
  }
});

test('the CLI catalog is the panel subset of the same surface', () => {
  for (const lang of docsLocales) {
    const page = pagesByLocale.get(lang)?.get(CLI_CATALOG_PAGE) ?? '';
    for (const spec of PANEL_SPECS) {
      expect(
        page.includes(`| \`${spec.command}\` | ${spec.method} | \`/api/${spec.path}\``),
        `${lang}: ${spec.command}`,
      ).toBe(true);
    }
    // Session-only routes stay out: the CLI has no command for them.
    for (const route of SESSION_ONLY_ROUTES) {
      expect(page.includes(route.path), `${lang}: ${route.path}`).toBe(false);
    }
  }
});

test('both locales generate the same pages, and each page stays readable in one read', () => {
  const zh = pagesByLocale.get('zh') ?? new Map<string, string>();
  const en = pagesByLocale.get('en') ?? new Map<string, string>();
  expect([...zh.keys()].sort()).toEqual([...en.keys()].sort());
  expect([...zh.keys()].sort()).toEqual([...INTERFACE_CATALOG_PAGES].sort());
  for (const lang of docsLocales) {
    for (const [path, page] of pagesByLocale.get(lang) ?? []) {
      expect(Buffer.byteLength(page), `${lang}: ${path}`).toBeLessThanOrEqual(CATALOG_PAGE_MAX_BYTES);
      // The site and the offline manual both require one H1, plus a real description.
      expect(
        page.split('\n').filter((line) => line.startsWith('# ')),
        `${lang}: ${path} H1 count`,
      ).toHaveLength(1);
      const frontmatter = page.slice(0, page.indexOf('\n---\n', 4));
      const title = (/^title: "(.*)"$/m.exec(frontmatter)?.[1] ?? '').replaceAll('\\"', '"');
      const heading = page.split('\n').find((line) => line.startsWith('# ')) ?? '';
      expect(heading, `${lang}: ${path} heading`).toBe(`# ${title}`);
      expect(/^description: ".+"$/m.test(frontmatter), `${lang}: ${path} description`).toBe(true);
      // Generated pages carry no Git timestamp or edit link on the site.
      expect(frontmatter, `${lang}: ${path}`).toContain('editLink: false');
      expect(frontmatter, `${lang}: ${path}`).toContain('lastUpdated: false');
    }
  }
});

test('both locales carry the same route data, only the labels differ', () => {
  const zh = pagesByLocale.get('zh') ?? new Map<string, string>();
  const en = pagesByLocale.get('en') ?? new Map<string, string>();
  for (const path of INTERFACE_CATALOG_PAGES) {
    const zhRows = tableRows(zh.get(path) ?? '');
    const enRows = tableRows(en.get(path) ?? '');
    // The permission cell is a credential-class label and the summary is prose, so
    // both are localized; method, path, query, body, revision, confirmation and
    // response must be identical.
    const strip = (row: string): string => {
      const cells = row.split(' | ');
      return [...cells.slice(0, 4), ...cells.slice(5, -1)].join(' | ');
    };
    expect(zhRows.map(strip), path).toEqual(enRows.map(strip));
  }
});

test('every catalog page links the hand-written page that documents its bodies', () => {
  for (const lang of docsLocales) {
    for (const [path, handWritten] of Object.entries(CATALOG_HAND_WRITTEN)) {
      const page = pagesByLocale.get(lang)?.get(path) ?? '';
      // The generated page is the exhaustive list; the hand-written page owns the
      // fields, enums and error codes, and is linked from its own directory.
      expect(isGeneratedPage(path), path).toBe(true);
      expect(page.includes(handWritten) || handWritten === 'index.md', `${lang}: ${path}`).toBe(true);
    }
  }
});

test('the generated-page registry and prepare cover every catalog', () => {
  const pages = renderGeneratedPages('en');
  for (const path of INTERFACE_CATALOG_PAGES) {
    expect(isGeneratedPage(path), path).toBe(true);
    expect(pages.has(path), path).toBe(true);
    expect(pages.get(path), path).toBe(renderInterfaceCatalogPages('en').get(path));
  }
});

test('the catalogs are deterministic: no clock, no absolute path, no locale leak', () => {
  const first = renderInterfaceCatalogPages('en');
  const second = renderInterfaceCatalogPages('en');
  expect([...first.entries()]).toEqual([...second.entries()]);
  for (const lang of docsLocales as readonly DocsLocale[]) {
    for (const [path, page] of pagesByLocale.get(lang) ?? []) {
      expect(page.includes(repositoryRoot), `${lang}: ${path} repository path`).toBe(false);
      expect(/\b(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/.test(page), `${lang}: ${path} timestamp`).toBe(false);
      if (lang === 'en') {
        expect(page.includes('en/docs/'), `${path} links into the English tree`).toBe(false);
      } else {
        expect(page.includes('/en/docs/'), `${path} links into the English tree`).toBe(false);
      }
    }
  }
});

test('a route table states the permission the server actually enforces', () => {
  const page = pagesByLocale.get('en')?.get(HTTP_CATALOG_PATHS.configuration) ?? '';
  for (const spec of ADMIN_SURFACE_SPECS.filter((entry) => !entry.path.startsWith('auth/'))) {
    const access = specAccess(spec);
    if (spec.confirm === 'paid') {
      // A billed write is never reachable with the read grant alone.
      expect(['paid', 'write+paid']).toContain(access);
    }
  }
  // The generated table spells the access codes verbatim, so a reader can map a
  // route straight onto an API key mode.
  expect(page.includes('`write+paid`')).toBe(true);
});
