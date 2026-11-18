import { readFile } from 'node:fs/promises';
import { type ParseError, parse } from 'jsonc-parser';
import type {
  ConfigApplyResult,
  ConfigEdit,
  ConfigErrorCode,
  ConfigStatus,
  KeychainChange,
  KeychainPurgeResult,
  KeychainSnapshot,
  KeychainUsageReport,
  SecretWrite,
} from '../../../platform/config/write.ts';
import { collectSecretReferences, KeychainError, readKeychain, updateKeychain } from '../../../platform/keychain.ts';
import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import { ConfigWriteError, readConfigRevision, writeConfigEdits } from './file.ts';
import type { SearchProviderRule } from '../../../platform/web-search.ts';
import type { ConfigReloadState } from './reload-apply.ts';

/**
 * The keychain half of `ConfigController`, implemented over the same file and
 * lock as the configuration writes. Reads need no lock: both source files are
 * replaced atomically, so a read sees one whole state. Writes and the delete
 * judgment hold the reloader's lock.
 */
export class KeychainController {
  readonly #file: string;
  readonly #path: string;
  readonly #store: RuntimeConfigurationStore;
  readonly #state: ConfigReloadState;
  readonly #lock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly #apply: () => Promise<ConfigApplyResult>;
  /** The reloader's own validation options, so a secrets write validates the edited file the same way. */
  readonly #loadOptions: () => { readonly searchProviders?: readonly SearchProviderRule[] };

  constructor(deps: {
    readonly keychainFile: string;
    readonly configPath: string;
    readonly store: RuntimeConfigurationStore;
    readonly state: ConfigReloadState;
    readonly withLock: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly applyFile: () => Promise<ConfigApplyResult>;
    readonly loadOptions: () => { readonly searchProviders?: readonly SearchProviderRule[] };
  }) {
    this.#file = deps.keychainFile;
    this.#path = deps.configPath;
    this.#store = deps.store;
    this.#state = deps.state;
    this.#lock = deps.withLock;
    this.#apply = deps.applyFile;
    this.#loadOptions = deps.loadOptions;
  }

  /**
   * Keychain access under the same lock as configuration writes. The snapshot
   * reads the entries and the two reference sets without holding the lock:
   * both source files are replaced atomically, so a read sees one whole state.
   */
  async keychainSnapshot(): Promise<KeychainSnapshot> {
    const jar = await readKeychain(this.#file);
    return {
      entries: Object.entries(jar ?? {}).map(([name, entry]) => ({
        name,
        created_at: entry.created_at,
      })),
      usage: await this.#keychainUsage(),
    };
  }

  keychainWrite(change: KeychainChange): Promise<void> {
    return this.#lock(() => updateKeychain(this.#file, change));
  }

  /**
   * One lock hold for a secrets write: the revision check, an exclusive-use
   * re-check for every replacement straight from the raw file, the keychain
   * write (old values captured for rollback), the configuration write and the
   * apply. Anything failing before the configuration rename restores the old
   * values, so a refused write leaves neither file nor keychain changed.
   */
  async writeSecretsAndApply(
    edits: readonly ConfigEdit[],
    secrets: SecretWrite,
    expectedRevision?: string,
  ): Promise<ConfigApplyResult> {
    return await this.#lock(async () => {
      if (expectedRevision !== undefined) {
        const revision = await readConfigRevision(this.#path);
        if (revision !== expectedRevision) {
          return this.#failure(
            'config_conflict',
            'The configuration file changed since it was read; reload the panel and try again',
          );
        }
      }
      const replacements = secrets.replace ?? [];
      if (replacements.length > 0) {
        const usage = await this.#keychainUsage();
        if (usage.file === null) {
          throw new KeychainError(
            'keychain_unparsable',
            'The configuration file could not be parsed; the rotation is refused rather than trusting an incomplete reference set',
          );
        }
        for (const replacement of replacements) {
          const paths = Object.hasOwn(usage.file, replacement.name) ? usage.file[replacement.name] : undefined;
          if (paths === undefined || paths.length !== 1 || paths[0] !== replacement.requestedBy) {
            return this.#failure(
              'config_conflict',
              `Keychain entry ${replacement.name} is referenced differently since the key was read; reload the panel and try again`,
            );
          }
        }
      }
      // Old values and absence, captured before anything is written.
      const jar = await readKeychain(this.#file);
      const oldValues: Record<string, string> = Object.create(null);
      const absent: string[] = [];
      for (const replacement of replacements) {
        const previous = jar !== null && Object.hasOwn(jar, replacement.name) ? jar[replacement.name] : undefined;
        if (previous === undefined) {
          absent.push(replacement.name);
        } else {
          oldValues[replacement.name] = previous.value;
        }
      }
      const addedNames = Object.keys(secrets.add ?? {}).filter((name) => jar === null || !Object.hasOwn(jar, name));
      const change: KeychainChange = {
        ...(secrets.add === undefined || Object.keys(secrets.add).length === 0 ? {} : { add: secrets.add }),
        ...(replacements.length === 0
          ? {}
          : { replace: Object.fromEntries(replacements.map((entry) => [entry.name, entry.value])) }),
      };
      if (change.add !== undefined || change.replace !== undefined) {
        await updateKeychain(this.#file, change);
      }
      if (edits.length === 0) {
        // A replace-only write is not a configuration change: the apply adopts
        // the rotated values (rebuilding affected connections). Each
        // requesting path is reported as applied — the connection it names was
        // rebuilt even though the file did not move. A failed apply leaves the
        // rotated value on disk (key.json is the storage here), so the
        // response reports it as written but not applied instead of pretending
        // the rotation never happened.
        const result = await this.#apply();
        if (!result.ok) {
          return { ...result, fileWritten: true };
        }
        const requested = replacements.filter((entry) => !entry.requestedBy.startsWith('mcp.servers'));
        return {
          ...result,
          applied: [...result.applied, ...requested.map((entry) => entry.requestedBy)],
        };
      }
      const result = await this.#writeAndApply(edits, expectedRevision);
      if (!result.ok && result.fileWritten !== true) {
        // The configuration write was refused before anything landed (invalid
        // edit, revision race): roll the carried rotations and repairs back so
        // a rejected save leaves neither file nor keychain changed.
        await this.#restore(oldValues, absent, addedNames);
      }
      return result;
    });
  }

