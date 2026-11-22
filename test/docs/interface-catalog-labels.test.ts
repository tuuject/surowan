import { expect, test } from 'vitest';
import {
  CLI_CATALOG_PAGE,
  HTTP_CATALOG_PATHS,
  INTERFACE_CATALOG_PAGES,
  MCP_CATALOG_PAGE,
  SESSION_ONLY_ROUTES,
  renderInterfaceCatalogPages,
} from '../../scripts/docs/interface-catalog/index.ts';
import { HTTP_PAGES } from '../../scripts/docs/interface-catalog/pages.ts';
import { CATALOG_TEXT } from '../../scripts/docs/interface-catalog/text.ts';
import { docsLocales } from '../../scripts/docs/locales.ts';
import { bodyOf, findRow, pagesByLocale, tableRows } from './interface-catalog-support.ts';

test('the routes the auth handler answers without a session are labelled so', () => {
  const page = pagesByLocale.get('en')?.get(HTTP_CATALOG_PATHS.session) ?? '';
  const rows = tableRows(page);
  // `GET auth/session` and `POST auth/logout` are answered before the session
  // gate; a key or paired client is still refused, so they are unauthenticated,
  // not panel-session.
  for (const route of ['GET | `/api/auth/session`', 'POST | `/api/auth/logout`']) {
    const row = rows.find((candidate) => candidate.startsWith(`| ${route} |`));
    expect(row, route).toBeDefined();
    const cells = (row ?? '').split(' | ');
    expect(cells[4], route).toBe('unauthenticated');
  }
  // And the page says so: the intro no longer claims every row needs a session.
  expect(page).toContain('without a credential');
});

test('routes only the programmatic dispatch serves name their credential class', () => {
  const en = pagesByLocale.get('en') ?? new Map<string, string>();
  const marked: string[] = [];
  for (const [path, page] of en) {
    if (!path.startsWith('developer/http/')) {
      continue;
    }
    for (const row of tableRows(page)) {
      if (row.includes('API key or paired client only')) {
        marked.push(row);
      }
    }
  }
  // `GET /api/key` is answered by the credential gate itself and the replay route
  // is dispatched inside `#authorizedRequest`; a session gets 404 / 405 for them.
  expect(marked).toHaveLength(2);
  expect(marked.some((row) => row.includes('`/api/key`'))).toBe(true);
  expect(marked.some((row) => row.includes('`/api/invocations/:id/replay`'))).toBe(true);
  for (const row of marked) {
    // The grant stays visible next to the class.
    expect(row).toMatch(/`(?:read|write|paid|write\+paid)` — API key or paired client only/);
  }
});

test('the session catalog labels every route it lists', () => {
  const page = pagesByLocale.get('en')?.get(HTTP_CATALOG_PATHS.session) ?? '';
  const rows = tableRows(page);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    // Permission is the fifth cell: `| METHOD | path | query | body | permission | …`
    const permission = (row.split(' | ')[4] ?? '').trim();
    expect(['panel session', 'unauthenticated'], row).toContain(permission);
  }
  for (const route of SESSION_ONLY_ROUTES) {
    expect(page.includes(route.path), route.path).toBe(true);
  }
});

