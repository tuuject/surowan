/**
 * Declarative description of the Admin Panel surface the CLI mirrors.
 *
 * The panel's `/api` routes are the contract: every row names one route, how
 * its path is filled in, which query flags it forwards, and whether it needs an
 * optimistic-concurrency revision. Keeping this as data (rather than a bespoke
 * parser per command) is what makes "the CLI can do what the panel can do"
 * auditable: one panel endpoint is one row.
 *
 * Bodies are not modelled field by field. Every body-bearing route accepts
 * `--set key=value` (string), `--set-json key=<json>` (any JSON value) and a
 * whole-document `--file <path>` / `--body <json>`. The server validates the
 * shape, so the CLI never invents a second, drifting copy of a schema.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Where the `If-Match` value comes from when the caller does not pin one.
 *
 * - `config`: the SHA-256 of `config.jsonc`, read from `GET /api/providers`.
 * - `prompt`: the prompt content hash, read from the prompt view for the scope
 *   the command names.
 * - `entry`: the row's own revision, which only the caller's last read knows,
 *   so `--if-match` is required.
 */
export type RevisionKind = 'config' | 'prompt' | 'entry';

/** Operations that lose data or spend money; they require `--yes`. */
export type ConfirmKind = 'destructive' | 'paid';

export type ResponseKind = 'json' | 'binary' | 'text';

/**
 * The permission a programmatic API key must hold for a route.
 *
 * `read` is always available because every key carries `read:all`.
 * `write` changes system state without spending external resources.
 * `paid` spends external resources without changing local state.
 * `write+paid` does both, so both optional grants are required.
 */
export type AdminAccess = 'read' | 'write' | 'paid' | 'write+paid';

export interface PositionalArg {
  /** Placeholder name used in `path` as `:name`. */
  readonly name: string;
  /**
   * `decimal` rejects anything but a signed 64-bit decimal integer; `enum`
   * restricts the value to `values`; `text` is passed through and encoded.
   */
  readonly kind: 'decimal' | 'enum' | 'text';
  readonly values?: readonly string[];
  readonly optional?: boolean;
}

export interface EndpointSpec {
  /** Space-separated command path, e.g. `chat delete`. */
  readonly command: string;
  readonly method: HttpMethod;
  /** API path below `/api`, with `:name` placeholders for positionals. */
  readonly path: string;
  readonly positional?: readonly PositionalArg[];
  /** Query flags this route forwards, as `flag` or `flag=queryKey`. */
  readonly params?: readonly string[];
  /**
   * The route takes a JSON body (`--set`, `--file` or `--body`). `optional`
   * routes accept a request with no body at all.
   */
  readonly body?: boolean | 'optional';
  /**
   * Routes whose body is one long text field (the prompt editors) accept a raw
   * document through `--file`/`-`, which is stored under this key. `--set` may
   * still supply the sibling fields, e.g. `--set note=...`.
   */
  readonly fileField?: string;
  /** A body the route always takes; the caller provides no fields. */
  readonly fixedBody?: unknown;
  /**
   * Body fields whose `null` deletes data that another row clears behind
   * `--yes`, mapped to that row's command. This row refuses the `null`, so
   * the confirmation cannot be bypassed through a generic body flag.
   */
  readonly nullClearedBy?: Readonly<Record<string, string>>;
  readonly revision?: RevisionKind;
  readonly confirm?: ConfirmKind;
  readonly response?: ResponseKind;
  /**
   * What the route does to the caller's own session. `save` persists the token
   * the response sets (the server revokes every session and issues a new one);
   * `clear` deletes the stored credential because the session is gone.
   */
  readonly session?: 'save' | 'clear';
  /**
   * The route requires `Origin` to equal `admin.public_url` exactly (the
   * passkey and password routes). The CLI sends the endpoint's own origin, so
   * these commands work when the endpoint is that public URL.
   */
  readonly origin?: boolean;
  /** One line shown by `commands`; states what the panel action does. */
  readonly summary: string;
  /**
   * Permission override. Omitted means `GET` is `read` and every other method
   * is `write`; read-shaped POSTs and paid operations set it explicitly.
   */
  readonly access?: AdminAccess;
  /**
   * False for routes the CLI already implements as first-class commands
   * (invocation list/get/replay, models list, config/prompt views). They still
   * belong to the surface so the MCP server can expose them.
   */
  readonly cli?: false;
  /** False for account, credential and API-key management, which keys never reach. */
  readonly mcp?: false;
}

/** A parsed panel command: the table row plus the values that fill it in. */
export interface PanelCommand {
  readonly kind: 'panel';
  readonly spec: EndpointSpec;
  readonly positionals: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** `undefined` when the route has no body. */
  readonly body: unknown;
  readonly ifMatch: string | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly output: string | undefined;
}
