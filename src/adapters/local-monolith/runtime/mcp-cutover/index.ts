/**
 * The MCP side of one configuration publish.
 *
 * A published `mcp` change is not a simple setting: a Chat's tool set is part of
 * the Conversation Context it was handed to. When a Chat loses a server, a
 * binding tightens, or a server it reaches changes any field, its running
 * Invocations would keep calling tools from the configuration they started
 * with, and the Context they continue to write would mix two tool worlds. The
 * cutover therefore:
 *
 * 1. fences every Conversation of the affected Chats, so nothing new launches,
 *    and keeps fencing the ones that appear while it waits (a new forum topic is
 *    a new Conversation),
 * 2. aborts the running Invocations and waits for them to settle,
 * 3. rebuilds their canonical Contexts (only now, so no stale writer survives),
 * 4. swaps, adds or closes the server instances,
 * 5. queues one continuation per aborted run that was still answering,
 * 6. releases the fences.
 *
 * A pure addition (a new server, a wider binding) touches no Context: the next
 * Invocation simply resolves the larger set.
 */
import { affectedMcpChatIds } from '../../../../capabilities/mcp/bindings.ts';
import type { RawConfig } from '../../../../platform/config/index.ts';
import { conversationIdsForTelegramChats } from '../chat-lifecycle.ts';
import { logEvent } from '../support.ts';
import { finishCutover } from './continuation.ts';
import {
  CUTOVER_WAIT_MILLISECONDS,
  logCutover,
  type CutoverState,
  type McpConfigPublishResult,
  type McpCutover,
  type McpCutoverDeps,
  NO_SERVER_CHANGES,
  releaseFences,
} from './shared.ts';
import { stopEverything } from './stop.ts';

export function createMcpCutover(deps: McpCutoverDeps): McpCutover {
  let tail: Promise<void> = Promise.resolve();
  const queueWait = deps.waitMilliseconds ?? CUTOVER_WAIT_MILLISECONDS;
  return {
    async publish(previous, next, generation) {
      const previousCutover = tail;
      const slot = Promise.withResolvers<void>();
      tail = slot.promise;
      if (await settlesWithin(previousCutover, queueWait)) {
        try {
          const result = await publishMcpConfig(deps, previous, next, generation);
          // The queue releases only when the whole cutover finished, including a
          // handed-off remainder; this caller still gets its early result.
          void result.completion.then(slot.resolve, slot.resolve);
          return result;
        } catch (error) {
          slot.resolve();
          throw error;
        }
      }
      // The previous cutover is stuck on a handler that will not settle. This
      // publish must still return in bounded time — `onPublished` runs under the
      // reloader lock — so its cutover is queued after that one, in order, and
      // reported as pending. The generation guard keeps the older cutover from
      // reconciling over this one once its turn finally comes.
      const completion = previousCutover
        .catch(() => undefined)
        .then(async () => {
          const result = await publishMcpConfig(deps, previous, next, generation);
          await result.completion;
        })
        .catch((error: unknown) => logEvent('mcp_cutover_failed', { error: deps.redactError(error) }))
        .finally(slot.resolve);
      const pending: McpConfigPublishResult = {
        affectedChats: affectedMcpChatIds(previous, next),
        conversations: 0,
        stoppedInvocations: 0,
        rebuiltContexts: 0,
        resumedInvocations: [],
        skippedResumes: [],
        servers: NO_SERVER_CHANGES,
        settled: false,
        completion,
      };
      logCutover(pending);
      return pending;
    },
  };
}

/** Resolves true when `promise` settles within `milliseconds`, false otherwise. */
function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(settle, settle);
  });
}

/**
 * Applies one published `mcp` change. The configuration is already published
 * when this runs; every Conversation that may still hold the previous tool set
 * is stopped and rebuilt before the server instances move underneath it.
 */
async function publishMcpConfig(
  deps: McpCutoverDeps,
  previous: RawConfig,
  next: RawConfig,
  generation: number,
): Promise<McpConfigPublishResult> {
  const affectedChats = affectedMcpChatIds(previous, next);
  const affectedChatIds = affectedChats.map((id) => BigInt(id));
  if (conversationIdsForTelegramChats(deps.store, affectedChatIds).length === 0) {
    const servers = await deps.mcp.reconcile({ config: next, generation });
    const result: McpConfigPublishResult = {
      affectedChats,
      conversations: 0,
      stoppedInvocations: 0,
      rebuiltContexts: 0,
      resumedInvocations: [],
      skippedResumes: [],
      servers,
      settled: true,
      completion: Promise.resolve(),
    };
    logCutover(result);
    return result;
  }
  const state: CutoverState = { affectedChatIds, fences: [], fenced: new Set(), stopped: new Map() };
  let handedOff = false;
  try {
    const stop = await stopEverything(deps, state, previous, 'wait');
    if (!stop.settled) {
      // The instances may not move while a stopped handler could still call
      // them, so the fences stay up and the rest runs after it settles.
      handedOff = true;
      const completion = deps.scheduler
        .settleInvocations(stop.pending)
        .then(async () => {
          const finished = await finishCutover(deps, state, next, generation);
          logCutover({
            ...finished,
            affectedChats,
            stoppedInvocations: state.stopped.size,
            conversations: state.fenced.size,
            settled: true,
            completion: Promise.resolve(),
          });
        })
        .catch((error: unknown) => logEvent('mcp_cutover_failed', { error: deps.redactError(error) }))
        .finally(() => releaseFences(state));
      const pending: McpConfigPublishResult = {
        affectedChats,
        conversations: state.fenced.size,
        stoppedInvocations: state.stopped.size,
        rebuiltContexts: 0,
        resumedInvocations: [],
        skippedResumes: [],
        servers: NO_SERVER_CHANGES,
        settled: false,
        completion,
      };
      logCutover(pending);
      return pending;
    }
    const finished = await finishCutover(deps, state, next, generation);
    const result: McpConfigPublishResult = {
      ...finished,
      affectedChats,
      stoppedInvocations: state.stopped.size,
      conversations: state.fenced.size,
      settled: true,
      completion: Promise.resolve(),
    };
    logCutover(result);
    return result;
  } finally {
    if (!handedOff) {
      releaseFences(state);
    }
  }
}
