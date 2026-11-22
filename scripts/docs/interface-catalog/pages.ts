import { ADMIN_SURFACE_SPECS, type EndpointSpec } from '@surowan/admin-surface';

import { SESSION_ROUTE_BY_KEY } from './session-routes.ts';

/**
 * Which Admin API route group each generated page covers. Every admin-surface
 * command belongs to exactly one group; `catalogAssignment` refuses a command
 * that no group lists and a command two groups claim.
 */

export type CatalogPageId = keyof typeof HTTP_CATALOG_PATHS;

export const HTTP_CATALOG_PATHS = {
  audit: 'developer/http/endpoints-audit.md',
  configuration: 'developer/http/endpoints-configuration.md',
  data: 'developer/http/endpoints-data.md',
  playground: 'developer/http/endpoints-playground-images.md',
  session: 'developer/http/endpoints-session.md',
} as const;

export const MCP_CATALOG_PAGE = 'developer/mcp-tools.md';
export const CLI_CATALOG_PAGE = 'developer/cli-commands.md';

/** Every page must stay inside the document tools' single-read limit. */
export const CATALOG_PAGE_MAX_BYTES = 32 * 1024;

export interface HttpGroup {
  readonly id: string;
  /** Admin-surface commands of this group. */
  readonly commands?: readonly string[];
  /** Session-only routes of this group, as `METHOD /api/path`. */
  readonly routes?: readonly string[];
}

export interface HttpPageDefinition {
  readonly id: CatalogPageId;
  /** The hand-written page that documents the bodies and errors of this group. */
  readonly handWritten: string;
  readonly groups: readonly HttpGroup[];
}

/**
 * Every spec belongs to exactly one group. A specification without a group — or
 * one listed twice — fails the catalog, so a new route cannot reach the panel
 * without appearing in a catalog.
 */
