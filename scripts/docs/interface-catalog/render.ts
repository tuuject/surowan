import {
  ADMIN_SURFACE_SPECS,
  PANEL_SPECS,
  type EndpointSpec,
  specAccess,
  specIsMcpExposed,
} from '@surowan/admin-surface';

import { TOOL_CATALOG } from '../../../src/ingress/admin/mcp/tools.ts';
import type { DocsLocale } from '../locales.ts';
import {
  HTTP_BODY_OVERRIDES,
  HTTP_CATALOG_PATHS,
  HTTP_PAGES,
  MCP_CATALOG_PAGE,
  CLI_CATALOG_PAGE,
  PROGRAMMATIC_ONLY_COMMANDS,
  asCatalogGroupId,
  catalogAssignment,
  specForCommand,
  type CatalogGroupId,
  type HttpPage,
} from './pages.ts';
import { type SessionRoute, SESSION_ROUTE_BY_KEY } from './session-routes.ts';
import { CATALOG_TEXT } from './text.ts';
import type { CatalogText } from './text-shape.ts';

type HttpMethod = EndpointSpec['method'];

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * A spec summary is plain text, not Markdown: `--if-match <revision>` would be
 * read as an unknown HTML tag and the placeholder would disappear from the
 * rendered page. Hand-written catalog rows are Markdown on purpose and do not
 * pass through here.
 */
function plain(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const code = (value: string): string => `\`${value}\``;

function frontmatter(title: string, description: string): string[] {
  // JSON quoting keeps a colon in a title from turning frontmatter into a mapping.
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'editLink: false',
    'lastUpdated: false',
    '---',
    '',
  ];
}

/** `flag=queryKey` lists the query key; the flag spelling belongs to the CLI. */
function queryKeys(spec: EndpointSpec): readonly string[] {
  return (spec.params ?? []).map((entry) => entry.split('=')[1] ?? entry);
}

function bodyKind(spec: EndpointSpec): RowBody {
  return spec.body === true ? 'required' : spec.body === 'optional' ? 'optional' : 'none';
}

/**
 * The body an HTTP caller must send. A `fixedBody` is still a JSON object the
 * handler parses, and two `optional` rows were checked against their handlers:
 * both call `readJsonObject` unconditionally, so an empty request is a `400`.
 * The CLI and MCP columns keep `bodyKind`, because there the fixed body is
 * supplied by the client and an omitted body stays legal.
 */
function httpBodyKind(spec: EndpointSpec, command: string): RowBody {
  const override = HTTP_BODY_OVERRIDES[command];
  if (override !== undefined) {
    return override;
  }
  return spec.fixedBody === undefined ? bodyKind(spec) : 'required';
}

/** A technical token, not prose: both locales print the same value. */
function bodyLabel(body: RowBody, text: CatalogText): string {
  return body === 'none' ? text.none : code(body);
}

type RowBody = 'required' | 'optional' | 'none';

interface Row {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: readonly string[];
  readonly body: RowBody;
  readonly access: string;
  readonly revision: string;
  readonly confirm: string;
  readonly response: 'json' | 'binary' | 'text';
  readonly summary: string;
}

/**
 * The credential class a row needs, which is not always the route's declared
 * grant. On the session page an `auth/*` or `api-keys*` route is reachable with a
 * cookie only, whatever the grant says, because `gateProgrammaticCredential`
 * refuses every key and paired client before it runs. Elsewhere,
 * `PROGRAMMATIC_ONLY_COMMANDS` names the two routes only the programmatic
 * dispatch serves.
 */
function accessCell(options: {
  readonly spec: EndpointSpec;
  readonly command: string;
  readonly text: CatalogText;
  readonly sessionAccess: string | undefined;
}): string {
  const { spec, command, text, sessionAccess } = options;
  if (sessionAccess !== undefined) {
    return sessionAccess;
  }
  const grant = code(specAccess(spec));
  return PROGRAMMATIC_ONLY_COMMANDS.has(command) ? `${grant} ${text.accessValues.programmaticOnly}` : grant;
}

