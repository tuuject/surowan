import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import { type ConfigChange, type ConfigSource, diffConfig } from '../../../platform/config/diff.ts';
import type { FileConfig, RawConfig, SecretRef } from '../../../platform/config/index.ts';
import { validateSemantics } from '../../../platform/config/semantics.ts';
import type { ConfigApplyResult, ConfigErrorCode, ConfigErrorDetail } from '../../../platform/config/write.ts';
import { collectSecretReferences } from '../../../platform/keychain.ts';
import { buildModelRegistry, configuredAgentModels, secretRefsDigest } from '../../../platform/providers.ts';
import type { ConfigurationModels, RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import { SecretResolutionError, type SecretStore } from '../../../platform/secrets.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import { type TelegramTokenSource, telegramTokenIdentity } from '../telegram/connection-token.ts';
import { assertConfigPermissions, type LoadedConfig, loadConfig } from './index.ts';
import type { ImageConfigGateway, TelegramConfigGateway } from './reload.ts';

/** The mutable reload state the class owns and this module reads and writes. */
export type ConfigReloadState = {
  /** The file configuration the running process last adopted. */
  activeFile: FileConfig;
  fileHash: string;
  restartRequired: readonly string[];
  lastError: ConfigErrorDetail | null;
  /** Identity of the last published image snapshot; detects keychain-only rotations. */
  imageSnapshotId: string | null;
  /** Identity of the last published Telegram token source; null before the first apply. */
  telegramTokenId: string | null;
  /** Per-alias SecretRef digest each provider in the registry was built from. */
  providerKeyDigests: Readonly<Record<string, string>>;
  /**
   * Whether the digest state describes the currently running providers. A
   * reloader started without the startup digests seeds them on its first
   * apply instead of comparing against nothing.
   */
  digestsSeeded: boolean;
  /** Per-entry digest of every jar reference the last adopted configuration carried. */
  jarDigests: Readonly<Record<string, string>>;
  /** Per-MCP-alias digest of the jar references its env/headers carried. */
  mcpServerKeyDigests: Readonly<Record<string, string>>;
  /** Whether the MCP digest state describes the running servers (seeded at startup). */
  mcpDigestsSeeded: boolean;
  /**
   * Rotated MCP aliases whose publish hook has not succeeded yet: the retry
   * apply passes them again, so a failed hook never swallows a rotation.
   */
  pendingMcpRotations: ReadonlySet<string>;
  /**
   * The configuration is published but the publish hook has not completed. The
   * next apply reruns the hook even when the file did not change, so a failed
   * cutover is retried instead of being skipped by the unchanged early return.
   */
  publicationPending: boolean;
};

/**
 * What one apply needs from the reloader. `state` is the reloader's own object, so
 * every assignment here is visible to `status()` and the report helpers below.
 */
export type ConfigApplyDeps = {
  readonly configPath: string;
  readonly store: RuntimeConfigurationStore;
  readonly state: ConfigReloadState;
  readonly secrets: SecretStore;
  readonly imageConfig: ImageConfigGateway | undefined;
  readonly telegramConfig: TelegramConfigGateway | undefined;
  /** Registered search providers; missing means the bundled set. */
  readonly searchProviders?: readonly SearchProviderRule[];
  /**
   * Throws when the tool registry does not fit the model's context window.
   * `config` is the candidate, so per-Chat tool sets can be resolved for it.
   */
  readonly validateAgentModel: (config: RawConfig, model: Model<Api>) => void;
  /**
   * Called after every successful publish; awaited by `applyFile`. It may throw
   * after doing part of its work: it must be safe to call again for the same
   * configuration, which is how a pending publication is retried. `rotated`
   * names the MCP aliases whose secret references changed value in this apply,
   * so the publisher reconnects them like a hot server change.
   */
  readonly onPublished: (info: { readonly rotatedMcpAliases: readonly string[] }) => void | Promise<void>;
  readonly failure: (code: ConfigErrorCode, message: string, fileWritten: boolean) => ConfigApplyResult;
  readonly applied: (
    applied: readonly string[],
    restartRequired: readonly string[],
    outsideServe: readonly string[],
  ) => ConfigApplyResult;
  readonly logReloaded: (
    applied: readonly string[],
    restartRequired: readonly string[],
    outsideServe: readonly string[],
  ) => void;
};

export async function applyFile(deps: ConfigApplyDeps): Promise<ConfigApplyResult> {
  const { configPath, state } = deps;
  const active: ConfigSource = { file: state.activeFile, raw: deps.store.current().config };
  try {
    await assertConfigPermissions(configPath);
  } catch (error) {
    return deps.failure('config_permissions', messageOf(error), false);
  }
  let file: LoadedConfig;
  try {
    file = await loadConfig(configPath, {
      ...(deps.searchProviders === undefined ? {} : { searchProviders: deps.searchProviders }),
    });
  } catch (error) {
    return deps.failure('config_invalid', messageOf(error), false);
  }
  const fromFile: ConfigSource = { file: file.fileConfig, raw: file.config };
  const diff = diffConfig(active, fromFile);
  try {
    validateSemantics(diff.candidate.file, {
      ...(deps.searchProviders === undefined ? {} : { searchProviders: deps.searchProviders }),
    });
  } catch (error) {
    // The file is valid on its own, so the next startup is fine; only this
    // process cannot adopt it while the restart-only fields are still pending.
    const pendingRestart = pathsOf(diff.changes, 'restart');
    const pending = pendingRestart.length === 0 ? '' : ` Pending restart paths: ${pendingRestart.join(', ')}.`;
    return deps.failure(
      'candidate_invalid',
      `The file itself is valid, but it is not valid together with the restart-only fields still pending in this process; those take effect together after a restart. ${messageOf(error)}${pending}`,
      false,
    );
  }
  const rebuilt = await buildRegistry(deps, diff.candidate.raw);
  if (!rebuilt.ok) {
    return deps.failure(rebuilt.code, rebuilt.error, false);
  }
  try {
    for (const { model } of configuredAgentModels(diff.candidate.raw, rebuilt.registry.models)) {
      deps.validateAgentModel(diff.candidate.raw, model);
    }
  } catch (error) {
    return deps.failure('model_unusable', messageOf(error), false);
  }
  const jarDigests = await jarEntryDigests(diff.candidate.raw, deps.secrets);
  const mcpDigests = await mcpServerKeyDigests(diff.candidate.raw, deps.secrets);
  // A keychain rotation changes the resolved value without touching the file,
  // exactly as it does for image credentials, so the digests participate in
  // "did anything change" as well: the rebuilt registry must be published.
  // A reloader that started without the startup digests seeds them here and
  // compares from the next apply on.
  const keyRotated =
    deps.state.digestsSeeded &&
    Object.entries(rebuilt.registry.keyDigests ?? {}).some(
      ([alias, digest]) =>
        deps.state.providerKeyDigests[alias] !== undefined && deps.state.providerKeyDigests[alias] !== digest,
    );
  deps.state.digestsSeeded = true;
  // MCP servers whose secret references rotated reconnect through the hot
  // cutover exactly like a changed server — never waiting for a restart.
  // A reloader that started without the MCP digests seeds them here too.
  // Rotations whose publish hook has not succeeded yet are carried forward:
  // the retry apply passes the same alias again so the reconnect happens.
  const stillWanted = new Set((diff.candidate.raw.mcp?.servers ?? []).map((server) => server.alias));
  const rotatedMcpAliases = [
    ...new Set([
      ...rotatedAliases(deps.state.mcpServerKeyDigests, mcpDigests, deps.state.mcpDigestsSeeded),
      ...[...deps.state.pendingMcpRotations].filter((alias) => stillWanted.has(alias)),
    ]),
  ];
  deps.state.mcpDigestsSeeded = true;
  // Track them before the hook runs: a failed hook leaves them pending for the
  // retry apply, which then passes the same alias again.
  if (rotatedMcpAliases.length > 0) {
    deps.state.pendingMcpRotations = new Set([...deps.state.pendingMcpRotations, ...rotatedMcpAliases]);
  }
  // The image candidate is prepared with every apply — including ones where
  // the file is unchanged — so a keychain rotation is picked up by the next
  // explicit reload even though the configuration file hash did not move.
  let imageSnapshot: unknown;
  let imageSnapshotId: string | null;
  if (deps.imageConfig === undefined) {
    imageSnapshot = undefined;
    imageSnapshotId = null;
  } else {
    try {
      imageSnapshot = await deps.imageConfig.prepare(diff.candidate.raw);
    } catch (error) {
      const code = error instanceof SecretResolutionError ? 'secret_unresolved' : 'config_invalid';
      return deps.failure(code, messageOf(error), false);
    }
    // `undefined` (no image section) is the disabled state with its own
    // stable identity, so disabling and re-enabling each count as changes.
    imageSnapshotId =
      imageSnapshot === undefined
        ? 'disabled'
        : createHash('sha256').update(JSON.stringify(imageSnapshot)).digest('hex').slice(0, 32);
  }
  const imageChanged = imageSnapshotId !== state.imageSnapshotId;
  // A keychain rotation changes the token without touching the file, exactly as
  // it does for the image credentials, so the source identity participates in
  // "did anything change" as well.
  let telegramSource: TelegramTokenSource | undefined;
  let telegramTokenId: string | null = null;
  if (deps.telegramConfig !== undefined) {
    telegramSource = await deps.telegramConfig.prepare(diff.candidate.raw);
    telegramTokenId = telegramTokenIdentity(telegramSource);
  }
  const telegramChanged = telegramTokenId !== state.telegramTokenId;
  const applied = [...pathsOf(diff.changes, 'hot'), ...(rotatedMcpAliases.length > 0 ? ['mcp.servers'] : [])];
  const outsideServe = pathsOf(diff.changes, 'outside_serve');
  const restartRequired = pathsOf(diff.changes, 'restart');
  const changed =
    applied.length > 0 ||
    outsideServe.length > 0 ||
    imageChanged ||
    telegramChanged ||
    keyRotated ||
    rotatedMcpAliases.length > 0;
  const currentHash = deps.store.current().hash;
  // With nothing pending, the candidate is exactly the file, so its hash is the
  // file hash and stays comparable with `check-config` output. With fields
  // pending, a changed candidate matches no file version and gets a hash of its
  // own, while an unchanged one keeps the identity it already has.
  const activeHash =
    restartRequired.length === 0
      ? file.hash
      : changed
        ? createHash('sha256').update(JSON.stringify(diff.candidate.raw)).digest('hex')
        : currentHash;
  if (!changed && activeHash === currentHash) {
    // Nothing to publish, but the file hash and the pending list still move.
    state.fileHash = file.hash;
    state.restartRequired = restartRequired;
    state.lastError = null;
    state.telegramTokenId = telegramTokenId;
    state.providerKeyDigests = rebuilt.registry.keyDigests ?? {};
    state.jarDigests = jarDigests;
    state.mcpServerKeyDigests = mcpDigests;
    if (state.publicationPending) {
      const unfinished = await finishPublication(deps, rotatedMcpAliases);
      if (unfinished !== undefined) {
        return unfinished;
      }
    }
    deps.logReloaded(applied, restartRequired, outsideServe);
    return deps.applied(applied, restartRequired, outsideServe);
  }
  // Reaching here without a changed field means only the hash moved: the active
  // configuration now equals a different file version, e.g. after a pending
  // field was reverted or only a comment was edited. Publishing the equal
  // candidate adopts that identity.
  // Synchronous from here on: the registry and the configuration are published
  // together, and no run can observe one without the other.
  deps.store.publish({
    config: diff.candidate.raw,
    hash: activeHash,
    models: rebuilt.registry.models,
    visionModel: rebuilt.registry.visionModel,
    ...(rebuilt.registry.keyDigests === undefined ? {} : { keyDigests: rebuilt.registry.keyDigests }),
  });
  state.activeFile = diff.candidate.file;
  state.fileHash = file.hash;
  state.restartRequired = restartRequired;
  state.lastError = null;
  state.providerKeyDigests = rebuilt.registry.keyDigests ?? {};
  state.jarDigests = jarDigests;
  state.mcpServerKeyDigests = mcpDigests;
  if (deps.imageConfig !== undefined) {
    // Same synchronous section as the configuration publish: no run can
    // observe a configuration whose image snapshot has not been swapped.
    // `undefined` publishes the disabled state: a missing (or stripped)
    // image section is a valid target state, not an error.
    deps.imageConfig.publish(imageSnapshot);
  }
  state.imageSnapshotId = imageSnapshotId;
  if (deps.telegramConfig !== undefined && telegramSource !== undefined) {
    // Also synchronous: the manager may start a stop pass, but it never waits
    // for `getMe` before this apply returns.
    deps.telegramConfig.publish(telegramSource);
  }
  state.telegramTokenId = telegramTokenId;
  const unfinished = await finishPublication(deps, rotatedMcpAliases);
  if (unfinished !== undefined) {
    return unfinished;
  }
  deps.logReloaded(applied, restartRequired, outsideServe);
  return deps.applied(applied, restartRequired, outsideServe);
}

/**
 * Runs the publish hook. A failure is reported as `publish_incomplete`: the new
 * configuration is already active, so the caller must not read it as "nothing
 * changed", and the pending flag makes the next apply retry the hook.
 */
async function finishPublication(
  deps: ConfigApplyDeps,
  rotatedMcpAliases: readonly string[],
): Promise<ConfigApplyResult | undefined> {
  deps.state.publicationPending = true;
  try {
    await deps.onPublished({ rotatedMcpAliases });
    // The hook succeeded: every alias it received has been handed to the
    // cutover, so nothing stays pending for the next apply.
    deps.state.pendingMcpRotations = new Set();
  } catch (error) {
    return deps.failure(
      'publish_incomplete',
      `The configuration is active, but finishing its publication failed; apply again to retry: ${messageOf(error)}`,
      false,
    );
  }
  deps.state.publicationPending = false;
  return undefined;
}

type BuildRegistryResult =
  | { readonly ok: true; readonly registry: ConfigurationModels }
  | { readonly ok: false; readonly code: ConfigErrorCode; readonly error: string };

/**
 * Builds the candidate's registry. Every provider keeps the connection the
 * running process already resolved unless the file describes a different one,
 * so this is the only place a reload may resolve a SecretRef — a `command`
 * reference therefore runs here, exactly as it does at startup.
 */
async function buildRegistry(deps: ConfigApplyDeps, candidate: RawConfig): Promise<BuildRegistryResult> {
  try {
    return {
      ok: true,
      registry: await buildModelRegistry(
        candidate,
        {
          file: deps.state.activeFile,
          models: deps.store.current().models,
          ...(deps.state.digestsSeeded && Object.keys(deps.state.providerKeyDigests).length > 0
            ? { keyDigests: deps.state.providerKeyDigests }
            : {}),
        },
        deps.secrets,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof SecretResolutionError ? 'secret_unresolved' : 'model_unusable',
      error: messageOf(error),
    };
  }
}

/** Current digest of every jar entry a configuration references. */
export async function jarEntryDigests(config: RawConfig, secrets: SecretStore): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const name of collectSecretReferences(config).jars.keys()) {
    digests[name] = await secrets.digestOf({ jar: name });
  }
  return digests;
}