const PAGE_TABLE = [
  {
    id: 'audit',
    handWritten: 'audit.md',
    groups: [
      { id: 'reads', commands: ['overview', 'usage', 'version show', 'key show', 'config view', 'models list'] },
      { id: 'prompts-read', commands: ['prompt global view', 'prompt group view'] },
      {
        id: 'invocations',
        commands: [
          'invocation list',
          'invocation show',
          'invocation prompts',
          'invocation replay-preflight',
          'invocation media',
          'invocation media content',
          'invocation tool image',
          'invocation replay',
          'invocation resume',
        ],
      },
      {
        id: 'messages',
        commands: ['message list', 'message show', 'context list', 'context show', 'context message image'],
      },
      { id: 'stickers', commands: ['sticker list'] },
      { id: 'runtime', commands: ['session cancel', 'wake', 'restart'] },
    ],
  },
  {
    id: 'configuration',
    handWritten: 'configuration.md',
    groups: [
      {
        id: 'providers',
        commands: [
          'provider list',
          'provider create',
          'provider update',
          'provider delete',
          'provider discover',
          'provider lookup-metadata',
          'provider health-check',
          'model add',
          'model update',
          'model delete-many',
          'model delete',
          'model set',
          'vision set',
          'thinking-level set',
          'provider-preset list',
        ],
      },
      {
        id: 'prompts',
        commands: [
          'prompt versions',
          'prompt version show',
          'prompt diff',
          'prompt save',
          'prompt restore',
          'prompt cancel-running',
        ],
      },
      {
        id: 'chats',
        commands: [
          'chat list',
          'chat create',
          'chat update',
          'chat delete',
          'chat participation',
          'chat decision-gate',
          'chat proactive-reply',
          'chat mcp',
          'chat group-memory',
        ],
      },
      { id: 'gate', commands: ['decision-gate show', 'decision-gate update', 'decision-gate decisions'] },
      {
        id: 'harness',
        commands: ['harness show', 'harness update', 'developer show', 'developer update', 'developer clear-payloads'],
      },
      { id: 'search', commands: ['search show', 'search update'] },
      {
        id: 'telegram',
        commands: ['telegram show', 'telegram bucket-timing', 'telegram token', 'telegram token clear'],
      },
      {
        id: 'sticker-sets',
        commands: ['sticker-set list', 'sticker-set add', 'sticker-set update', 'sticker-set remove'],
      },
      {
        id: 'mcp-servers',
        commands: [
          'mcp-server list',
          'mcp-server create',
          'mcp-server update',
          'mcp-server describe',
          'mcp-server delete',
        ],
      },
      { id: 'admins', commands: ['bot-admin list', 'bot-admin add', 'bot-admin remove'] },
      { id: 'warnings', commands: ['warning list', 'warning read', 'warning clear'] },
      { id: 'config-file', commands: ['config apply', 'config status'] },
    ],
  },
  {
    id: 'data',
    handWritten: 'data.md',
    groups: [
      {
        id: 'memo',
        commands: ['memo list', 'memo chats', 'memo create', 'memo update', 'memo delete', 'memo blob content'],
      },
      {
        id: 'group-memory',
        commands: [
          'group-memory list',
          'group-memory progress',
          'group-memory runs',
          'group-memory messages',
          'group-memory update',
          'group-memory delete',
        ],
      },
      {
        id: 'dictionary',
        commands: [
          'dictionary list',
          'dictionary chats',
          'dictionary create',
          'dictionary update',
          'dictionary delete',
          'dictionary settings show',
          'dictionary settings update',
          'dictionary import preview',
          'dictionary import apply',
          'dictionary export',
          'dictionary merge preview',
          'dictionary merge apply',
          'tool-model set',
        ],
      },
      { id: 'alarms', commands: ['alarm list', 'alarm cancel'] },
      {
        id: 'recurring',
        commands: [
          'recurring-alarm list',
          'recurring-alarm targets',
          'recurring-alarm preview',
          'recurring-alarm create',
          'recurring-alarm get',
          'recurring-alarm update',
          'recurring-alarm delete',
          'recurring-alarm run',
        ],
      },
    ],
  },
  {
    id: 'playground',
    handWritten: 'playground-images.md',
    groups: [
      {
        id: 'playground',
        commands: [
          'room list',
          'room create',
          'room show',
          'room messages',
          'room send',
          'room participant add',
          'room hold',
          'room release',
          'room release show',
          'room release retry',
          'room asset list',
          'room asset upload',
          'room asset content',
          'room capabilities',
          'room invocations',
          'room invocation show',
        ],
      },
      {
        id: 'image-config',
        commands: [
          'image status',
          'image config show',
          'image config update',
          'image model list',
          'image model endpoints',
        ],
      },
      {
        id: 'image-assets',
        commands: [
          'image prompt list',
          'image prompt show',
          'image prompt create',
          'image prompt update',
          'image prompt archive',
          'image asset list',
          'image asset show',
          'image asset content',
          'image asset upload',
          'image asset update',
          'image asset extract',
          'image asset archive',
        ],
      },
      {
        id: 'image-generations',
        commands: [
          'image generation resolve',
          'image generation list',
          'image generation show',
          'image generation create',
          'image generation retry',
        ],
      },
    ],
  },
  {
    id: 'session',
    handWritten: 'index.md',
    groups: [
      {
        id: 'public',
        // `GET auth/session` and `POST auth/logout` are answered before the
        // session gate, so they belong here with the sign-in routes even though
        // a session changes their answer; API keys and paired clients are still
        // refused by the credential gate, which runs on the `Authorization` path.
        commands: ['session show', 'logout'],
        routes: [
          'POST /api/auth/login',
          'POST /api/auth/pairing',
          'POST /api/auth/passkeys/login/options',
          'POST /api/auth/passkeys/login/verify',
          'POST /api/pairing/claim',
        ],
      },
      {
        id: 'auth',
        commands: ['account update', 'passkey list', 'passkey delete', 'password delete'],
        routes: ['POST /api/auth/passkeys/register/options', 'POST /api/auth/passkeys/register/verify'],
      },
      {
        id: 'api-keys',
        commands: ['api-key list', 'api-key create', 'api-key revoke'],
        routes: ['PUT /api/api-keys/:id', 'POST /api/api-keys/:id/rotate'],
      },
      {
        id: 'keychain',
        routes: [
          'GET /api/keychain',
          'POST /api/keychain',
          'POST /api/keychain/purge',
          'PUT /api/keychain/:name',
          'DELETE /api/keychain/:name',
        ],
      },
      { id: 'live', routes: ['GET /api/live/invocations', 'GET /api/live/invocations/:id'] },
    ],
  },
] as const satisfies readonly HttpPageDefinition[];

/**
 * Every group id the catalogs can render. Derived from the page table, so
 * `text-shape.ts` can require a label for each one in both locales: a missing or
 * misspelled label is a type error instead of the internal id leaking to readers.
 */
export type CatalogGroupId = (typeof PAGE_TABLE)[number]['groups'][number]['id'];

/** One page of the table; iterative code sees the widened interface above. */
export type HttpPage = HttpPageDefinition;

export const HTTP_PAGES: readonly HttpPage[] = PAGE_TABLE;
const BY_COMMAND = new Map(ADMIN_SURFACE_SPECS.map((spec) => [spec.command, spec]));

