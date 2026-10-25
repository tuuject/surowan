import type { JSONPath } from 'jsonc-parser';
import type { FileConfig, RawConfig } from './index.ts';
import { type KeyJar, newKeyJarName } from '../key-jar.ts';

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
  | 'config_write_failed';

export interface ConfigEdit {
  readonly path: JSONPath;
  readonly value: unknown;
  /** Key jar entries that `value` references by name; they are stored with the edit. */
  readonly keys?: KeyJar;
}

/** Sets `path` to a secret: the plaintext goes into the key jar, the file only names it. */
export function secretEdit(path: JSONPath, plaintext: string): ConfigEdit {
  const name = newKeyJarName();
  return { path, value: { jar: name }, keys: { [name]: plaintext } };
}

/** A validated configuration as currently persisted, not necessarily the active one. */
export interface PersistedConfig {
  readonly config: RawConfig;
  readonly fileConfig: FileConfig;
  readonly hash: string;
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

export type ConfigApplyResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
      readonly outsideServe: readonly string[];
      readonly status: ConfigStatus;
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
}
