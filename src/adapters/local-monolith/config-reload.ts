import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import type { AgentSettings, RawConfig } from '../../platform/config.ts';
import { assertConfigPermissions, type LoadedConfig, loadConfig } from './config.ts';
import type {
  BotCommandConfigWriter,
  ConfigApplyResult,
  ConfigController,
  ConfigEdit,
  ConfigErrorCode,
  ConfigStatus,
} from '../../platform/config-write.ts';
import { ConfigWriteError, readConfigRevision, writeConfigEdits } from './config-file.ts';
import { type AgentModelSwitcher, ModelSwitchError } from '../../platform/model-switch.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { applyFile, type ConfigReloadState, messageOf } from './config-reload-apply.ts';

/**
 * The image configuration gateway. The reloader prepares a candidate snapshot
 * (resolving SecretRefs) before anything is published and republishes it
 * together with the configuration; a failed prepare keeps the old snapshot.
 * Optional: absent when the process runs without the image service.
 */
export interface ImageConfigGateway {
  prepare: (candidate: RawConfig) => Promise<unknown>;
  publish: (snapshot: unknown) => void;
}

export interface ConfigReloaderOptions {
  /** The startup load result: the base for the first diff. */
  readonly loaded: LoadedConfig;
  readonly store: RuntimeConfigurationStore;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly secrets: SecretStore;
  /** Throws when the tool registry does not fit the model's context window. */
  readonly validateAgentModel: (model: Model<Api>) => void;
  /** Called after every successful publish; the composition root wakes the scheduler. */
  readonly onPublished: () => void;
  /** Optional image configuration gateway; present when the image service runs. */
  readonly imageConfig?: ImageConfigGateway;
}

/**
 * Applies the configuration file to the running process.
 *
 * The file is the desired configuration; this class decides which of its changes
 * the process can adopt right now (the hot whitelist in `config-diff.ts`) and
 * which have to wait for a restart. Both layers of a candidate are validated
 * before anything is published: the file itself, so the next startup will work,
 * and the candidate, so the running process will.
 */
export class ConfigReloader implements BotCommandConfigWriter, ConfigController {
  readonly #configPath: string;
  readonly #store: RuntimeConfigurationStore;
  readonly #modelSwitcher: AgentModelSwitcher;
  readonly #secrets: SecretStore;
  readonly #validateAgentModel: (model: Model<Api>) => void;
  readonly #onPublished: () => void;
  readonly #imageConfig: ImageConfigGateway | undefined;
  /** Mutable reload state, shared by reference with `config-reload-apply.ts`. */
  readonly #state: ConfigReloadState;
  /** Serializes reloads; a reload and a `/model` write never interleave. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ConfigReloaderOptions) {
    this.#configPath = options.loaded.configPath;
    this.#store = options.store;
    this.#modelSwitcher = options.modelSwitcher;
    this.#secrets = options.secrets;
    this.#validateAgentModel = options.validateAgentModel;
    this.#onPublished = options.onPublished;
    this.#imageConfig = options.imageConfig;
    this.#state = {
      activeFile: structuredClone(options.loaded.fileConfig),
      fileHash: options.loaded.hash,
      restartRequired: [],
      lastError: null,
      imageSnapshotId: null,
    };
  }

  status(): ConfigStatus {
    const current = this.#store.current();
    return {
      generation: current.generation,
      activeHash: current.hash,
      fileHash: this.#state.fileHash,
      restartRequired: this.#state.restartRequired,
      lastError: this.#state.lastError,
    };
  }

  reloadFromFile(): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#applyFile());
  }

  /**
   * Writes edits into the configuration file and applies the result, both inside
   * one lock hold so two panel writes cannot interleave.
   *
   * `expectedRevision` is the revision the caller read the file at; a stale one
   * is refused with `config_conflict` and leaves the file untouched.
   */
  writeAndApply(edits: readonly ConfigEdit[], expectedRevision?: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#writeAndApply(edits, expectedRevision));
  }

  /** Absolute path of the configuration file this reloader owns. */
  get configPath(): string {
    return this.#configPath;
  }

