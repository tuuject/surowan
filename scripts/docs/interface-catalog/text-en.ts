import type { CatalogText } from './text-shape.ts';

export const textEn: CatalogText = {
  column: {
    method: 'Method',
    path: 'Path',
    query: 'Query',
    body: 'Body',
    access: 'Permission',
    revision: 'If-Match',
    confirm: 'Confirm',
    response: 'Response',
    summary: 'Summary',
    tool: 'Tool',
    command: 'Command',
  },
  none: '—',
  accessValues: {
    session: 'panel session',
    public: 'unauthenticated',
    programmaticOnly: '— API key or paired client only',
  },
  handWrittenLabel: {
    audit: 'Audit, resume and export API',
    configuration: 'Configuration, gate and tool API',
    data: 'Knowledge and alarm data API',
    playground: 'Playground and image API',
    session: 'HTTP API conventions',
  },
  seeAlso: (label, file) => `Request bodies, enums and error codes are documented in [${label}](${file}).`,
  legend: [
    '**Permission** is the credential class a route needs. `read`, `write`, `paid` and `write+paid` are the grants an API key or paired client must hold: `read` is always available, and `write+paid` requires both the write and the paid grant. `panel session` means the route needs a signed-in browser session, and `unauthenticated` means it answers without a credential at all.',
    "**If-Match** says where the route reads its concurrency revision: `config` is the `config.jsonc` revision (`GET /api/providers` returns it), `prompt` is the prompt content hash, and `entry` is the target row's own revision, which you must have read first.",
    "**Confirm** marks a write the server treats as destructive or billed. The CLI `--yes` flag and the MCP `confirm` argument are how those clients carry the operator's approval; a route may instead require an explicit body field for the same decision — `abort_running: true` on `PUT /api/model` and `PUT /api/chats/:id`, which is refused with `409 model_in_use` until it is sent.",
    '**Body** and **Response** describe shape only: `json` is the default, `binary` returns bytes, and `text` returns plain text or an event stream. `required` means the handler parses a JSON object and answers `400` to a request without one. Fields, enums, units and error codes live on the hand-written page of each group.',
    'A `:name` in a path is one path segment. Numeric ids travel as decimal strings; other ids are opaque — a memo is `mem_…`, a Playground asset is 32 hex characters, an image asset is a UUID — and must be reused exactly as the API returned them. A model id containing `/` must be percent-encoded. The **Query** column lists HTTP parameter names, not command-line flags.',
  ],
  pages: {
    audit: {
      title: 'HTTP endpoint catalog: audit and resume',
      description:
        'The audit, invocation, message, Context and runtime-control routes generated from the Admin surface of this commit.',
      intro:
        'This page is generated from the Admin surface of the same commit and covers audit reads, resuming a failed run and runtime controls.',
    },
    configuration: {
      title: 'HTTP endpoint catalog: configuration, gate and tools',
      description:
        'The provider, model, prompt, chat, gate, Telegram and MCP management routes generated from the Admin surface of this commit.',
      intro:
        'This page is generated from the Admin surface of the same commit and covers the management routes that write `config.jsonc`.',
    },
    data: {
      title: 'HTTP endpoint catalog: knowledge and alarms',
      description:
        'The memo, group memory, dictionary, alarm and recurring-alarm routes generated from the Admin surface of this commit.',
      intro:
        'This page is generated from the Admin surface of the same commit and covers the human-editable data kept in the database.',
    },
    playground: {
      title: 'HTTP endpoint catalog: Playground and images',
      description:
        'The virtual room, image generation, asset and prompt-asset routes generated from the Admin surface of this commit.',
      intro:
        'This page is generated from the Admin surface of the same commit and covers the Playground and image features.',
    },
    session: {
      title: 'HTTP endpoint catalog: panel session and credentials',
      description:
        'The panel session, one-time-code sign-in, passkey, API key and Keychain routes, and which credential each one needs.',
      intro:
        'This page lists the panel session, passkey, API key and Keychain routes with their credential class. The `unauthenticated` rows answer before the session gate — password or one-time-code sign-in, the passkey login flow, the session probe, logout and the pairing claim — so they work without a credential. Every other row needs a signed-in browser session, and an API key or paired client is refused with 403 on all of them except the pairing claim, which is handled before the credential gate and ignores any credential. Passkey rows need `admin.public_url`; without it they answer `404 passkeys_disabled`, and their verify calls also need the challenge cookie their options call set and an `Origin` equal to that public URL.',
    },
  },
  groups: {
    reads: 'Overview and read-only views',
    'prompts-read': 'Prompt read-only views',
    invocations: 'Invocations and resume',
    messages: 'Messages and Contexts',
    stickers: 'Stickers',
    runtime: 'Runtime controls',
    providers: 'Providers and models',
    prompts: 'Prompt versions',
    chats: 'Chats and participation',
    gate: 'Entry gate (Decisions)',
    harness: 'Harness tuning and debug recording',
    search: 'Web search',
    telegram: 'Telegram',
    'sticker-sets': 'Sticker sets',
    'mcp-servers': 'Outbound MCP servers',
    admins: 'Bot admins',
    warnings: 'Warnings',
    'config-file': 'Configuration file application',
    memo: 'Memo Pad',
    'group-memory': 'Group memory',
    dictionary: 'Dictionary and tool model',
    alarms: 'Alarms',
    recurring: 'Recurring alarms',
    playground: 'Virtual rooms',
    'image-config': 'Image settings and models',
    'image-assets': 'Prompt and image assets',
    'image-generations': 'Image generations',
    public: 'Without a credential',
    auth: 'Account and passkeys',
    'api-keys': 'API keys',
    keychain: 'Keychain',
    live: 'Live streams',
  },
  mcp: {
    title: 'MCP tool catalog',
    description:
      'Every tool the reverse MCP server exposes, with its name, route, permission and confirmation requirements.',
    intro: [
      'This page is generated from the reverse MCP server tool catalog of the same commit. The server derives each tool name from the same Admin surface, truncating a name longer than 64 characters and adding a numeric suffix to resolve a collision.',
      "Account, credential, API-key and Keychain routes are excluded as a class: neither `/api` nor `/mcp` offers a tool for them. Every tool accepts `dry_run`, and a tool adds only the arguments its own route needs: `body` for a route with a request body, `if_match` for a revisioned route, `confirm` for a destructive or billed one, plus that route's path and query parameters. A tool's schema sets `additionalProperties: false`, so an argument it does not declare is rejected rather than ignored. Protocol, authentication and resources are documented in [MCP server](mcp-server.md).",
    ],
  },
  cli: {
    title: 'Client CLI command catalog',
    description: 'The generic commands surowan-utils derives from the same Admin surface.',
    intro: [
      'This page is generated from the Admin surface of the same commit and lists the **generic** commands — the `PANEL_SPECS` subset, one command per `/api` route. It is not the whole CLI: the session-only routes have no command, and first-class commands such as `invocation list`, `models list`, `login`, `auth`, `doctor` and `commands` are documented in [Client CLI](client-cli.md).',
      "Two commands can share one route — `telegram token` and `telegram token clear` both `PUT /api/telegram`, the second with a fixed body — so each gets its own row. The table matches `surowan-utils commands --json`; the plain `commands` output prints only the command, the method and the summary. The **If-Match** column says how a command fills the header: `config` is read from `GET /api/providers`, `prompt` from that prompt's current hash, and `entry` requires an explicit `--if-match`.",
    ],
  },
  sourceSummary: "The summary column repeats the route's own sentence from the surface table.",
  excludedRoutes: (count) =>
    `The ${count} routes without a tool are the account, credential and API-key routes plus deliberate MCP exclusions; their HTTP form is in the [panel session catalog](http/endpoints-session.md).`,
};
