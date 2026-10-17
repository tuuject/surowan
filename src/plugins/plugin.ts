import type { PublicModel } from '@plasticwan/image-service';
import { basename } from 'node:path';
import type { ExecutableCapability } from '../capabilities/execute-tool.ts';
import type { ContextInjector } from '../context/context-injector.ts';
import type { RawConfig } from '../platform/config.ts';
import type { HostKind } from '../platform/im-host.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import type { BusinessStore, Orm } from '../store/store.ts';
import { LongTaskService, type PluginTaskScope } from '../store/long-tasks.ts';
import { createToolAudit, type ToolAudit } from '../store/tool-audit.ts';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const HOST_KINDS: readonly HostKind[] = ['playground', 'telegram'];

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
 * A built-in agent plugin. It only declares contributions; the host decides
 * when to assemble them. Lifecycle hooks are added once a plugin needs one.
 */
export interface AgentPlugin {
  readonly id: string;
  /**
   * Hosts this plugin may run on. Omitted means Telegram only: a new plugin
   * never drifts into the Playground just because it exists.
   */
  readonly hosts?: readonly HostKind[];
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
  /** Mounted under system:///skills/ next to the bundled tree, see `FileSystemResources.load`. */
  readonly skillDirectories: readonly string[];
  /** Skill name to the hosts that mount it. Unlisted skills are host-neutral. */
  readonly skillHosts: ReadonlyMap<string, readonly HostKind[]>;
  /** All plugins' context injectors, in plugin load order. */
  readonly contextInjectors: readonly ContextInjector[];
  capabilities(
    store: BusinessStore,
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
    pluginHosts(plugin);
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
    skillHosts: new Map(
      plugins.flatMap((plugin) =>
        (plugin.skills ?? []).map((directory) => [basename(directory), pluginHosts(plugin)] as const),
      ),
    ),
    contextInjectors,
    capabilities: (store, config, context, deadline, suppliedTasks, resolveMedia) => {
      const audit = createToolAudit(store, context.invocationId);
      const service = suppliedTasks ?? new LongTaskService(store.orm);
      return plugins.flatMap((plugin) => {
        const hosts = pluginHosts(plugin);
        if (!hosts.includes(context.hostKind)) {
          return [];
        }
        const scope: InvocationScope = {
          config,
          context,
          deadline,
          audit,
          orm: store.orm,
          tasks: context.invocationId === 0n ? unavailableTasks() : service.invocationScope(plugin.id, context, hosts),
          ...(resolveMedia === undefined ? {} : { resolveMedia }),
          ...(options.image === undefined ? {} : { image: options.image }),
        };
        return plugin.capabilities?.(scope) ?? [];
      });
    },
  };
}

/** The hosts a plugin was declared for. Omitted or empty means Telegram only. */
export function pluginHosts(plugin: AgentPlugin): readonly HostKind[] {
  const hosts = plugin.hosts === undefined || plugin.hosts.length === 0 ? (['telegram'] as const) : plugin.hosts;
  for (const host of hosts) {
    if (!HOST_KINDS.includes(host)) {
      throw new Error(`Plugin ${plugin.id} declares an unknown host: ${String(host)}`);
    }
  }
  return hosts;
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