function specRow(options: {
  readonly spec: EndpointSpec;
  readonly command: string;
  readonly text: CatalogText;
  /** Set on the session page: the label to print instead of the declared grant. */
  readonly sessionAccess: string | undefined;
}): Row {
  const { spec, command, text, sessionAccess } = options;
  return {
    method: spec.method,
    path: `/api/${spec.path}`,
    query: queryKeys(spec),
    body: httpBodyKind(spec, command),
    access: accessCell({ spec, command, text, sessionAccess }),
    revision: spec.revision === undefined ? text.none : code(spec.revision),
    confirm: spec.confirm === undefined ? text.none : code(spec.confirm),
    response: spec.response ?? 'json',
    summary: plain(spec.summary),
  };
}

function sessionRow(route: SessionRoute, lang: DocsLocale, text: CatalogText): Row {
  return {
    method: route.method,
    path: route.path,
    query: [],
    body: route.body,
    access: text.accessValues[route.access],
    revision: text.none,
    confirm: text.none,
    response: route.response,
    summary: lang === 'zh' ? route.zh : route.en,
  };
}

const HTTP_COLUMNS = (text: CatalogText): readonly string[] => [
  text.column.method,
  text.column.path,
  text.column.query,
  text.column.body,
  text.column.access,
  text.column.revision,
  text.column.confirm,
  text.column.response,
  text.column.summary,
];

function httpTable(text: CatalogText, rows: readonly Row[]): string[] {
  const columns = HTTP_COLUMNS(text);
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (row) =>
        `| ${[
          row.method,
          code(row.path),
          row.query.length === 0 ? text.none : row.query.map(code).join(', '),
          bodyLabel(row.body, text),
          row.access,
          row.revision,
          row.confirm,
          code(row.response),
          row.summary,
        ]
          .map(cell)
          .join(' | ')} |`,
    ),
  ];
}

/**
 * The label a spec row on the session page prints instead of its declared grant.
 * `undefined` anywhere else. `public` rows are the ones the auth handler answers
 * before the session gate, so they are unauthenticated-capable rather than
 * cookie-only.
 */
function sessionAccessLabel(definition: HttpPage, groupId: CatalogGroupId, text: CatalogText): string | undefined {
  if (definition.id !== 'session') {
    return undefined;
  }
  return groupId === 'public' ? text.accessValues.public : text.accessValues.session;
}

function renderHttpPage(lang: DocsLocale, definition: HttpPage): string {
  const text = CATALOG_TEXT[lang];
  const page = text.pages[definition.id];
  const lines = [
    ...frontmatter(page.title, page.description),
    `# ${page.title}`,
    '',
    page.intro,
    '',
    text.seeAlso(text.handWrittenLabel[definition.id], definition.handWritten),
    '',
    ...text.legend.flatMap((line) => [line, '']),
    text.sourceSummary,
    '',
  ];
  for (const group of definition.groups) {
    const rows: Row[] = [];
    const groupId = asCatalogGroupId(group.id);
    const sessionAccess = sessionAccessLabel(definition, groupId, text);
    for (const command of group.commands ?? []) {
      const spec = specForCommand(command);
      if (spec !== undefined) {
        rows.push(specRow({ spec, command, text, sessionAccess }));
      }
    }
    for (const key of group.routes ?? []) {
      const route = SESSION_ROUTE_BY_KEY.get(key);
      if (route !== undefined) {
        rows.push(sessionRow(route, lang, text));
      }
    }
    if (rows.length === 0) {
      continue;
    }
    lines.push(`## ${text.groups[groupId]}`, '', ...httpTable(text, rows), '');
  }
  return `${lines.join('\n')}\n`;
}

interface McpRow {
  readonly tool: string;
  readonly spec: EndpointSpec;
}

/**
 * The MCP tools with the routes the server itself pairs them with
 * (`TOOL_CATALOG.entries`), checked against the exposed specs for coverage.
 *
 * Pairing must not be recomputed here: two specs can share a method, a path and a
 * grant (`telegram token` and `telegram token clear` both `PUT /api/telegram`
 * with `write`), so the name is the only thing that tells them apart — which is
 * exactly what the server's own entry carries.
 */
