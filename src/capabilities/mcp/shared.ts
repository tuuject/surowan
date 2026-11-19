/**
 * Values the MCP manager and its topic modules share: what one publish did to
 * the server instances, how one resolved per-Chat tool set is grouped, and the
 * mutable state the connection and tool-set modules read and write.
 */
import type { RawConfig } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import type { BusinessStore } from '../../store/store.ts';
import type { ManagedServer, McpToolDefinition, RegistryValidator } from './support.ts';

/** One server alias a publish added, replaced or removed. */
export interface McpServerChange {
  readonly alias: string;
  /** Redacted failure of a hot-added or hot-changed server; absent when it connected. */
  readonly error?: string;
}

/** What one published configuration did to the server instances. */
export interface McpServerReconcileResult {
  readonly added: readonly string[];
  readonly replaced: readonly string[];
  readonly removed: readonly string[];
  /** Servers that did not come up; each is degraded and reconnecting on its own backoff. */
  readonly failed: readonly McpServerChange[];
  /** True: a newer generation was already adopted, so nothing moved. */
  readonly stale: boolean;
}

/** A distinct per-Chat tool set and the Chats that resolve to it. */
export interface ToolSetResolution {
  /** The host whose configured Chats resolve to this set; a set never spans hosts. */
  readonly host: HostKind;
  readonly chatIds: readonly number[];
  readonly definitions: readonly McpToolDefinition[];
}

/** The mutable half of the manager, shared by its topic modules. */
export interface McpState {
  readonly store: BusinessStore;
  readonly secrets: SecretStore;
  readonly servers: Map<string, ManagedServer>;
  /**
   * The published configuration the Chat bindings are read from. `reconcile`
   * replaces it together with the server instances, so a tool set is always one
   * configuration's view and never a mixture of two.
   */
  config: RawConfig;
  /**
   * The published generation `config` came from. A cutover that finishes after
   * a newer configuration was published must not move the instances back.
   */
  generation: number;
  registryValidator: RegistryValidator | undefined;
  /**
   * Process-level event log for degraded/recovered transitions; absent in
   * harnesses that do not care about the operator log.
   */
  log: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  stopping: boolean;
}
