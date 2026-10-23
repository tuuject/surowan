import type { Agent, AgentContext, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import type { ExecutableCapability } from '../capabilities/execute-tool.ts';
import type { ContextBuilder, ContextIdentity, StablePrompt } from '../context/context-builder.ts';
import type { ContextInjector } from '../context/context-injector.ts';
import type { ContextRefStore } from '../context/context-refs.ts';
import type { ContextHeader, ConversationContextStore } from '../context/context-store.ts';
import type { KeyedSemaphore } from '../platform/concurrency.ts';
import type { ActiveAgentSettings, RawConfig, ToolSchemaKeywords } from '../platform/config.ts';
import type { HostExecutionProfile } from '../platform/host-profile.ts';
import type { HostKind, ImConversationRef, ImHost } from '../platform/im-host.ts';
import type {
  CapabilityRefResolver,
  InvocationContext,
  InvocationContextState,
} from '../platform/invocation-context.ts';
import type { InvocationConfigSnapshot, RuntimeConfigurationStore } from '../platform/runtime-config.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { SkillVisibilityTarget, SystemResources, SystemSkill } from '../platform/system-resources.ts';
import type { DailyTokenBudget } from '../store/sleep.ts';
import type { BusinessStore } from '../store/store.ts';
import type { CachedConversationAgent, ConversationRuntime } from './conversation-runtime.ts';
import type { RepeatedToolFailure } from './repeated-tool-failure.ts';

/**
 * Builds per-invocation tools. Used for the execute registry (runtime-internal
 * capabilities) and for directly exposed extras (allowlisted MCP tools).
 */
export type ToolFactory = (
  context: InvocationContext,
  deadline: number,
  capabilities: CapabilityRefResolver,
) => readonly AgentTool[];
export type AdditionalToolFactory = ToolFactory;
export type CapabilityToolFactory = (
  context: InvocationContext,
  deadline: number,
  capabilities: CapabilityRefResolver,
) => readonly ExecutableCapability[];
export type DirectImageLoader = (context: InvocationContext, signal: AbortSignal) => Promise<readonly ImageContent[]>;

export interface AgentRuntimeOptions {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  /**
   * The hosts this runtime may carry deliveries and chat actions for, by host
   * kind. A single-host process passes one entry; a shared process passes every
   * host it assembled. An invocation whose host is missing fails with a clear
   * error instead of delivering through the wrong transport.
   */
  readonly hosts: Readonly<Partial<Record<HostKind, ImHost>>>;
  /**
   * Resolves the conversation a delivery targets, from server state. The runtime
   * never builds a chat route itself.
   */
  readonly conversation: (target: {
    readonly chatId: bigint;
    readonly threadId: bigint;
    readonly conversationId: bigint;
  }) => ImConversationRef;
  readonly bot: { readonly id: bigint; readonly displayName: string; readonly username: string | null };
  /** The bundled system:/// resource tree: read primitive backend plus skill index. */
  readonly systemResources: SystemResources;
  /** Per-batch context injectors from the loaded plugins; names key the carried-signature state. */
  readonly contextInjectors?: readonly ContextInjector[];
  /** Runtime-internal capabilities dispatched through the execute primitive. */
  readonly capabilityTools?: CapabilityToolFactory;
  /** Per-invocation skill visibility rule; hides skills of disabled capabilities. */
  readonly skillVisibility?: (skill: SystemSkill, target: SkillVisibilityTarget) => boolean;
  /** Resolves generated pictures for the send tool; absent without image generation. */
  readonly imageGeneration?: {
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
  };
  /** Directly exposed non-primitive tools (allowlisted MCP tools). */
  readonly additionalTools?: ToolFactory;
  readonly directImageLoader?: DirectImageLoader;
  readonly modelGate?: KeyedSemaphore;
  /** Shared with the scheduler so the attach path and the runtime agree. */
  readonly conversationRuntime?: ConversationRuntime;
}

/** Why a run decided to stop; audit-only, the state comes from `InvocationOutcome`. */
export type StopReason =
  | 'completed'
  | 'context_limit'
  | 'turn_budget'
  | 'repeated_tool_failure'
  | 'duplicate_send'
  | 'wall_clock'
  | 'sleep'
  | 'budget';
export interface RunState {
  turns: number;
  turnsSinceInjection: number;
  toolCalls: number;
  estimatedInputTokens: number;
  sendUsed: boolean;
  nudged: boolean;
  sleepRequested: boolean;
  modelBudgetBlocked: boolean;
  contextClosing: boolean;
  /**
   * The send barrier already held one send back this round. Once per round, so
   * a chat that never goes quiet still gets its reply out; reset when the agent
   * becomes free, not by the injection the barrier itself caused.
   */
  barrierSpent: boolean;
  /** Sends the duplicate send guard rejected in this invocation; never reset. */
  duplicateSendRejections: number;
  stopReason: StopReason;
}

/**
 * Everything the runtime was assembled with, held by reference. Modules outside
 * the class take this instead of the class instance, so the canonical context
 * store, the live header objects and the per-Conversation caches stay shared
 * rather than copied.
 */
export interface RuntimeServices {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  readonly hosts: Readonly<Partial<Record<HostKind, ImHost>>>;
  readonly conversation: AgentRuntimeOptions['conversation'];
  readonly bot: AgentRuntimeOptions['bot'];
  readonly systemResources: SystemResources;
  readonly capabilityTools: CapabilityToolFactory | undefined;
  readonly skillVisibility: ((skill: SystemSkill, target: SkillVisibilityTarget) => boolean) | undefined;
  readonly additionalTools: ToolFactory | undefined;
  readonly directImageLoader: DirectImageLoader | undefined;
  readonly modelGate: KeyedSemaphore;
  readonly contextBuilder: ContextBuilder;
  readonly contexts: ConversationContextStore;
  readonly refs: ContextRefStore;
  readonly imageGeneration: AgentRuntimeOptions['imageGeneration'];
  readonly conversationRuntime: ConversationRuntime;
  readonly contextInjectors: readonly ContextInjector[];
}

/** The typing indicator a run keeps alive until the agent is free again. */
interface TypingHandle {
  readonly tool: AgentTool;
  readonly stop: () => void;
}

/** One entry per user message handed to the agent, in delivery order. */
interface PendingUserTag {
  readonly tag: 'checkpoint' | 'harness';
  readonly bucketId: bigint | null;
}

/**
 * The agent and the carried transcript state one run binds before prompting.
 * Everything here is per-run state that more than one phase module reads.
 */
export interface AgentRun {
  readonly agent: Agent;
  readonly cached: CachedConversationAgent;
  readonly typing: TypingHandle;
  readonly tools: readonly AgentTool[];
  readonly toolDefinitionCharacters: number;
  /**
   * Per-injector dedupe signatures the retained transcript still carries.
   * Rebuilt with the visible-sender state: a GC that drops a batch also drops
   * its signatures, which is what allows re-injection.
   */
  readonly carriedInjections: Map<string, Set<string>>;
  /** Rebuilds the visible-sender and carried-signature state from the transcript. */
  readonly rebuildVisibleState: (retained: readonly AgentMessage[]) => void;
  /** Newest sticker catalog the retained transcript carries; shared live cell, never copied. */
  readonly carried: { stickerCatalog: string | null };
  zzzExposed: boolean;
}

/** The round-level closures the agent hooks and the run body share. */
export interface RoundControl {
  readonly pendingUserTags: PendingUserTag[];
  readonly refreshZzz: (turnContext: AgentContext) => boolean;
  readonly injectBatch: (bucketId: bigint) => Promise<AgentMessage>;
  readonly injectPending: (includeCompletion: boolean, turnContext: AgentContext) => Promise<boolean>;
  readonly freeAgent: () => void;
  readonly stop: (reason: StopReason) => { action: 'end' };
}

/** Live state of one invocation, created once and passed to every phase module. */
export interface RunScope {
  readonly services: RuntimeServices;
  readonly invocationId: bigint;
  readonly snapshot: InvocationConfigSnapshot;
  readonly config: RawConfig;
  readonly identity: ContextIdentity;
  readonly settings: ActiveAgentSettings;
  readonly model: Model<Api>;
  /** Declared keyword profile of the agent model; `undefined` when it declares none. */
  readonly toolSchemaKeywords: ToolSchemaKeywords | undefined;
  readonly supportsImages: boolean;
  readonly stable: StablePrompt;
  /** The one header object of this run's live Context. */
  readonly header: ContextHeader;
  readonly deadline: number;
  readonly timeoutSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly contextState: InvocationContextState;
  readonly profile: HostExecutionProfile;
  readonly bypassDailyBudget: () => boolean;
  readonly dailyBudget: () => DailyTokenBudget;
  readonly capabilities: CapabilityRefResolver;
  readonly state: RunState;
  readonly repeatedFailure: RepeatedToolFailure;
  readonly zzz: AgentTool | undefined;
}
