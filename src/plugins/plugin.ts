import type { PublicModel } from '@surowan/image-service';
import { basename } from 'node:path';
import type { ExecutableCapability } from '../capabilities/execute-tool.ts';
import type { ContextInjector } from '../context/injector.ts';
import type { RawConfig } from '../platform/config/index.ts';
import type { HostKind } from '../platform/im-host/identity.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import type { BusinessStore, Orm } from '../store/store.ts';
import { LongTaskService, type PluginTaskScope } from '../store/long-tasks/index.ts';
import { createToolAudit, type ToolAudit } from '../store/tool-audit.ts';
import type { SecretStore } from '../platform/secrets.ts';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Dotted, lowercase: `<owner>.<contract>`, e.g. `web-search.providers`. */
const EXTENSION_POINT_PATTERN = /^[a-z][a-z0-9-]{0,63}(\.[a-z][a-z0-9-]{0,63}){1,3}$/;

const HOST_KINDS: readonly HostKind[] = ['playground', 'telegram'];

/**
 * A typed extension contract one plugin publishes for the plugins that depend
 * on it. The type parameter is the value a contributor hands over; nothing is
 * shared at runtime beyond the point's name, so the contract stays explicit.
 */
export interface ExtensionPoint<T> {
  readonly name: string;
  /**
   * Identity of one contribution. When set, `loadPlugins` rejects a second
   * contribution carrying the same identity, which is what keeps a provider id
   * (or any other key the host resolves by name) unique across plugins.
   */
  readonly identify?: (value: T) => string;
}

/**
 * The erased shape a plugin list carries. Keeping it separate is what lets
 * `AgentPlugin` hold points of any value type: `identify` only ever runs on a
 * value the point itself produced, so `never` as its parameter is safe here.
 */
export interface ExtensionPointLike {
  readonly name: string;
  readonly identify?: (value: never) => string;
}

/** Declares one extension point. Modules keep the returned value as the contract. */
export function defineExtensionPoint<T>(name: string, identify?: (value: T) => string): ExtensionPoint<T> {
  return identify === undefined ? { name } : { name, identify };
}

/** One value a plugin contributes to an extension point it declared a dependency on. */
export interface ExtensionContribution<T> {
  readonly point: ExtensionPoint<T>;
  readonly value: T;
}

/** One contribution as the plugin list sees it, before its point is typed. */
export interface ExtensionContributionLike {
  readonly point: ExtensionPointLike;
  readonly value: unknown;
}

/** Type helper for a plugin module's `extensions` list. */
export function contribute<T>(point: ExtensionPoint<T>, value: T): ExtensionContribution<T> {
  return { point, value };
}

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
  /** The global image configuration is usable. */
  enabled(): boolean;
  /**
   * The conversation may submit new generations. A Telegram chat follows the
   * global switch; a Playground room is opt-in per room, so the same process
   * can serve both. Turning the switch off only blocks new submissions.
   */
  enabledFor(conversationId: bigint): boolean;
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
  /**
   * The configuration currently published by the process. A long-running
   * invocation keeps the `config` it was assembled with, but a capability that
   * must follow hot changes (and freeze them per request) reads here instead.
   */
  readonly readConfig: () => RawConfig;
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
  /** Resolves SecretRefs for capabilities that need a credential at call time. */
  readonly secrets?: SecretStore;
  /**
   * Nudges the running model with an out-of-band message. Absent outside a live
   * run (registry validation, previews); a capability that only needs to report
   * something in its result never has to use it.
   */
  readonly steer?: (text: string) => void;
  /** Values contributed to one extension point this plugin declared. */
  readonly extensions: <T>(point: ExtensionPoint<T>) => readonly T[];
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
  /**
   * Plugin ids that must load before this one. A plugin may only contribute to
   * extension points published by a plugin named here.
   */
  readonly dependencies?: readonly string[];
  /** Extension points this plugin publishes for its dependents. */
  readonly extensionPoints?: readonly ExtensionPointLike[];
  /** Values this plugin contributes to its dependencies' extension points. */
  readonly extensions?: readonly ExtensionContributionLike[];
  /**
   * Whether the plugin contributes anything right now. Returning false hides
   * its capabilities and its skills; a plugin that is conditionally available
   * must not list the condition anywhere else.
   */
  readonly available?: (config: RawConfig, extensions: <T>(point: ExtensionPoint<T>) => readonly T[]) => boolean;
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
  /** Whether one skill's owning plugin is available under `config`. */
  readonly skillAvailable: (skillName: string, config: RawConfig) => boolean;
  /** Values contributed to one extension point, in plugin load order. */
  readonly extensions: <T>(point: ExtensionPoint<T>) => readonly T[];
  /** All plugins' context injectors, in plugin load order. */
  readonly contextInjectors: readonly ContextInjector[];
  capabilities(
    store: BusinessStore,
    config: RawConfig,
    context: InvocationContext,
    deadline: number,
    tasks?: LongTaskService,
    resolveMedia?: (ref: string) => bigint | undefined,
    live?: {
      readonly readConfig?: () => RawConfig;
      readonly secrets?: SecretStore;
      readonly steer?: (text: string) => void;
    },
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
    for (const point of plugin.extensionPoints ?? []) {
      if (!EXTENSION_POINT_PATTERN.test(point.name)) {
        throw new Error(`Plugin ${plugin.id} declares an invalid extension point: ${point.name}`);
      }
    }
    ids.add(plugin.id);
  }
  const indexById = new Map<string, number>(plugins.map((plugin, index) => [plugin.id, index]));
  for (const [index, plugin] of plugins.entries()) {
    for (const dependency of plugin.dependencies ?? []) {
      if (dependency === plugin.id) {
        throw new Error(`Plugin ${plugin.id} cannot depend on itself`);
      }
      const dependencyIndex = indexById.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(`Plugin ${plugin.id} depends on unknown plugin ${dependency}`);
      }
      if (dependencyIndex >= index) {
        throw new Error(`Plugin ${plugin.id} must load after its dependency ${dependency}`);
      }
    }
  }
  const points = collectExtensionPoints(plugins);
  const extensions = collectExtensions(plugins, points);
  const readExtensions = <T>(point: ExtensionPoint<T>): readonly T[] => {
    const values = extensions.get(point.name);
    if (values === undefined) {
      throw new Error(`Unknown extension point: ${point.name}`);
    }
    return values as readonly T[];
  };
  const injectorNames = new Set<string>();
  // An injector runs only where its plugin runs: it inherits the plugin's
  // hosts, narrowed further by its own list. Without this an injector of a
  // Telegram-only plugin would still render for a room and read its internal
  // chat id as a Telegram one.
  const contextInjectors: readonly ContextInjector[] = plugins.flatMap((plugin) => {
    const hosts = pluginHosts(plugin);
    return (plugin.contextInjectors ?? []).map((injector) => withHosts(injector, hosts));
  });
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
    skillAvailable: (skillName, config) => {
      const owner = plugins.find((plugin) =>
        (plugin.skills ?? []).some((directory) => basename(directory) === skillName),
      );
      return owner === undefined || owner.available?.(config, readExtensions) !== false;
    },
    extensions: readExtensions,
    contextInjectors,
    capabilities: (store, config, context, deadline, suppliedTasks, resolveMedia, live) => {
      const audit = createToolAudit(store, context.invocationId);
      const service = suppliedTasks ?? new LongTaskService(store.orm);
      const readConfig = live?.readConfig ?? (() => config);
      return plugins.flatMap((plugin) => {
        const hosts = pluginHosts(plugin);
        if (!hosts.includes(context.hostKind)) {
          return [];
        }
        if (plugin.available?.(config, readExtensions) === false) {
          return [];
        }
        const scope: InvocationScope = {
          config,
          readConfig,
          context,
          deadline,
          audit,
          orm: store.orm,
          tasks: context.invocationId === 0n ? unavailableTasks() : service.invocationScope(plugin.id, context, hosts),
          extensions: readExtensions,
          ...(resolveMedia === undefined ? {} : { resolveMedia }),
          ...(options.image === undefined ? {} : { image: options.image }),
          ...(live?.secrets === undefined ? {} : { secrets: live.secrets }),
          ...(live?.steer === undefined ? {} : { steer: live.steer }),
        };
        return plugin.capabilities?.(scope) ?? [];
      });
    },
  };
}

