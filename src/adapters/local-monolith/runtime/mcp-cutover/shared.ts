/**
 * The values one MCP cutover is built from, and the result it reports back.
 *
 * The steps live next to this file: `stop.ts` fences and stops the affected
 * Conversations, `continuation.ts` rebuilds and continues them, and `index.ts`
 * publishes one change and runs the steps in order.
 */
import type { McpManager } from '../../../../capabilities/mcp/index.ts';
import type { McpServerReconcileResult } from '../../../../capabilities/mcp/shared.ts';
import type { RawConfig } from '../../../../platform/config/index.ts';
import type { HostReadiness } from '../../../../orchestration/host-scope.ts';
import type { ResumeBlockReason } from '../../../../orchestration/invocation-queue/resume.ts';
import type { RuntimeConfigurationStore } from '../../../../platform/runtime-config.ts';
import type { BusinessStore } from '../../../../store/store.ts';
import type { InvocationStopper } from '../chat-lifecycle.ts';
import { logEvent } from '../support.ts';

/** How long a cutover waits in-line before handing the rest to `completion`. */
export const CUTOVER_WAIT_MILLISECONDS = 30_000;
/** How many re-checks a cutover makes for Conversations created while it waits. */
export const MAX_FENCE_RECHECKS = 8;

export const NO_SERVER_CHANGES: McpServerReconcileResult = {
  added: [],
  replaced: [],
  removed: [],
  failed: [],
  stale: false,
};

export interface RunningInvocation {
  readonly id: bigint;
  readonly conversationId: bigint;
  readonly hostKind: string;
  readonly hostChatId: bigint | null;
}

/** One run this cutover stopped, with what its continuation still needs. */
export interface StoppedInvocation extends RunningInvocation {
  /** False: the run had finished its round and only waited for new messages. */
  readonly roundInProgress: boolean;
  readonly toolNames: ReadonlySet<string>;
}

/** Everything one cutover holds while it stops work: fences, and what it stopped. */
export interface CutoverState {
  readonly affectedChatIds: readonly bigint[];
  readonly fences: (() => void)[];
  /** Conversation ids fenced so far, keyed as strings (bigint keys compare by reference). */
  readonly fenced: Set<string>;
  /** Runs stopped so far, by invocation id. */
  readonly stopped: Map<string, StoppedInvocation>;
}

/** A run this cutover stopped and could not continue; the reason is logged. */
export interface SkippedResume {
  readonly invocationId: bigint;
  readonly reason: ResumeBlockReason | 'idle';
}

export interface McpConfigPublishResult {
  readonly affectedChats: readonly number[];
  readonly conversations: number;
  readonly stoppedInvocations: number;
  /** Contexts rebuilt before this call returned; 0 while `settled` is false. */
  readonly rebuiltContexts: number;
  readonly resumedInvocations: readonly bigint[];
  readonly skippedResumes: readonly SkippedResume[];
  /** What happened to the server instances; all empty while `settled` is false. */
  readonly servers: McpServerReconcileResult;
  /** False: a handler outlived the in-line wait and the rest runs asynchronously. */
  readonly settled: boolean;
  /** Resolves once the cutover finished; already resolved when `settled` is true. */
  readonly completion: Promise<void>;
}

export interface McpCutoverDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly scheduler: InvocationStopper;
  readonly isHostReady: HostReadiness;
  readonly mcp: Pick<McpManager, 'reconcile' | 'toolNamesForChat'>;
  /** Whether the Conversation is mid-round right now (its run is answering). */
  readonly roundInProgress: (conversationId: bigint) => boolean;
  readonly forgetConversation: (conversationId: bigint) => void;
  readonly redactError: (error: unknown) => string;
  readonly waitMilliseconds?: number;
}

/**
 * The serialized entry point the composition root owns.
 *
 * A publish whose handlers outlive the in-line wait returns early while its
 * fence stays up; the next publish must then wait for that cutover to finish
 * before it computes or reconciles anything, or it would act on an instance set
 * the first one still owns. That wait is bounded: a handler that never settles
 * queues the later cutover behind its own and returns a pending result, so a
 * stuck run can never hold the configuration lock.
 */
export interface McpCutover {
  publish(
    previous: RawConfig,
    next: RawConfig,
    generation: number,
    rotated?: ReadonlySet<string>,
  ): Promise<McpConfigPublishResult>;
}

export function releaseFences(state: CutoverState): void {
  for (const release of state.fences.splice(0)) {
    release();
  }
}

export function logCutover(result: McpConfigPublishResult): void {
  logEvent('mcp_config_published', {
    affected_chats: result.affectedChats.join(','),
    conversations: result.conversations,
    stopped_invocations: result.stoppedInvocations,
    rebuilt_contexts: result.rebuiltContexts,
    resumed_invocations: result.resumedInvocations.length,
    skipped_resumes: result.skippedResumes.map((skip) => `${skip.invocationId}:${skip.reason}`).join(','),
    added_servers: result.servers.added.join(','),
    replaced_servers: result.servers.replaced.join(','),
    removed_servers: result.servers.removed.join(','),
    failed_servers: result.servers.failed.map((failure) => `${failure.alias}:${failure.error}`).join('|'),
    stale: result.servers.stale,
    settled: result.settled,
  });
}
