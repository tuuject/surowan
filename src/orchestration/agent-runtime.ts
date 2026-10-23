import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ContextBuilder } from '../context/context-builder.ts';
import type { ContextInjector } from '../context/context-injector.ts';
import { ContextRefStore } from '../context/context-refs.ts';
import { ConversationContextStore } from '../context/context-store.ts';
import { KeyedSemaphore } from '../platform/concurrency.ts';
import type { RawConfig } from '../platform/config.ts';
import type { HostKind, ImHost } from '../platform/im-host.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SkillVisibilityTarget, SystemResources, SystemSkill } from '../platform/system-resources.ts';
import type { BusinessStore } from '../store/store.ts';
import type {
  AgentRuntimeOptions,
  CapabilityToolFactory,
  DirectImageLoader,
  RuntimeServices,
  ToolFactory,
} from './agent-runtime-types.ts';
import { logInvocationError } from './agent-runtime-observability.ts';
import { runInvocation } from './agent-runtime-run.ts';
import { recordAgentMessage, sceneToolDefinitions, validateAdditionalTools } from './agent-runtime-support.ts';
import { ConversationRuntime } from './conversation-runtime.ts';
import type { InvocationOutcome } from './scheduler.ts';

/**
 * One invocation-scoped runtime. The class owns the assembled dependencies and
 * the public surface; the invocation lifecycle, the transcript helpers and the
 * audit writers live in the sibling `agent-runtime-*` modules and take these
 * services plus one run's live state by reference.
 */
export class AgentRuntime {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #hosts: Readonly<Partial<Record<HostKind, ImHost>>>;
  readonly #conversation: AgentRuntimeOptions['conversation'];
  readonly #bot: AgentRuntimeOptions['bot'];
  readonly #systemResources: SystemResources;
  readonly #capabilityTools: CapabilityToolFactory | undefined;
  /** Per-invocation skill visibility; used to hide disabled capability skills. */
  readonly #skillVisibility: ((skill: SystemSkill, target: SkillVisibilityTarget) => boolean) | undefined;
  readonly #additionalTools: ToolFactory | undefined;
  readonly #directImageLoader: DirectImageLoader | undefined;
  readonly #modelGate: KeyedSemaphore;
  readonly #contextBuilder: ContextBuilder;
  readonly #contexts: ConversationContextStore;
  readonly #refs: ContextRefStore;
  /** Resolves generated pictures for delivery; absent without image generation. */
  readonly #imageGeneration:
    | {
        readonly resolve: (
          generationId: string,
          conversationId: bigint,
        ) =>
          | readonly {
              readonly assetId: string;
              readonly bytes: Uint8Array;
              readonly fileName: string;
              readonly mime: string;
            }[]
          | undefined;
      }
    | undefined;
  readonly #conversationRuntime: ConversationRuntime;
  readonly #contextInjectors: readonly ContextInjector[];

  /**
   * The same live services the phase modules take, assembled once. Every entry
   * is a reference to the field above it; nothing per-run is copied here.
   */
  readonly #services: RuntimeServices;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#configStore = options.configStore;
    this.#hosts = options.hosts;
    this.#conversation = options.conversation;
    this.#bot = options.bot;
    this.#systemResources = options.systemResources;
    this.#capabilityTools = options.capabilityTools;
    this.#skillVisibility = options.skillVisibility;
    this.#additionalTools = options.additionalTools;
    this.#directImageLoader = options.directImageLoader;
    this.#contextInjectors = options.contextInjectors ?? [];
    this.#modelGate = options.modelGate ?? new KeyedSemaphore();
    const context = () => options.configStore.current().config.agent.context;
    this.#contexts = new ConversationContextStore(options.store);
    this.#refs = new ContextRefStore(options.store, { ttlHours: () => context().ref_ttl_hours });
    this.#imageGeneration = options.imageGeneration;
    this.#conversationRuntime =
      options.conversationRuntime ?? new ConversationRuntime({ agentCacheSize: () => context().agent_cache_size });
    this.#contextBuilder = new ContextBuilder(
      options.store,
      this.#refs,
      options.systemResources.skills,
      this.#contextInjectors,
    );
    this.#services = {
      store: this.#store,
      configStore: this.#configStore,
      secrets: this.#secrets,
      hosts: this.#hosts,
      conversation: this.#conversation,
      bot: this.#bot,
      systemResources: this.#systemResources,
      capabilityTools: this.#capabilityTools,
      skillVisibility: this.#skillVisibility,
      additionalTools: this.#additionalTools,
      directImageLoader: this.#directImageLoader,
      modelGate: this.#modelGate,
      contextBuilder: this.#contextBuilder,
      contexts: this.#contexts,
      refs: this.#refs,
      imageGeneration: this.#imageGeneration,
      conversationRuntime: this.#conversationRuntime,
      contextInjectors: this.#contextInjectors,
    };
  }

  get conversationRuntime(): ConversationRuntime {
    return this.#conversationRuntime;
  }

  /**
   * Checks the per-invocation tool registry against a model's context window.
   * The model is passed in because the caller resolves it: `/model` switches and
   * reloads validate against the model the run will actually get, which is not
   * the one this runtime was constructed with.
   */
  validateAdditionalTools(context: InvocationContext, additionalTools: readonly AgentTool[], model: Model<Api>): void {
    validateAdditionalTools(this.#services, context, additionalTools, model);
  }

  /** Current definitions only; scene tests never receive these production executors. */
  sceneToolDefinitions(
    context: InvocationContext,
    config: RawConfig,
  ): {
    readonly tools: readonly AgentTool[];
    readonly capabilities: readonly AgentTool[];
  } {
    return sceneToolDefinitions(this.#services, context, config);
  }

  async run(
    invocationId: bigint,
    snapshot: InvocationConfigSnapshot,
    schedulerSignal: AbortSignal,
  ): Promise<InvocationOutcome> {
    try {
      return await this.#runInvocation(invocationId, snapshot, schedulerSignal);
    } catch (error) {
      // The scheduler persists an outcome vocabulary, not a message, so an error
      // that escapes the run would leave `completion_reason: 'invocation_error'`
      // and nothing else. A stored row that no longer decodes once did exactly
      // that and failed every invocation of one conversation until someone read
      // the database by hand; the message has to reach the log.
      if (!schedulerSignal.aborted) {
        logInvocationError(this.#services, invocationId, error);
      }
      throw error;
    }
  }

  /**
   * One invocation, phase by phase. The lifecycle itself lives in
   * `agent-runtime-run.ts`; this keeps the error path of `run` next to the
   * public surface.
   */
  async #runInvocation(
    invocationId: bigint,
    snapshot: InvocationConfigSnapshot,
    schedulerSignal: AbortSignal,
  ): Promise<InvocationOutcome> {
    return runInvocation(this.#services, invocationId, snapshot, schedulerSignal);
  }

  recordAgentMessage(
    invocationId: bigint,
    role: 'assistant' | 'tool_result' | 'harness_nudge',
    text: string,
    thinking = '',
  ): bigint {
    return recordAgentMessage(this.#services, invocationId, role, text, thinking);
  }
}
