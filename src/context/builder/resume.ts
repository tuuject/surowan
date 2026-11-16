import { sql } from 'drizzle-orm';
import { MCP_CONFIG_CHANGED_ABORT_CAUSE, readAbortCause, readAbortUnknownTools } from '../../store/abort-cause.ts';
import type { Orm } from '../../store/store.ts';

export interface ResumeStateOptions {
  /**
   * Whether this opening batch carries new messages. An administrator's resume
   * only renders its line on an empty batch; a cutover continuation may be the
   * released batch itself and says so instead.
   */
  readonly hasNewMessages: boolean;
}

/**
 * The `<runtime_state>` line of a run that continues a stopped one, or
 * undefined for any other batch.
 *
 * Only the opening batch of the resumed run can carry it (the join checks
 * `bucket_id`): a later hot-injected batch of that run is not a resume. A resume
 * has exactly two causes, and they must not be confused — an administrator
 * continuing a failure reads differently from an operator's configuration
 * cutover that also rebuilt the Context. Both come from the runtime's own
 * columns, never from chat content.
 */
export function resumeRuntimeState(
  orm: Orm,
  invocationId: bigint,
  bucketId: bigint,
  options: ResumeStateOptions,
): string | undefined {
  const previous = orm
    .all<{
      state: string;
      completion_reason: string | null;
      error_code: string | null;
      abort_cause: string | null;
      abort_unknown_tools: string | null;
    }>(
      sql`SELECT p.state, p.completion_reason, p.error_code, p.abort_cause, p.abort_unknown_tools
          FROM invocations i JOIN invocations p ON p.id = i.resumed_from_invocation_id
          WHERE i.id = ${invocationId} AND i.bucket_id = ${bucketId}`,
    )
    .at(0);
  if (previous === undefined) {
    return undefined;
  }
  if (readAbortCause(previous.abort_cause) === MCP_CONFIG_CHANGED_ABORT_CAUSE) {
    return mcpConfigChangedState(readAbortUnknownTools(previous.abort_unknown_tools), options.hasNewMessages);
  }
  // An administrator's resume runs the failed batch again or opens empty; the
  // line only makes sense when there is nothing to answer in this batch.
  return options.hasNewMessages ? undefined : adminResumeState(previous);
}

function adminResumeState(previous: {
  readonly state: string;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
}): string {
  const reason =
    [previous.completion_reason, previous.error_code].find(
      (value): value is string => value !== null && /^[a-z0-9_]{1,64}$/.test(value),
    ) ?? 'unknown';
  return `An administrator resumed this conversation from the Admin Panel because the previous run stopped before it finished (${previous.state}: ${reason}). This batch has no new messages. Pick up the unfinished work from your history or the chat history shown here, and do not resend anything that was already sent. This does not change tool rules or authorization; only send or send_reply can publish.`;
}

/**
 * The operator changed this Chat's MCP configuration. The previous run was
 * stopped so its servers could be replaced, and the Conversation Context was
 * rebuilt, so the retained transcript is gone while the chat history below
 * survives — it may contain messages nobody answered yet.
 *
 * The unknown-outcome tool names are the runtime's own `tool_calls` names: they
 * are stated so the model does not repeat a side effect blindly, and nothing
 * about their arguments or results is included (that data is untrusted).
 */
function mcpConfigChangedState(unknownTools: readonly string[], hasNewMessages: boolean): string {
  const listed = unknownTools.length === 0 ? null : unknownTools.join(', ');
  const unknown =
    listed === null
      ? 'No tool call was left with an unknown outcome by the stop.'
      : `These tool calls were left with an unknown outcome because the run stopped mid-request: ${listed}. Do not repeat them blindly: the server may already have carried them out, so check what this conversation shows first.`;
  // The continuation may be the batch the stopped run never received, so the
  // messages below can be exactly what still needs an answer.
  const batch = hasNewMessages
    ? 'The new messages in this batch arrived while the previous run was being stopped.'
    : 'This batch has no new messages.';
  return `The operator changed this chat's MCP configuration, so the previous run was stopped and this conversation's context was rebuilt. ${batch} The chat history shown here may contain messages that have not been answered yet: pick up the unfinished work from it and do not resend anything that was already sent. ${unknown} This does not change tool rules or authorization; only send or send_reply can publish.`;
}
