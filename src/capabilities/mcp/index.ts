/**
 * The MCP manager: one object per process, one client per configured alias.
 *
 * The work is split by topic: `connection.ts` owns connecting, discovering and
 * disconnecting one server, `reconcile.ts` adopts a published server list, and
 * `tool-sets.ts` resolves and validates what one Chat may call. This file keeps
 * the manager's own state, the registry-validation policy (61 tools plus the
 * model fit) and the public surface the composition root uses.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ManagedServer, RegistryValidator } from './support.ts';
import type { RawConfig } from '../../platform/config/index.ts';
import { hostExecutionProfile } from '../../platform/host-profile.ts';
import { type InvocationContext, previewContext } from '../../platform/invocation-context.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { McpServerAvailability } from '../../platform/warning-catalog.ts';
import { type BusinessStore, resolveChatConfig } from '../../store/store.ts';
import { localImageAssets } from '../media/local-assets.ts';
import type { McpCallDeps } from './calls.ts';
import {
  connect,
  isCurrent,
  managedServer,
  type Revalidate,
  scheduleReconnect,
  setState,
  stopServer,
} from './connection.ts';
import { reconcile } from './reconcile.ts';
import type { McpServerReconcileResult, McpState } from './shared.ts';
import {
  assertConfigBindings,
  buildTools,
  chatTools,
  definitions,
  resolutions,
  validateResolution,
} from './tool-sets.ts';

export class McpManager {
  readonly #state: McpState;
  readonly #callDeps: McpCallDeps;

  constructor(store: BusinessStore, config: RawConfig, secrets: SecretStore, log?: McpState['log']) {
    const servers = new Map<string, ManagedServer>();
    this.#state = {
      store,
      secrets,
      servers,
      config,
      generation: 0,
      registryValidator: undefined,
      log,
      stopping: false,
    };
    this.#callDeps = {
      store,
      assets: localImageAssets(store.orm, config.data_dir),
      isCurrent: (server) => isCurrent(this.#state, server),
      setState: (server, state, errorCode, detail) => setState(this.#state, server, state, errorCode, detail),
      scheduleReconnect: (server) => scheduleReconnect(this.#state, server, this.#revalidate),
    };
    for (const serverConfig of config.mcp?.servers ?? []) {
      servers.set(serverConfig.alias, managedServer(serverConfig));
    }
  }

  /**
   * Startup never waits for or fails on MCP: every server connects in the
   * background with the usual backoff, so `serve` reaches the scheduler and
   * the Admin Panel even when every endpoint black-holes. A server that
   * cannot be reached simply stays `degraded` until it recovers.
   */
  start(): Promise<void> {
    this.#state.stopping = false;
    for (const server of this.#state.servers.values()) {
      void (async () => {
        try {
          await connect(this.#state, server, true, this.#revalidate);
        } catch (error) {
          // A stop() racing the attempt already persisted `stopped`; reporting
          // the failure now would overwrite it — and write to a closed store.
          if (this.#state.stopping) {
            return;
          }
          setState(this.#state, server, 'degraded', 'initialization_failed', error);
          scheduleReconnect(this.#state, server, this.#revalidate);
        }
      })();
    }
    return Promise.resolve();
  }

  /**
   * The live per-alias state the Admin Panel's standing warnings read. The
   * map only holds the published configuration's aliases, so a removed server
   * cannot ghost-report; the `mcp_server_state` table is a worse source here
   * because it keeps rows for aliases that left the configuration.
   */
  serverStates(): McpServerAvailability[] {
    return [...this.#state.servers.values()].map((server) => ({
      alias: server.config.alias,
      state: server.state,
      error_code: server.errorCode,
      next_reconnect_at: server.nextReconnectAt,
      // A `starting` that is a retry still belongs to the outage it is
      // recovering from; a first connect after boot is not one.
      retrying: server.state === 'starting' && server.degradedNotified,
    }));
  }

  setRegistryValidator(validator: RegistryValidator): void {
    this.#state.registryValidator = validator;
    this.#validateResolutions();
  }

  /**
   * The tools one invocation may reach. The Chat binding is resolved from the
   * configuration that invocation runs under (its snapshot), never from the
   * instances' own view of the published file: the scheduler launches work
   * against the published configuration before this manager has reconciled, so
   * a Chat added with `mcp: []` in that window must reach nothing.
   */
  createTools(context: InvocationContext, invocationDeadline: number, config: RawConfig): readonly AgentTool[] {
    // The host profile decides what a host may reach; a Playground room never
    // inherits MCP just because a server is configured.
    if (!hostExecutionProfile(context.hostKind).mcp) {
      return [];
    }
    return chatTools(this.#state, config, this.#callDeps, context, invocationDeadline);
  }

  /**
   * The exposed tool names one Chat reaches under `config` with the instances
   * connected now. The MCP cutover reads it with the previous configuration
   * before it stops anything, so it can name the calls a stopped run left
   * unresolved.
   */
  toolNamesForChat(chatId: bigint, config: RawConfig): string[] {
    const chat = resolveChatConfig(config, this.#state.store.orm, chatId);
    return chat === undefined
      ? []
      : definitions(this.#state, config, chat, { includeUnavailable: true }).map(
          (definition) => definition.exposedName,
        );
  }

  /**
   * Adopts a published configuration: Chat bindings apply from now on, and each
   * server alias is added, replaced or stopped on its own. An unchanged alias
   * keeps its client — and any call running on it — untouched.
   */
  async reconcile(published: {
    readonly config: RawConfig;
    readonly generation: number;
  }): Promise<McpServerReconcileResult> {
    return await reconcile(this.#state, published, this.#revalidate);
  }

  async stop(): Promise<void> {
    this.#state.stopping = true;
    for (const server of this.#state.servers.values()) {
      await stopServer(this.#state, server);
    }
  }

  /**
   * Every distinct tool set one configuration produces, with the Telegram Chats
   * that resolve to it. The reload path calls this with a candidate before it
   * becomes active, so a model is only asked to fit the sets its own Chats get.
   * Definitions come from the connected servers, so a server the candidate adds
   * appears only after `reconcile` has connected it.
   */
  toolSets(config: RawConfig): { readonly chatIds: readonly number[]; readonly tools: readonly AgentTool[] }[] {
    // Configuration validation can only check a binding against an explicit
    // server list; a wildcard server's names are known once it has discovered
    // them. An unchanged connected server will not reconnect, so its binding is
    // checked here instead of never.
    assertConfigBindings(this.#state, config);
    return resolutions(this.#state, config).map((resolution) => ({
      chatIds: resolution.chatIds,
      tools: buildTools(this.#callDeps, resolution.definitions, previewContext(), Number.MAX_SAFE_INTEGER),
    }));
  }

  readonly #revalidate: Revalidate = (): void => {
    this.#validateResolutions();
  };

  #validateResolutions(): void {
    for (const resolution of resolutions(this.#state, this.#state.config)) {
      validateResolution(this.#state, this.#callDeps, resolution);
    }
  }
}
