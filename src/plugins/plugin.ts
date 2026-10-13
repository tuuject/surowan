import type { PublicModel } from '@plasticwan/image-service';
import type { ExecutableCapability } from '../capabilities/execute-tool.ts';
import type { RawConfig } from '../platform/config.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import type { Orm, SqliteStore } from '../store/database.ts';
import { LongTaskService, type PluginTaskScope } from '../store/long-tasks.ts';
import { createToolAudit, type ToolAudit } from '../store/tool-audit.ts';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * What the host hands a plugin when it assembles tools for one invocation.
 * `context` is the live invocation state, refreshed by hot injection, so tools
 * read it at call time instead of copying it.
 */
/**
 * The image-generation bridge a plugin sees. `undefined` when the host has no
 * image service wired (the plugin then contributes nothing).
 */
export interface ImagePluginBridge {
  enabled(): boolean;
  submit(
    params: {
      conversationId: bigint;
      invocationId: bigint | null;
      toolCallId: string;
      authoredPrompt: string;
      modelId: string | undefined;
      aspectRatio: string | undefined;
      resolution: string | undefined;
      outputCount: number | undefined;
      inputMediaIds: readonly bigint[];
      extendedData: Record<string, unknown> | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{
    generationId: string;
    replayed: boolean;
    modelId: string;
    outputCount: number;
  }>;
  modelList(): readonly PublicModel[];
}

export interface InvocationScope {
  readonly config: RawConfig;
  readonly context: InvocationContext;
  readonly deadline: number;
  readonly audit: ToolAudit;
  /** The host's database, for plugins that contribute their own queries. */
  readonly orm: Orm;
  /** Per-plugin task scope bound to the current conversation. */
  readonly tasks: PluginTaskScope;
  /**
   * Resolves a conversation-authorized media reference (img_…) to its media id.
   * Absent when the host did not wire reference resolution.
   */
  readonly resolveMedia?: (ref: string) => bigint | undefined;
  /** Image-generation bridge; `undefined` = the host runs without one. */
  readonly image?: ImagePluginBridge;
}

/**
 * One per-batch context injection: an untrusted block the runtime appends to
 * the newest injected message, between the sticker catalog and the Telegram
 * history. Injectors run after the batch's messages were selected, in plugin
 * load order, and each receives what is left of the character budget.
 *
 * De-duplication is the injector's own contract, expressed as opaque signature
 * strings: `render` reports the signatures its block carries, the runtime
 * accumulates them per injector, and `collect` reads them back out of a
 * retained transcript message after a GC or cache rebuild. The runtime never
 * interprets a signature.
 *
 * Trust boundary: a non-empty `text` MUST be wrapped in an `<untrusted_…>`
 * envelope and MUST NOT indent any of its lines. Telegram message bodies are
 * always rendered indented two spaces (`formatSnapshot`), so only the runtime's
 * own unindented lines can start an envelope or a signature tag; this is what
 * keeps chat text from forging a block or a dedupe signature.
 */
export interface ContextInjector {
  /** Injector name; also the audit key. Must match PLUGIN_ID_PATTERN and be unique across plugins. */
  readonly name: string;
  /**
   * Reads this injector's signatures out of one retained user message's text.
   * The runtime calls it for every retained message when rebuilding state
   * after a GC or agent cache miss.
   */
  collect(text: string): Iterable<string>;
  /** Renders this batch's injection block; an empty `text` injects nothing. */
  render(input: ContextInjectionInput): ContextInjectionResult;
}

export interface ContextInjectionInput {
  readonly config: RawConfig;
  readonly orm: Orm;
  readonly chatId: bigint;
  readonly chatType: string;
  /** The text and caption of this batch's selected messages (history + new), for on-demand matching. */
  readonly messageTexts: readonly string[];
  /** The character budget left after the messages and any earlier injector's block. */
  readonly remainingCharacters: number;
  /** Signatures this injector wrote that the retained transcript still carries. */
  readonly carried: ReadonlySet<string>;
}

export interface ContextInjectionResult {
  readonly text: string;
  /** Signatures written by this block; the runtime adds them to the carried set. */
  readonly signatures: readonly string[];
  /** Injected entry count, for the audit stream. */
  readonly count: number;
}

/**
 * A built-in agent plugin. It only declares contributions; the host decides
 * when to assemble them. Lifecycle hooks are added once a plugin needs one.
 */
export interface AgentPlugin {
  readonly id: string;
  /** Absolute skill directories; each basename is the skill name and holds SKILL.md. */
  readonly skills?: readonly string[];
  /** Runtime-internal capabilities, dispatched and audited through `execute`. */
  readonly capabilities?: (scope: InvocationScope) => readonly ExecutableCapability[];
  /** Per-batch context injectors, run in plugin load order. */
  readonly contextInjectors?: readonly ContextInjector[];
}

/** Type helper for plugin modules. It validates nothing: `loadPlugins` does. */
export function definePlugin<const T extends AgentPlugin>(plugin: T): T {
  return plugin;
}

export interface LoadPluginsOptions {
  /** Image-generation bridge handed to plugins that opt in (`scope.image`). */
  readonly image?: ImagePluginBridge;
  /** Conversation media-reference resolver handed to plugins (`scope.resolveMedia`). */
  readonly resolveMedia?: (ref: string) => bigint | undefined;
}

export interface LoadedPlugins {
  /** Mounted under system:///skills/ next to the bundled tree, see `SystemResources.load`. */
  readonly skillDirectories: readonly string[];
  /** All plugins' context injectors, in plugin load order. */
  readonly contextInjectors: readonly ContextInjector[];
  capabilities(
    store: SqliteStore,
    config: RawConfig,
    context: InvocationContext,
    deadline: number,
    tasks?: LongTaskService,
    resolveMedia?: (ref: string) => bigint | undefined,
  ): readonly ExecutableCapability[];
}

/**
 * Validates plugin definitions and merges their contributions. Skill name
 * conflicts surface when the skill directories are loaded, capability name
 * conflicts when the execute registry is built, injector name conflicts here.
 */
export function loadPlugins(plugins: readonly AgentPlugin[], options: LoadPluginsOptions = {}): LoadedPlugins {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (!PLUGIN_ID_PATTERN.test(plugin.id)) {
      throw new Error(`Plugin id is invalid: ${plugin.id}`);
    }
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  const injectorNames = new Set<string>();
  const contextInjectors: readonly ContextInjector[] = plugins.flatMap((plugin) => plugin.contextInjectors ?? []);
  for (const injector of contextInjectors) {
    if (!PLUGIN_ID_PATTERN.test(injector.name)) {
      throw new Error(`Context injector name is invalid: ${injector.name}`);
    }
    if (injectorNames.has(injector.name)) {
      throw new Error(`Duplicate context injector name: ${injector.name}`);
    }
    injectorNames.add(injector.name);
  }
  return {
    skillDirectories: plugins.flatMap((plugin) => plugin.skills ?? []),
    contextInjectors,
    capabilities: (store, config, context, deadline, suppliedTasks, resolveMedia) => {
      const audit = createToolAudit(store, context.invocationId);
      const service = suppliedTasks ?? new LongTaskService(store.orm);
      return plugins.flatMap((plugin) => {
        const scope: InvocationScope = {
          config,
          context,
          deadline,
          audit,
          orm: store.orm,
          tasks: context.invocationId === 0n ? unavailableTasks() : service.invocationScope(plugin.id, context),
          ...(resolveMedia === undefined ? {} : { resolveMedia }),
          ...(options.image === undefined ? {} : { image: options.image }),
        };
        return plugin.capabilities?.(scope) ?? [];
      });
    },
  };
}

function unavailableTasks(): PluginTaskScope {
  const unavailable = (): never => {
    throw new Error('LongTaskService is not available outside a live invocation');
  };
  return {
    create: unavailable,
    get: unavailable,
    list: unavailable,
    complete: unavailable,
    fail: unavailable,
    cancel: unavailable,
  };
}
