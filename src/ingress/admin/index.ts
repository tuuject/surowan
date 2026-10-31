import { join, resolve } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { type ServerType, serve } from '@hono/node-server';
import type { MediaDownloader } from '../../capabilities/media/download.ts';
import type { ImageBridge } from '../../image/bridge.ts';
import type { ImageService } from '../../image/service.ts';
import type { AgentModelSwitcher } from '../../platform/models/switch.ts';
import type { BucketScheduler } from '../../orchestration/scheduler/index.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import type { ImConnectionRegistry } from '../../platform/im-connection.ts';
import type { ConfigController } from '../../platform/config/write.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { LongTaskService } from '../../store/long-tasks/index.ts';
import type { MemoBlobStore } from '../../context/memo-pad/blobs.ts';
import type { BusinessStore } from '../../store/store.ts';
import { WarningService } from '../../store/warnings.ts';
import { type AdminRoutes, createAdminRoutes } from './routes/index.ts';
import { closeServer, json, parseOriginHost, redact } from './http.ts';
import { AdminQueryError } from './audit/shared.ts';
import { AdminAuth, AdminAuthError } from './auth.ts';
import { AdminPasskeys } from './passkeys.ts';
import type { PlaygroundAdminDeps } from './playground/index.ts';
import type { SearchProviderRule } from '../../platform/web-search.ts';

export type AdminConfig = NonNullable<RawConfig['admin']>;

/** Replay-only template and model overrides. Runtime protocol and other fixed prompt parts are never writable. */
export interface ReplayInvocationInput {
  readonly global_prompt?: string;
  readonly group_prompt?: string;
  readonly before_send_id?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking_level?: ModelThinkingLevel;
}

/** The read-only replay selection a preflight accepts; absent model fields inherit the Chat settings. */
export type ReplayPreflightSelection = Pick<
  ReplayInvocationInput,
  'before_send_id' | 'provider' | 'model' | 'thinking_level'
>;

export interface AdminServerOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  /** Live IM connection state; absent in standalone panels, which report disabled. */
  readonly connections?: ImConnectionRegistry;
  readonly scheduler?: BucketScheduler;
  readonly tasks?: LongTaskService;
  readonly modelSwitcher?: AgentModelSwitcher;
  readonly configReloader?: ConfigController;
  /** Memo Pad blob storage; absent uses the configured `data_dir`. */
  readonly memoBlobs?: MemoBlobStore;
  /** Registers panel-supplied plaintext secrets before they are written or sent. */
  readonly secrets?: SecretStore;
  /** Image generation service; absent when the host runs without one. */
  readonly imageService?: ImageService;
  /** The image bridge; absent without image generation. */
  readonly imageBridge?: ImageBridge;
  /** Playground rooms: store, write ingress and local picture store. */
  readonly playground?: PlaygroundAdminDeps;
  /** Starts the graceful shutdown that exits with the restart code. */
  readonly requestRestart?: () => void;
  /** Replays one audit invocation; absent when the agent runtime is not wired. */
  readonly replayInvocation?: (id: bigint, input: ReplayInvocationInput, signal: AbortSignal) => Promise<unknown>;
  /** Read-only replay checks and retained editable templates; neither calls a model. */
  readonly replayPreflight?: (id: bigint, selection?: ReplayPreflightSelection) => unknown;
  readonly invocationPrompts?: (id: bigint) => unknown;
  /** Telegram bytes stay on the server; the caller can only name invocation-associated media IDs. */
  readonly mediaDownloader?: MediaDownloader;
  readonly shutdownSignal?: AbortSignal;
  /** Shared with the scheduler so invocations and login attempts feed the same warnings. */
  readonly warnings?: WarningService;
  /** Search providers registered by the loaded plugins; absent uses the bundled set. */
  readonly searchProviders?: readonly SearchProviderRule[];
}

export class AdminServer {
  readonly #admin: AdminConfig;
  readonly #auth: AdminAuth;
  readonly #passkeys: AdminPasskeys | undefined;
  readonly #secrets: SecretStore | undefined;
  readonly #healthAbort = new AbortController();
  readonly #healthChecks = new Set<Promise<unknown>>();
  readonly #routes: AdminRoutes;
  #server: ServerType | undefined;
  #payloadClear: Promise<number> | undefined;