export function mcpCatalogRows(): readonly McpRow[] {
  const exposed = ADMIN_SURFACE_SPECS.filter(specIsMcpExposed);
  const entries = TOOL_CATALOG.entries;
  if (entries.length !== exposed.length) {
    throw new Error(`The MCP tool catalog has ${entries.length} tools for ${exposed.length} exposed routes`);
  }
  const remaining = new Map(exposed.map((spec) => [spec.command, spec]));
  const rows: McpRow[] = [];
  for (const { tool, spec } of entries) {
    if (!remaining.delete(spec.command)) {
      throw new Error(`The MCP tool ${tool.name} maps to ${spec.command}, which is not exposed or is mapped twice`);
    }
    const expected = `(${spec.method} /api/${spec.path}; ${specAccess(spec)} permission)`;
    if (!(tool.description ?? '').includes(expected)) {
      throw new Error(`The MCP tool ${tool.name} no longer describes ${spec.command} as ${expected}`);
    }
    rows.push({ tool: tool.name, spec });
  }
  if (remaining.size > 0) {
    throw new Error(`The MCP tool catalog is missing a tool for: ${[...remaining.keys()].join(', ')}`);
  }
  return rows;
}

function renderMcpPage(lang: DocsLocale): string {
  const text = CATALOG_TEXT[lang];
  const page = text.mcp;
  const columns = [
    text.column.tool,
    text.column.method,
    text.column.path,
    text.column.body,
    text.column.access,
    text.column.revision,
    text.column.confirm,
    text.column.response,
  ];
  const rows = mcpCatalogRows().map(({ tool, spec }) =>
    [
      code(tool),
      spec.method,
      code(`/api/${spec.path}`),
      bodyLabel(bodyKind(spec), text),
      code(specAccess(spec)),
      spec.revision === undefined ? text.none : code(spec.revision),
      spec.confirm === undefined ? text.none : code(spec.confirm),
      code(spec.response ?? 'json'),
    ]
      .map(cell)
      .join(' | '),
  );
  const excluded = ADMIN_SURFACE_SPECS.length - rows.length;
  return `${[
    ...frontmatter(page.title, page.description),
    `# ${page.title}`,
    '',
    ...page.intro.flatMap((line) => [line, '']),
    text.legend[0] ?? '',
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row} |`),
    '',
    text.excludedRoutes(excluded),
    '',
  ].join('\n')}\n`;
}

function renderCliPage(lang: DocsLocale): string {
  const text = CATALOG_TEXT[lang];
  const page = text.cli;
  const columns = [
    text.column.command,
    text.column.method,
    text.column.path,
    text.column.revision,
    text.column.confirm,
    text.column.summary,
  ];
  const rows = PANEL_SPECS.map((spec) =>
    [
      code(spec.command),
      spec.method,
      code(`/api/${spec.path}`),
      spec.revision === undefined ? text.none : code(spec.revision),
      spec.confirm === undefined ? text.none : code(spec.confirm),
      plain(spec.summary),
    ]
      .map(cell)
      .join(' | '),
  );
  return `${[
    ...frontmatter(page.title, page.description),
    `# ${page.title}`,
    '',
    ...page.intro.flatMap((line) => [line, '']),
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n')}\n`;
}

/** Every interface catalog page for one locale, keyed by its path below `content/<lang>/docs`. */
export function renderInterfaceCatalogPages(lang: DocsLocale): ReadonlyMap<string, string> {
  // Resolve the assignment once so an unassigned route fails before rendering.
  catalogAssignment();
  const pages = new Map<string, string>();
  for (const definition of HTTP_PAGES) {
    pages.set(HTTP_CATALOG_PATHS[definition.id], renderHttpPage(lang, definition));
  }
  pages.set(MCP_CATALOG_PAGE, renderMcpPage(lang));
  pages.set(CLI_CATALOG_PAGE, renderCliPage(lang));
  return pages;
}

/**
 * Each catalog page and the hand-written page that documents its bodies and
 * errors; the catalog test follows every link before it passes.
 */

export const CATALOG_HAND_WRITTEN: Readonly<Record<string, string>> = Object.fromEntries(
  HTTP_PAGES.map((definition) => [HTTP_CATALOG_PATHS[definition.id], definition.handWritten]),
);

/** Every catalog path, for the `.gitignore` and the page-set registry. */

export const INTERFACE_CATALOG_PAGES: readonly string[] = [
  ...Object.values(HTTP_CATALOG_PATHS),
  MCP_CATALOG_PAGE,
  CLI_CATALOG_PAGE,
];