test('the body column states what the HTTP handler requires', () => {
  const en = pagesByLocale.get('en') ?? new Map<string, string>();

  // `telegram token clear` sends `{ token: null }` as a fixed body; the HTTP
  // handler still parses it and answers 400 without one.
  const configuration = en.get(HTTP_CATALOG_PATHS.configuration) ?? '';
  // `GET /api/telegram` (show) and the two PUT operations share this path.
  const telegramRows = tableRows(configuration).filter(
    (cells) => cells.startsWith('| PUT |') && cells.split(' | ')[1] === '`/api/telegram`',
  );
  expect(telegramRows).toHaveLength(2);
  for (const cells of telegramRows) {
    expect(bodyOf(cells), cells).toBe('`required`');
  }
  // `optional` in the spec only means the CLI may omit the body (it sends `{}`);
  // both handlers parse an object unconditionally.
  expect(
    bodyOf(findRow(en.get(HTTP_CATALOG_PATHS.configuration) ?? '', '| PUT | `/api/prompts/:scope`')),
    'prompt save',
  ).toBe('`required`');
  for (const path of INTERFACE_CATALOG_PAGES) {
    const page = en.get(path) ?? '';
    const restore = findRow(page, '| POST | `/api/prompts/versions/:id/restore`');
    if (restore !== undefined) {
      expect(bodyOf(restore), 'prompt restore').toBe('`required`');
    }
    const retry = findRow(page, '| POST | `/api/image/generations/:id/retry`');
    if (retry !== undefined) {
      expect(bodyOf(retry), 'image generation retry').toBe('`required`');
    }
    const hold = findRow(page, '| PUT | `/api/playground/rooms/:id/hold`');
    if (hold !== undefined) {
      // The handler accepts a request without a body at all.
      expect(bodyOf(hold), 'room hold').toBe('`optional`');
    }
    const extract = findRow(page, '| POST | `/api/image/images/:id/extract`');
    if (extract !== undefined) {
      // `readOptionalBody` treats an empty body as `{}`.
      expect(bodyOf(extract), 'image asset extract').toBe('`optional`');
    }
  }
  // The MCP column keeps the caller's view: the fixed body is supplied by the
  // client, so the tool has no `body` argument.
  const mcp = en.get(MCP_CATALOG_PAGE) ?? '';
  const clearTool = mcp.split('\n').find((cells) => cells.startsWith('| `surowan_telegram_token_clear` |'));
  expect(clearTool, 'surowan_telegram_token_clear').toBeDefined();
  expect(bodyOf(clearTool), 'surowan_telegram_token_clear body').toBe('—');
});

test('a plain-text summary cannot inject raw HTML into the rendered page', () => {
  // Three spec summaries contain `--if-match <revision>` / `<entry revision>`;
  // unescaped, `<revision>` reads as an unknown tag and the placeholder vanishes.
  for (const lang of docsLocales) {
    for (const [path, page] of pagesByLocale.get(lang) ?? []) {
      expect(page.includes('<revision>'), `${lang}: ${path} raw <revision>`).toBe(false);
      expect(page.includes('<entry revision>'), `${lang}: ${path} raw <entry revision>`).toBe(false);
    }
  }
  const cli = pagesByLocale.get('en')?.get(CLI_CATALOG_PAGE) ?? '';
  expect(cli).toContain('&lt;revision&gt;');
  expect(cli).toContain('&lt;entry revision&gt;');
  // Hand-written catalog rows keep their Markdown, including inline code.
  const session = pagesByLocale.get('en')?.get(HTTP_CATALOG_PATHS.session) ?? '';
  expect(session).toContain('`{ code, public_key, proof }`');
});

test('every group id has its own label in both locales', () => {
  const ids = [...new Set(HTTP_PAGES.flatMap((page) => page.groups.map((group) => group.id)))];
  expect(ids.length).toBeGreaterThan(0);
  for (const lang of docsLocales) {
    const text = CATALOG_TEXT[lang];
    const labels = text.groups as Record<string, string | undefined>;
    for (const id of ids) {
      const label = labels[id] ?? '';
      // The label table is keyed by the derived union, so a missing or
      // misspelled id fails the type check too; this pins the runtime side.
      expect(label.trim().length, `${lang}: ${id}`).toBeGreaterThan(0);
      expect(label, `${lang}: ${id} leaks the internal id`).not.toBe(id);
      expect(label, `${lang}: ${id} is untranslated`).not.toMatch(/^[a-z][a-z-]*$/);
    }
    // Every heading a page renders comes from that table, so a stray internal id
    // cannot appear even if a group were added without a label.
    const pages = renderInterfaceCatalogPages(lang);
    const headings = new Set(
      [...pages.values()].flatMap((page) =>
        page
          .split('\n')
          .filter((line) => line.startsWith('## '))
          .map((line) => line.slice(3).trim()),
      ),
    );
    for (const id of ids) {
      expect(headings.has(labels[id] ?? ''), `${lang}: ${id}`).toBe(true);
    }
  }
});
