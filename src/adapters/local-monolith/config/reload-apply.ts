import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { FileConfig, RawConfig } from '../../../platform/config/index.ts';
import { type ConfigChange, type ConfigSource, diffConfig } from '../../../platform/config/diff.ts';
import type { ConfigApplyResult, ConfigErrorCode, ConfigErrorDetail } from '../../../platform/config/write.ts';
import { buildModelRegistry, configuredAgentModels } from '../../../platform/providers.ts';
import type { ConfigurationModels, RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import { SecretResolutionError, type SecretStore } from '../../../platform/secrets.ts';
import { assertConfigPermissions, type LoadedConfig, loadConfig } from './index.ts';
import type { ImageConfigGateway, TelegramConfigGateway } from './reload.ts';
import { telegramTokenIdentity, type TelegramTokenSource } from '../telegram/connection-token.ts';
import { validateSemantics } from '../../../platform/config/semantics.ts';

/** The mutable reload state the class owns and this module reads and writes. */
export type ConfigReloadState = {
  /** The file configuration the running process last adopted. */
  activeFile: FileConfig;
  fileHash: string;
  restartRequired: readonly string[];
  lastError: ConfigErrorDetail | null;
  /** Identity of the last published image snapshot; detects key-jar-only rotations. */
  imageSnapshotId: string | null;
  /** Identity of the last published Telegram token source; null before the first apply. */
  telegramTokenId: string | null;
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
  /** Throws when the tool registry does not fit the model's context window. */
  readonly validateAgentModel: (model: Model<Api>) => void;
  /** Called after every successful publish; the composition root wakes the scheduler. */
  readonly onPublished: () => void;
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
    file = await loadConfig(configPath);
  } catch (error) {
    return deps.failure('config_invalid', messageOf(error), false);
  }
  const fromFile: ConfigSource = { file: file.fileConfig, raw: file.config };
  const diff = diffConfig(active, fromFile);
  const restartRequired = pathsOf(diff.changes, 'restart');
  try {
    validateSemantics(diff.candidate.file);
  } catch (error) {
    // The file is valid on its own, so the next startup is fine; only this
    // process cannot adopt it while the restart-only fields are still pending.
    const pending = restartRequired.length === 0 ? '' : ` Pending restart paths: ${restartRequired.join(', ')}.`;
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
      deps.validateAgentModel(model);
    }
  } catch (error) {
    return deps.failure('model_unusable', messageOf(error), false);
  }
  // The image candidate is prepared with every apply — including ones where
  // the file is unchanged — so a key-jar rotation is picked up by the next
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
  // A key-jar rotation changes the token without touching the file, exactly as
  // it does for the image credentials, so the source identity participates in
  // "did anything change" as well.
  let telegramSource: TelegramTokenSource | undefined;
  let telegramTokenId: string | null = null;
  if (deps.telegramConfig !== undefined) {
    telegramSource = await deps.telegramConfig.prepare(diff.candidate.raw);
    telegramTokenId = telegramTokenIdentity(telegramSource);
  }
  const telegramChanged = telegramTokenId !== state.telegramTokenId;
  const applied = pathsOf(diff.changes, 'hot');
  const outsideServe = pathsOf(diff.changes, 'outside_serve');
  const changed = applied.length > 0 || outsideServe.length > 0 || imageChanged || telegramChanged;
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
  });
  state.activeFile = diff.candidate.file;
  state.fileHash = file.hash;
  state.restartRequired = restartRequired;
  state.lastError = null;
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
  deps.onPublished();
  deps.logReloaded(applied, restartRequired, outsideServe);
  return deps.applied(applied, restartRequired, outsideServe);
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
        { file: deps.state.activeFile, models: deps.store.current().models },
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

function pathsOf(changes: readonly ConfigChange[], kind: ConfigChange['kind']): readonly string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