export interface CatalogAssignment {
  readonly page: CatalogPageId;
  readonly group: CatalogGroupId;
}

const GROUP_IDS: ReadonlySet<string> = new Set(PAGE_TABLE.flatMap((page) => page.groups.map((group) => group.id)));

/**
 * Narrows a group id read from the widened `HttpGroup` interface back to the
 * union the label table is keyed by. The table is the definition, so this cannot
 * reject a real entry; it keeps the label lookup honest instead of silently
 * falling back to the internal id.
 */
export function asCatalogGroupId(value: string): CatalogGroupId {
  if (!GROUP_IDS.has(value)) {
    throw new Error(`Unknown catalog group: ${value}`);
  }
  return value as CatalogGroupId;
}

/**
 * Routes a panel session cannot reach, because only the programmatic dispatch
 * serves them: `GET /api/key` is answered by the credential gate itself, and
 * `POST /api/invocations/:id/replay` is dispatched only inside
 * `#authorizedRequest` (`src/ingress/admin/index.ts`). A cookie request gets
 * 404 / 405 for them, so the catalog names the credential class next to the
 * grant instead of pretending a session could call them.
 */
export const PROGRAMMATIC_ONLY_COMMANDS: ReadonlySet<string> = new Set(['key show', 'invocation replay']);

type RowBodyKind = 'required' | 'optional' | 'none';

/** The command's own route, for the renderers. */
export function specForCommand(command: string): EndpointSpec | undefined {
  return BY_COMMAND.get(command);
}

/**
 * Rows whose `EndpointSpec` understates what the handler requires. `optional`
 * only means the CLI may omit the body — it sends `{}` — so each entry here was
 * checked against the handler: both routes parse a JSON object unconditionally
 * and answer `400 invalid_body` to an empty request.
 */
export const HTTP_BODY_OVERRIDES: Readonly<Record<string, RowBodyKind>> = {
  'prompt restore': 'required',
  'image generation retry': 'required',
};

/** The part of a page table that names session-only routes. */
export interface RouteOwnershipInput {
  readonly id: string;
  readonly groups: readonly HttpGroup[];
}

/**
 * Checks the manual route keys of a page table and returns which page owns each
 * one. A key must exist in `SESSION_ONLY_ROUTES`, must not be listed twice (the
 * coverage check alone would still pass while the row rendered twice) and must
 * not repeat an admin-surface route, which would publish one route under two
 * credential classes.
 */
export function validateManualRoutes(pages: readonly RouteOwnershipInput[]): ReadonlyMap<string, string> {
  const owner = new Map<string, string>();
  const specRoutes = new Set(ADMIN_SURFACE_SPECS.map((spec) => `${spec.method} /api/${spec.path}`));
  for (const page of pages) {
    for (const group of page.groups) {
      for (const key of group.routes ?? []) {
        if (specRoutes.has(key)) {
          throw new Error(`The manual route ${key} duplicates an admin-surface spec route`);
        }
        if (!SESSION_ROUTE_BY_KEY.has(key)) {
          throw new Error(`Catalog page ${page.id} lists an unknown session route: ${key}`);
        }
        const previous = owner.get(key);
        if (previous !== undefined) {
          throw new Error(`Catalog lists the route twice: ${key} (${previous}, ${page.id})`);
        }
        owner.set(key, page.id);
      }
    }
  }
  return owner;
}

export function catalogAssignment(): ReadonlyMap<string, CatalogAssignment> {
  const assigned = new Map<string, CatalogAssignment>();
  const routed = validateManualRoutes(HTTP_PAGES);
  for (const page of HTTP_PAGES) {
    for (const group of page.groups) {
      for (const command of group.commands ?? []) {
        if (!BY_COMMAND.has(command)) {
          throw new Error(`Catalog page ${page.id} lists an unknown command: ${command}`);
        }
        if (assigned.has(command)) {
          throw new Error(`Catalog lists the command twice: ${command}`);
        }
        assigned.set(command, { page: page.id, group: asCatalogGroupId(group.id) });
      }
    }
  }
  const missing = [...BY_COMMAND.keys()].filter((command) => !assigned.has(command));
  if (missing.length > 0) {
    throw new Error(`Admin surface commands missing from the catalogs: ${missing.join(', ')}`);
  }
  const unlisted = [...SESSION_ROUTE_BY_KEY.keys()].filter((key) => !routed.has(key));
  if (unlisted.length > 0) {
    throw new Error(`Session-only routes missing from the catalogs: ${unlisted.join(', ')}`);
  }
  return assigned;
}