  /** Revision of the file on disk, for the panel's optimistic concurrency. */
  revision(): Promise<string> {
    return readConfigRevision(this.#configPath);
  }

  /** Loads the file on disk without applying it; `checkPermissions` enforces the 0600/0700 rule first. */
  async readPersisted(options: { readonly checkPermissions?: boolean } = {}): Promise<LoadedConfig> {
    if (options.checkPermissions === true) {
      await assertConfigPermissions(this.#configPath);
    }
    return await loadConfig(this.#configPath);
  }

  /**
   * Writes `agent.provider` / `agent.model` into the configuration file and
   * applies the file. The model must be usable before anything is written, so a
   * rejected switch leaves the file untouched; once it is written, a failed
   * apply reports `fileWritten` instead of pretending nothing happened.
   *
   * The switch also resets `agent.thinking_level` to the weakest level the new
   * model accepts: models do not share one set of levels, and the level chosen
   * for the old model may not exist on the new one.
   */
  setAgentModel(provider: string, model: string, expectedRevision?: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setModel(provider, model, expectedRevision));
  }

  /** The ID is the configured Chat ID, after resolving any Telegram group migration. */
  setChatModel(configuredChatId: number, provider: string, model: string): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setModel(provider, model, undefined, configuredChatId));
  }

  /** Removes all three overrides; if absent, still applies other pending file changes without rewriting. */
  resetChatModel(configuredChatId: number): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#writeChatSettings(configuredChatId, null));
  }

  /**
   * Appends a bare allowlist entry `{ id }` for the chat to the configuration
   * file and applies it. Adding a chat is a hot change (see `config-diff.ts`),
   * so a successful apply lets the running process accept the chat immediately.
   * A chat the file already allowlists is not written again; applying the file
   * then covers a previously written but unapplied add.
   */
  addChat(configuredChatId: number): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#addChat(configuredChatId));
  }

  /** Reads the latest file under the write lock so concurrent members cannot overwrite each other's IDs. */
  setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#setChatUserIgnored(configuredChatId, userId, ignored));
  }

  async #setChatUserIgnored(configuredChatId: number, userId: bigint, ignored: boolean): Promise<ConfigApplyResult> {
    if (userId <= 0n || userId > BigInt(Number.MAX_SAFE_INTEGER)) {
      return this.#rejected('config_invalid', `Invalid Telegram user ID: ${userId}`, 'config_write_failed');
    }
    if (!this.#store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is not configured in the running process`,
        'config_write_failed',
      );
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error), 'config_write_failed');
    }
    const chats = loaded.fileConfig.telegram?.chats ?? [];
    const index = chats.findIndex((chat) => chat.id === configuredChatId);
    const chat = chats[index];
    if (chat === undefined) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is no longer present in the configuration file`,
        'config_write_failed',
      );
    }
    const id = Number(userId);
    const ids = chat.ignored_user_ids ?? [];
    if (ids.includes(id) === ignored) {
      return await this.#applyFile();
    }
    return await this.#writeAndApply(
      [
        {
          path: ['telegram', 'chats', index, 'ignored_user_ids'],
          value: ignored ? [...ids, id] : ids.filter((entry) => entry !== id),
        },
      ],
      revision,
    );
  }

  async #addChat(configuredChatId: number): Promise<ConfigApplyResult> {
    if (!Number.isSafeInteger(configuredChatId) || configuredChatId === 0) {
      return this.#rejected('config_invalid', `Invalid Telegram chat ID: ${configuredChatId}`);
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error));
    }
    const chats = loaded.fileConfig.telegram?.chats ?? [];
    if (chats.some((chat) => chat.id === configuredChatId)) {
      return await this.#applyFile();
    }
    const edits: ConfigEdit[] = [{ path: ['telegram', 'chats', chats.length], value: { id: configuredChatId } }];
    return await this.#writeAndApply(edits, revision);
  }

  async #setModel(
    provider: string,
    model: string,
    expectedRevision?: string,
    configuredChatId?: number,
  ): Promise<ConfigApplyResult> {
    try {
      this.#modelSwitcher.option(provider, model);
    } catch (error) {
      if (error instanceof ModelSwitchError) {
        return this.#rejected(error.code, error.message);
      }
      throw error;
    }
    const resolved = this.#store.current().models.getModel(provider, model);
    if (resolved === undefined) {
      return this.#rejected('model_unusable', `Model ${provider}/${model} is not registered`);
    }
    try {
      this.#validateAgentModel(resolved);
    } catch (error) {
      return this.#rejected('model_unusable', messageOf(error));
    }
    const [weakest = 'off'] = getSupportedThinkingLevels(resolved);
    if (configuredChatId !== undefined) {
      return await this.#writeChatSettings(configuredChatId, { provider, model, thinking_level: weakest });
    }
    return await this.#writeAndApply(
      [
        { path: ['agent', 'provider'], value: provider },
        { path: ['agent', 'model'], value: model },
        { path: ['agent', 'thinking_level'], value: weakest },
      ],
      expectedRevision,
      'model_switch_failed',
    );
  }

  async #writeChatSettings(configuredChatId: number, settings: AgentSettings | null): Promise<ConfigApplyResult> {
    if (!this.#store.current().config.telegram.chats.some((chat) => chat.id === configuredChatId)) {
      return this.#rejected('config_invalid', `Chat ${configuredChatId} is not configured in the running process`);
    }
    let revision: string;
    let loaded: LoadedConfig;
    try {
      // Array order may differ from the active configuration. Locate by ID in the
      // file, then pin its revision so a concurrent reorder cannot target another Chat.
      revision = await readConfigRevision(this.#configPath);
      loaded = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#rejected('config_invalid', messageOf(error));
    }
    const chats = loaded.fileConfig.telegram?.chats ?? [];
    const index = chats.findIndex((chat) => chat.id === configuredChatId);
    const chat = chats[index];
    if (chat === undefined) {
      return this.#rejected(
        'config_invalid',
        `Chat ${configuredChatId} is no longer present in the configuration file`,
      );
    }
    const edits: ConfigEdit[] = [];
    for (const key of ['provider', 'model', 'thinking_level'] as const) {
      const value = settings?.[key];
      if (chat[key] !== value) {
        edits.push({ path: ['telegram', 'chats', index, key], value });
      }
    }
    return edits.length === 0
      ? await this.#applyFile()
      : await this.#writeAndApply(edits, revision, 'model_switch_failed');
  }

  async #writeAndApply(
    edits: readonly ConfigEdit[],
    expectedRevision: string | undefined,
    rejectedEvent = 'config_write_failed',
  ): Promise<ConfigApplyResult> {
    try {
      await writeConfigEdits(this.#configPath, edits, expectedRevision);
    } catch (error) {
      return error instanceof ConfigWriteError
        ? this.#rejected(error.code, error.message, rejectedEvent)
        : this.#rejected('config_write_failed', messageOf(error), rejectedEvent);
    }
    const result = await this.#applyFile();
    return result.ok ? result : { ...result, fileWritten: true };
  }

  async #applyFile(): Promise<ConfigApplyResult> {
    return await applyFile({
      configPath: this.#configPath,
      store: this.#store,
      state: this.#state,
      secrets: this.#secrets,
      imageConfig: this.#imageConfig,
      validateAgentModel: (model) => this.#validateAgentModel(model),
      onPublished: () => this.#onPublished(),
      failure: (code, message, fileWritten) => this.#failure(code, message, fileWritten),
      applied: (applied, restartRequired, outsideServe) => this.#applied(applied, restartRequired, outsideServe),
      logReloaded: (applied, restartRequired, outsideServe) =>
        this.#logReloaded(applied, restartRequired, outsideServe),
    });
  }

  #applied(
    applied: readonly string[],
    restartRequired: readonly string[],
    outsideServe: readonly string[],
  ): ConfigApplyResult {
    return { ok: true, applied, restartRequired, outsideServe, status: this.status() };
  }

  /**
   * A write refused before the file was written. No reload ran, so the status
   * keeps describing the last apply: the caller gets the error, and the log
   * records it under its own event.
   */
  #rejected(code: ConfigErrorCode, message: string, event = 'model_switch_failed'): ConfigApplyResult {
    const redacted = this.#secrets.redact(message);
    console.log(JSON.stringify({ event, code, error: redacted, at: new Date().toISOString() }));
    return { ok: false, code, message: redacted, fileWritten: false, status: this.status() };
  }

  /** A failed apply: the active configuration stays, and the status records why. */
  #failure(code: ConfigErrorCode, message: string, fileWritten: boolean): ConfigApplyResult {
    const redacted = this.#secrets.redact(message);
    this.#state.lastError = { code, message: redacted, at: new Date().toISOString() };
    console.log(JSON.stringify({ event: 'config_reload_failed', code, error: redacted, at: this.#state.lastError.at }));
    return { ok: false, code, message: redacted, fileWritten, status: this.status() };
  }

  #logReloaded(applied: readonly string[], restartRequired: readonly string[], outsideServe: readonly string[]): void {
    const current = this.#store.current();
    console.log(
      JSON.stringify({
        event: 'config_reloaded',
        generation: current.generation,
        active_hash: current.hash,
        file_hash: this.#state.fileHash,
        applied: applied.join(','),
        restart_required: restartRequired.join(','),
        outside_serve: outsideServe.join(','),
        at: new Date().toISOString(),
      }),
    );
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
