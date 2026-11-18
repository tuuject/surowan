/**
 * Fencing and stopping: the first half of a cutover.
 *
 * Every Conversation of an affected Chat is fenced before its run is aborted,
 * and the pass repeats so a Conversation created while the first one waited (a
 * new Forum Topic) is fenced and stopped too, instead of having its server
 * swapped underneath it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { RawConfig } from '../../../../platform/config/index.ts';
import { MCP_CONFIG_CHANGED_ABORT_CAUSE } from '../../../../store/abort-cause.ts';
import { chats, conversations, invocations } from '../../../../store/schema/index.ts';
import type { Orm } from '../../../../store/store.ts';
import { conversationIdsForTelegramChats } from '../chat-lifecycle.ts';
import {
  CUTOVER_WAIT_MILLISECONDS,
  type CutoverState,
  MAX_FENCE_RECHECKS,
  type McpCutoverDeps,
  type RunningInvocation,
} from './shared.ts';

/**
 * Fences every Conversation of the affected Chats that appeared since the last
 * pass, then stops whatever still runs in the fenced ones. `wait` gives up after
 * the cutover timeout; `settle` waits as long as it takes (the handoff path is
 * already committed). Repeating the pass is what catches a forum topic created
 * while the first pass waited: it is fenced before its own run can be swapped.
 */
export async function stopEverything(
  deps: McpCutoverDeps,
  state: CutoverState,
  previous: RawConfig,
  mode: 'wait' | 'settle',
): Promise<{ readonly settled: boolean; readonly pending: readonly bigint[] }> {
  let rechecks = 0;
  for (;;) {
    const fresh = conversationIdsForTelegramChats(deps.store, state.affectedChatIds).filter(
      (conversationId) => !state.fenced.has(conversationId.toString()),
    );
    if (fresh.length > 0) {
      state.fences.push(deps.scheduler.fenceConversations(fresh));
      for (const conversationId of fresh) {
        state.fenced.add(conversationId.toString());
      }
    }
    const running = runningInvocations(deps.store.orm, [...state.fenced].map(BigInt)).filter(
      (row) => !state.stopped.has(row.id.toString()),
    );
    if (running.length === 0) {
      if (fresh.length === 0 || rechecks >= MAX_FENCE_RECHECKS) {
        return { settled: true, pending: [] };
      }
      // A newly fenced Conversation may already have launched a run; look again.
      rechecks += 1;
      continue;
    }
    const invocationIds = running.map((row) => row.id);
    for (const row of running) {
      state.stopped.set(row.id.toString(), {
        ...row,
        roundInProgress: deps.roundInProgress(row.conversationId),
        toolNames: new Set(deps.mcp.toolNamesForChat(row.telegramChatId, previous)),
      });
    }
    // Written before the stop: the row must keep its cause even if this process
    // dies between the abort and the settle.
    markAbortCause(deps.store.orm, invocationIds);
    deps.scheduler.abortInvocations(invocationIds, MCP_CONFIG_CHANGED_ABORT_CAUSE);
    if (mode === 'settle') {
      await deps.scheduler.settleInvocations(invocationIds);
      continue;
    }
    const settled = await deps.scheduler.waitForInvocations(
      invocationIds,
      deps.waitMilliseconds ?? CUTOVER_WAIT_MILLISECONDS,
    );
    if (!settled) {
      return { settled: false, pending: invocationIds };
    }
  }
}

function runningInvocations(orm: Orm, conversationIds: readonly bigint[]): RunningInvocation[] {
  if (conversationIds.length === 0) {
    return [];
  }
  return orm
    .select({
      id: invocations.id,
      conversationId: invocations.conversationId,
      telegramChatId: chats.hostChatId,
    })
    .from(invocations)
    .innerJoin(conversations, eq(conversations.id, invocations.conversationId))
    .innerJoin(chats, eq(chats.id, conversations.chatId))
    .where(and(inArray(invocations.conversationId, conversationIds), eq(invocations.state, 'running')))
    .orderBy(invocations.id)
    .all()
    .flatMap((row) =>
      row.telegramChatId === null
        ? []
        : [{ id: row.id, conversationId: row.conversationId, telegramChatId: row.telegramChatId }],
    );
}

function markAbortCause(orm: Orm, invocationIds: readonly bigint[]): void {
  orm
    .update(invocations)
    .set({ abortCause: MCP_CONFIG_CHANGED_ABORT_CAUSE })
    .where(inArray(invocations.id, invocationIds))
    .run();
}