/** Map of MCP server alias → the jar entries its env/headers references carry. */
function mcpServerSecretRefs(config: RawConfig): ReadonlyMap<string, readonly SecretRef[]> {
  const servers = config.mcp?.servers ?? [];
  const refs = new Map<string, SecretRef[]>();
  for (const server of servers) {
    // stdio servers carry `env`, Streamable HTTP ones carry `headers`.
    const references = 'env' in server ? server.env : 'headers' in server ? server.headers : undefined;
    if (references === undefined) {
      continue;
    }
    const entries: SecretRef[] = [];
    for (const [name, reference] of Object.entries(references)) {
      void name;
      if (typeof reference === 'object' && reference !== null && 'jar' in reference) {
        entries.push(reference);
      }
    }
    if (entries.length > 0) {
      refs.set(server.alias, entries);
    }
  }
  return refs;
}

/** Per-MCP-alias digest of the jar references its env/headers carry. */
export async function mcpServerKeyDigests(config: RawConfig, secrets: SecretStore): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const [alias, references] of mcpServerSecretRefs(config)) {
    digests[alias] = await secretRefsDigest(references, secrets);
  }
  return digests;
}

/**
 * The MCP aliases whose secret references rotated since the last adopted
 * configuration. Only `jar` refs participate (an `env`/`command` value is not
 * ours to observe, and checking never executes a command); an entry that was
 * unreadable before was never adopted, so its appearance is not a rotation. A
 * reloader that started without the MCP digests seeds them on its first apply
 * instead of flagging everything as rotated.
 */
export function rotatedAliases(
  previous: Readonly<Record<string, string>>,
  candidate: Readonly<Record<string, string>>,
  seeded: boolean,
): string[] {
  if (!seeded) {
    return [];
  }
  return Object.entries(candidate)
    .filter(([alias, digest]) => {
      const before = previous[alias];
      return before !== undefined && before !== 'missing' && before !== digest;
    })
    .map(([alias]) => alias);
}

function pathsOf(changes: readonly ConfigChange[], kind: ConfigChange['kind']): readonly string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
