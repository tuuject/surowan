import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { JSONPath } from 'jsonc-parser';
import type { ExternalSecretReference } from '../keychain.ts';
import type { FileConfig, RawConfig } from './index.ts';

/**
 * Configuration read/write contracts consumed by bot commands and the Admin
 * Panel, independent of how the configuration is persisted. The host owns the
 * implementation (the local monolith's `ConfigReloader`).
 */
export type ConfigErrorCode =
  | 'config_permissions'
  | 'config_invalid'
  | 'config_conflict'
  | 'candidate_invalid'
  | 'model_unusable'
  | 'secret_unresolved'
  | 'unknown_provider'
  | 'unknown_model'
  | 'not_text_capable'
  | 'config_symlink'
  | 'config_write_failed'
  /** The configuration was published, but the publish hook failed; applying again retries it. */
  | 'publish_incomplete';

export interface ConfigEdit {
  readonly path: JSONPath;
  readonly value: unknown;
  /** Keychain entries that `value` references by name; they are stored with the edit. */
  readonly keys?: Readonly<Record<string, string>>;
}

/**
 * Sets `path` to a secret: the plaintext goes into the keychain under `name`,
 * the file only names the entry. The caller derives the name from where the
 * secret is used and makes it unique against the existing entries.
 */
export function secretEdit(path: JSONPath, plaintext: string, name: string): ConfigEdit {
  return { path, value: { jar: name }, keys: { [name]: plaintext } };
}

/** A validated configuration as currently persisted, not necessarily the active one. */
export interface PersistedConfig {
  readonly config: RawConfig;
  readonly fileConfig: FileConfig;
  readonly hash: string;
}

/** One keychain entry as the panel sees it: never the value. */
export interface KeychainEntryInfo {
  readonly name: string;
  readonly created_at: string;
}

/** Where a configuration references secrets, computed from the raw file. */
export interface KeychainUsageReport {
  /**
   * Entry name → every config path referencing it, from the raw JSONC file;
   * references inside sections validation ignores count. `null` when the file
   * could not be parsed, which blocks every reclaiming operation. A record,
   * not a Map, so the panel response carries it verbatim.
   */
  readonly file: Readonly<Record<string, readonly string[]>> | null;
  /** Entry names the running configuration references. */
  readonly active: readonly string[];
  /** `env` / `command` references in the file; a command's argv is never included. */
  readonly external: readonly ExternalSecretReference[];
}

export interface KeychainSnapshot {
  readonly entries: readonly KeychainEntryInfo[];
  readonly usage: KeychainUsageReport;
}

/** An entry change the panel or manager writes under the reloader's lock. */
export interface KeychainChange {
  readonly add?: Readonly<Record<string, string>>;
  readonly replace?: Readonly<Record<string, string>>;
  readonly remove?: readonly string[];
}

export interface KeychainPurgeResult {
  readonly deleted: readonly string[];
  readonly skipped: readonly string[];
}

/** One in-place rotation, with the path whose exclusive use justifies it. */
export interface KeychainReplacement {
  readonly name: string;
  readonly value: string;
  /** The dot-joined config path that referenced this entry alone. */
  readonly requestedBy: string;
}

/**
 * The keychain half of one secrets write: new entries (before the config
 * rename, so the file never names a missing entry) and in-place rotations.
 * Rotations are re-checked against the raw file under the write lock.
 */
export interface SecretWrite {
  readonly add?: Readonly<Record<string, string>>;
  readonly replace?: readonly KeychainReplacement[];
}

export interface ConfigErrorDetail {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly generation: number;
  /** Identity of the configuration the process is running. */
  readonly activeHash: string;
  /** Identity of the file as of the last successful load. */
  readonly fileHash: string;
  readonly restartRequired: readonly string[];
  readonly lastError: ConfigErrorDetail | null;
}

export interface ChatThinkingReset {
  readonly chatId: string;
  readonly previous: ModelThinkingLevel;
  readonly current: ModelThinkingLevel;
}

export type ConfigApplyResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
      readonly outsideServe: readonly string[];
      readonly status: ConfigStatus;
      /** Incompatible Chat overrides reset by a global model switch. */
      readonly chatThinkingResets?: readonly ChatThinkingReset[];
    }
  | {
      readonly ok: false;
      readonly code: ConfigErrorCode;
      readonly message: string;
      /** A failed apply after the requested edits already rewrote the file. */
      readonly fileWritten: boolean;
      readonly status: ConfigStatus;
    };

export type BotCommandConfigWriteResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: ConfigErrorCode;
      readonly message: string;
      readonly fileWritten: boolean;
    };

export interface BotCommandConfigWriter {
  addChat(configuredChatId: number): Promise<BotCommandConfigWriteResult>;
  setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<BotCommandConfigWriteResult>;
  setChatModel(configuredChatId: number, provider: string, model: string): Promise<BotCommandConfigWriteResult>;
  resetChatModel(configuredChatId: number): Promise<BotCommandConfigWriteResult>;
  setChatThinkingLevel(configuredChatId: number, level: ModelThinkingLevel): Promise<BotCommandConfigWriteResult>;
  resetChatThinkingLevel(configuredChatId: number): Promise<BotCommandConfigWriteResult>;
}

/** Reading, editing and applying the persisted configuration on behalf of the Admin Panel. */
export interface ConfigController {
  /**
   * Absolute path of the configuration file. The prompt editor still resolves
   * prompt files next to it; nothing else may rely on a filesystem source.
   */
  readonly configPath: string;
  status(): ConfigStatus;
  /** Revision of the persisted configuration's own bytes, for optimistic concurrency. */
  revision(): Promise<string>;
  /** Loads and validates the persisted configuration; `checkPermissions` also enforces the host's mode rules. */
  readPersisted(options?: { readonly checkPermissions?: boolean }): Promise<PersistedConfig>;
  reloadFromFile(): Promise<ConfigApplyResult>;
  writeAndApply(edits: readonly ConfigEdit[], expectedRevision?: string): Promise<ConfigApplyResult>;
  setAgentModel(provider: string, model: string, expectedRevision?: string): Promise<ConfigApplyResult>;

  /**
   * Keychain access bound to the same file and lock as the configuration
   * writes. Reads report where secrets are used; writes hold the reloader's
   * lock so a keychain write and a configuration write never interleave.
   */
  keychainSnapshot(): Promise<KeychainSnapshot>;
  /**
   * Writes keychain changes and configuration edits inside ONE lock hold: the
   * revision check, an exclusive-use re-check for every replacement from the
   * raw file, the keychain write (captured for rollback), the config write and
   * the apply. A replace-only request passes no edits — no "no changes" error,
   * but still revision-checked.
   */
  writeSecretsAndApply(
    edits: readonly ConfigEdit[],
    secrets: SecretWrite,
    expectedRevision?: string,
  ): Promise<ConfigApplyResult>;
  /** Writes entry changes without applying; the caller triggers the reload. */
  keychainWrite(change: KeychainChange): Promise<void>;
  /** Replaces one entry's value in place and applies the file. */
  keychainRotate(name: string, value: string): Promise<ConfigApplyResult>;
  /** Deletes one entry; an entry the file or the running configuration still uses is refused. */
  keychainDelete(name: string): Promise<void>;
  /** Deletes exactly those of `names` that are still orphans right now. */
  keychainPurge(names: readonly string[]): Promise<KeychainPurgeResult>;
}