interface DeclaredExtensionPoint {
  readonly owner: string;
  readonly point: ExtensionPointLike;
}

/** Extension point name → declaring plugin and its point. A name has exactly one owner. */
function collectExtensionPoints(plugins: readonly AgentPlugin[]): ReadonlyMap<string, DeclaredExtensionPoint> {
  const owners = new Map<string, DeclaredExtensionPoint>();
  for (const plugin of plugins) {
    for (const point of plugin.extensionPoints ?? []) {
      const existing = owners.get(point.name);
      if (existing !== undefined) {
        throw new Error(`Duplicate extension point ${point.name}: declared by ${existing.owner} and ${plugin.id}`);
      }
      owners.set(point.name, { owner: plugin.id, point });
    }
  }
  return owners;
}

/**
 * Resolves every contribution against the plugin that published its point.
 * A contribution is only legal from a plugin that declares that publisher as a
 * direct dependency, and any identity the point asks for stays unique.
 */
function collectExtensions(
  plugins: readonly AgentPlugin[],
  owners: ReadonlyMap<string, DeclaredExtensionPoint>,
): ReadonlyMap<string, readonly unknown[]> {
  const values = new Map<string, unknown[]>();
  for (const point of owners.keys()) {
    values.set(point, []);
  }
  const identities = new Map<string, Map<string, string>>();
  for (const plugin of plugins) {
    const dependencies = new Set(plugin.dependencies ?? []);
    for (const contribution of plugin.extensions ?? []) {
      const declared = owners.get(contribution.point.name);
      if (declared === undefined) {
        throw new Error(`Plugin ${plugin.id} contributes to unknown extension point ${contribution.point.name}`);
      }
      if (!dependencies.has(declared.owner)) {
        throw new Error(
          `Plugin ${plugin.id} contributes to ${contribution.point.name} without depending on ${declared.owner}`,
        );
      }
      // The owner's declaration is the contract: a contributor that builds its
      // own point object by the same name cannot opt out of identity checks.
      const identify = declared.point.identify;
      if (identify !== undefined) {
        const seen = identities.get(contribution.point.name) ?? new Map<string, string>();
        identities.set(contribution.point.name, seen);
        const identity = identify(contribution.value as never);
        const previous = seen.get(identity);
        if (previous !== undefined) {
          throw new Error(
            `Duplicate ${contribution.point.name} contribution ${identity}: ${previous} and ${plugin.id}`,
          );
        }
        seen.set(identity, plugin.id);
      }
      values.get(contribution.point.name)?.push(contribution.value);
    }
  }
  return values;
}

function withHosts(injector: ContextInjector, pluginHosts: readonly HostKind[]): ContextInjector {
  const hosts = pluginHosts.filter((host) => injector.hosts === undefined || injector.hosts.includes(host));
  return {
    name: injector.name,
    hosts,
    collect: (text) => injector.collect(text),
    render: (input) => injector.render(input),
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