  /** Best-effort rollback of the keychain write; the original error propagates. */
  async #restore(
    oldValues: Readonly<Record<string, string>>,
    absent: readonly string[],
    addedNames: readonly string[],
  ): Promise<void> {
    const replace: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(oldValues)) {
      replace[name] = value;
    }
    const remove: string[] = [];
    for (const name of absent) {
      if (Object.hasOwn(oldValues, name)) {
        continue;
      }
      remove.push(name);
    }
    for (const name of addedNames) {
      if (!Object.hasOwn(replace, name) && !remove.includes(name)) {
        remove.push(name);
      }
    }
    if (Object.keys(replace).length === 0 && remove.length === 0) {
      return;
    }
    await updateKeychain(this.#file, { replace, remove }).catch(() => undefined);
  }

  #failure(code: ConfigErrorCode, message: string): ConfigApplyResult {
    return { ok: false, code, message, fileWritten: false, status: this.#status() };
  }

  /** The reloader's status shape, from the shared store and reload state. */
  #status(): ConfigStatus {
    return {
      generation: this.#store.current().generation,
      activeHash: this.#store.current().hash,
      fileHash: this.#state.fileHash,
      restartRequired: this.#state.restartRequired,
      lastError: this.#state.lastError,
    };
  }

  /**
   * The configuration write inside the same lock hold. `writeConfigEdits`
   * re-checks the revision itself; a failure before the rename leaves the old
   * file in place (and the caller restores the keychain values).
   */
  async #writeAndApply(edits: readonly ConfigEdit[], expectedRevision?: string): Promise<ConfigApplyResult> {
    try {
      await writeConfigEdits(this.#path, edits, expectedRevision, this.#loadOptions());
    } catch (error) {
      if (error instanceof ConfigWriteError) {
        return this.#failure(error.code, error.message);
      }
      return this.#failure('config_write_failed', error instanceof Error ? error.message : String(error));
    }
    const result = await this.#apply();
    return result.ok ? result : { ...result, fileWritten: true };
  }

  /** One lock hold covers the value rotation and the apply that adopts it. */
  keychainRotate(name: string, value: string): Promise<ConfigApplyResult> {
    return this.#lock(async () => {
      await updateKeychain(this.#file, { replace: { [name]: value } });
      return await this.#apply();
    });
  }

  async keychainDelete(name: string): Promise<void> {
    await this.#lock(async () => {
      await this.#assertOrphan(name);
      await updateKeychain(this.#file, { remove: [name] });
    });
  }

  /** Deletes exactly those of `names` that are still orphans at delete time. */
  async keychainPurge(names: readonly string[]): Promise<KeychainPurgeResult> {
    return await this.#lock(async () => {
      const usage = await this.#keychainUsage();
      if (usage.file === null) {
        throw new KeychainError(
          'keychain_unparsable',
          'The configuration file could not be parsed; purging is refused rather than trusting an incomplete reference set',
        );
      }
      const fileUsage = usage.file ?? {};
      const deleted: string[] = [];
      const skipped: string[] = [];
      for (const name of names) {
        if (Object.hasOwn(fileUsage, name) || usage.active.includes(name)) {
          skipped.push(name);
        } else {
          deleted.push(name);
        }
      }
      if (deleted.length > 0) {
        await updateKeychain(this.#file, { remove: deleted });
      }
      return { deleted, skipped };
    });
  }

  /** The orphan judgment a single delete needs; the file must be parsable. */
  async #assertOrphan(name: string): Promise<void> {
    const usage = await this.#keychainUsage();
    if (usage.file === null) {
      throw new KeychainError(
        'keychain_unparsable',
        'The configuration file could not be parsed; deleting is refused rather than trusting an incomplete reference set',
      );
    }
    const fileUsage = usage.file;
    if (Object.hasOwn(fileUsage, name) || usage.active.includes(name)) {
      const where = (Object.hasOwn(fileUsage, name) ? (fileUsage[name] ?? []) : []).join(', ');
      throw new KeychainError(
        'keychain_in_use',
        `Keychain entry ${name} is still used by ${where || 'the running configuration'}; swap that use to another entry first`,
      );
    }
  }

  async #keychainUsage(): Promise<KeychainUsageReport> {
    const active = [...collectSecretReferences(this.#store.current().config).jars.keys()];
    let file: Readonly<Record<string, readonly string[]>> | null = null;
    let external: KeychainUsageReport['external'] = [];
    try {
      const source = await readFile(this.#path, 'utf8');
      const errors: ParseError[] = [];
      const parsed: unknown = parse(source.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
      if (errors.length === 0 && typeof parsed === 'object' && parsed !== null) {
        const walk = collectSecretReferences(parsed);
        file = Object.fromEntries(walk.jars);
        external = walk.external;
      }
    } catch {
      // An unreadable file is reported as "usage unavailable", never guessed.
    }
    return { file, active, external };
  }
}