  constructor(options: AdminServerOptions) {
    const config = options.configStore.current().config;
    const admin = config.admin;
    this.#admin = admin;
    const warnings = options.warnings ?? new WarningService(options.store.orm);
    this.#auth = new AdminAuth(options.store.orm, admin.session_ttl_hours, warnings);
    this.#passkeys =
      admin.public_url === undefined ? undefined : new AdminPasskeys(options.store.orm, this.#auth, admin.public_url);
    this.#secrets = options.secrets;
    this.#routes = createAdminRoutes({
      options,
      staticDir: resolve(admin.static_dir ?? join(import.meta.dirname, '..', '..', '..', 'apps', 'admin-next', 'dist')),
      auth: this.#auth,
      passkeys: this.#passkeys,
      healthSignal: AbortSignal.any([
        this.#healthAbort.signal,
        ...(options.shutdownSignal === undefined ? [] : [options.shutdownSignal]),
      ]),
      healthChecks: this.#healthChecks,
      warnings,
      payloadClear: {
        current: () => this.#payloadClear,
        set: (value) => {
          this.#payloadClear = value;
        },
      },
    });
  }

  async start(): Promise<{ readonly hostname: string; readonly port: number }> {
    if (this.#server !== undefined) {
      throw new Error('Admin server is already listening');
    }
    this.#auth.purgeExpired();
    const server = serve({
      // The socket address, not a forwarded header: a caller controls
      // X-Forwarded-For, so keying the login throttle on it let every attempt
      // pick a fresh bucket.
      fetch: (request, env) =>
        this.handle(request, 'incoming' in env ? (env.incoming.socket.remoteAddress ?? 'unknown') : 'unknown'),
      hostname: this.#admin.host,
      port: this.#admin.port,
      serverOptions: {
        // Idle header waiting and idle keep-alive sockets are cut at 30s, while
        // slow but actively streaming responses are not interrupted.
        headersTimeout: 30_000,
        keepAliveTimeout: 30_000,
      },
    });
    this.#server = server;
    try {
      // @hono/node-server binds asynchronously, so wait for the event before
      // treating the panel as listening. The error listener surfaces bind
      // failures such as EADDRINUSE instead of leaving only an unhandled
      // 'error' event on stderr.
      const { promise, resolve: settle, reject } = Promise.withResolvers<void>();
      server.once('listening', settle);
      server.once('error', reject);
      await promise;
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Admin server did not report a listening address');
    }
    return { hostname: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#healthAbort.abort(new Error('Admin server is stopping'));
    await Promise.allSettled(this.#healthChecks);
    await this.#payloadClear?.catch(() => undefined);
    if (server === undefined) {
      return;
    }
    await closeServer(server);
  }

  /** `clientAddress` is the transport peer; tests calling this directly share one. */
  async handle(request: Request, clientAddress = 'local'): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    try {
      if (segments[0] === 'api') {
        return await this.#api(request, url, segments.slice(1), clientAddress);
      }
      return await this.#routes.static(request, segments);
    } catch (error) {
      if (error instanceof AdminAuthError || error instanceof AdminQueryError) {
        return json(
          { error: redact(this.#secrets, error.code), message: redact(this.#secrets, error.message) },
          error.status,
        );
      }
      console.error(
        JSON.stringify({
          event: 'admin_request_failed',
          path: redact(this.#secrets, url.pathname),
          error: redact(this.#secrets, error),
          at: new Date().toISOString(),
        }),
      );
      return json({ error: 'internal_error', message: 'Admin request failed' }, 500);
    }
  }

  /**
   * The `/api` dispatch contract: method and Origin gates, the API-key surface,
   * the session gate, then the route groups in their fixed order. A group that
   * does not recognise the path returns `undefined` and the next one runs.
   */
  async #api(request: Request, url: URL, segments: readonly string[], clientAddress: string): Promise<Response> {
    if (
      request.method !== 'GET' &&
      request.method !== 'POST' &&
      request.method !== 'PUT' &&
      request.method !== 'DELETE'
    ) {
      return json({ error: 'method_not_allowed', message: 'Unsupported method' }, 405);
    }
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
      const origin = request.headers.get('origin');
      if (origin !== null) {
        const originHost = parseOriginHost(origin);
        if (originHost === null) {
          return json({ error: 'bad_origin', message: 'Origin header is malformed' }, 400);
        }
        if (this.#passkeys === undefined ? originHost !== url.host : origin !== this.#passkeys.origin) {
          return json(
            {
              error: 'bad_origin',
              message:
                this.#passkeys === undefined
                  ? 'Cross-origin admin requests are rejected'
                  : 'Open the exact origin configured in admin.public_url to use this panel',
            },
            403,
          );
        }
      }
    }
    const routes = this.#routes;
    // Authorization never falls back to a panel cookie. The fixed programmatic
    // surface includes inspection reads and invocation replay, not panel writes.
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      return await routes.inspection.apiKeyRequest(request, url, segments, authorization);
    }
    const authenticated = await routes.auth.handle(request, url, segments, clientAddress);
    if (authenticated.kind === 'response') {
      return authenticated.response;
    }
    const username = authenticated.session.username;
    let response = await routes.control.handle(request, segments, username);
    response ??= await routes.tuning.handle(request, segments);
    response ??= await routes.dictionary.handle(request, url, segments);
    response ??= await routes.search.handle(request, url, segments);
    response ??= await routes.memory.handle(request, url, segments);
    response ??= await routes.admins.handle(request, segments);
    response ??= await routes.providers.handle(request, segments);
    response ??= await routes.chats.handle(request, segments);
    // `GET prompts/global` / `prompts/group` stay on the shared inspection
    // surface; this dispatch returns `undefined` for them.
    response ??= await routes.prompts.handle(request, url, segments, username);
    response ??= await routes.playground.handle(request, url, segments, username);
    response ??= await routes.image.handle(request, url, segments, username);
    response ??= await routes.telegram.handle(request, segments);
    response ??= await routes.warnings.handle(request, url, segments);
    if (response !== undefined) {
      return response;
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed', message: 'Audit routes are read-only' }, 405);
    }
    response = await routes.inspection.inspect(request, url, segments);
    response ??= await routes.inspection.list(url, segments);
    if (response !== undefined) {
      return response;
    }
    return json({ error: 'not_found', message: 'Unknown admin API route' }, 404);
  }
}
