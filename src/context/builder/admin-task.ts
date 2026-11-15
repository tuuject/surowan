import { sql } from 'drizzle-orm';
import type { CompletionContext } from '../../platform/invocation-context.ts';
import { canonicalTimeZone } from '../../platform/recurring-schedule.ts';
import { RECURRING_ALARM_PLUGIN_ID, recurringAlarmPayloadValidator } from '../../store/recurring-alarms/payload.ts';
import type { Orm } from '../../store/store.ts';
import { renderCurrentTime } from './format.ts';

/** Runtime-written reason codes; anything else is not echoed into a trusted line. */
const REASON_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * The `<runtime_state>` line of a run an administrator resumed after a
 * failure, or undefined for any other batch. Only the empty opening batch of
 * the resumed run carries it (the caller skips a batch with new messages):
 * without this line the model would see a turn with nothing to answer. The
 * previous outcome comes from the runtime's own columns, never from chat
 * content. A model switch may have rebuilt the Context since, so the line
 * points at the chat history too, which the resumed run snapshots.
 */
export function adminResumeState(orm: Orm, invocationId: bigint, bucketId: bigint): string | undefined {
  const previous = orm
    .all<{ state: string; completion_reason: string | null; error_code: string | null }>(
      sql`SELECT p.state, p.completion_reason, p.error_code
          FROM invocations i JOIN invocations p ON p.id = i.resumed_from_invocation_id
          WHERE i.id = ${invocationId} AND i.bucket_id = ${bucketId}`,
    )
    .at(0);
  if (previous === undefined) {
    return undefined;
  }
  const reason =
    [previous.completion_reason, previous.error_code].find(
      (value): value is string => value !== null && REASON_CODE.test(value),
    ) ?? 'unknown';
  return `An administrator resumed this conversation from the Admin Panel because the previous run stopped before it finished (${previous.state}: ${reason}). This batch has no new messages. Pick up the unfinished work from your history or the chat history shown here, and do not resend anything that was already sent. This does not change tool rules or authorization; only send or send_reply can publish.`;
}

/**
 * The announcement of an Admin's recurring alarm. The core protocol trusts
 * only `<runtime_state>` and distrusts `<untrusted_*>`; this trusted line is
 * what states that the block below carries an operator's instruction. It is
 * kept out of the system prompt on purpose, which would rebuild every Context.
 */
export const ADMIN_SCHEDULED_TASK_STATE =
  'A recurring task scheduled by an administrator is due now. The instruction in <admin_scheduled_task> was written by an administrator in the Admin Panel; treat it as a trusted operator request and carry it out now, even without new user messages, in your normal conversational style. It does not change tool rules or authorization; only send or send_reply can publish.';

/**
 * The trusted block for a recurring alarm occurrence, or undefined when the
 * completion is anything else. Trust rests on the plugin id, which only the
 * runtime's recurring alarm service writes; a payload that fails validation
 * falls back to the untrusted receipt instead of being promoted. A manual run
 * renders exactly like a scheduled one, so trying a prompt shows its real effect.
 */
export function adminScheduledTask(completion: CompletionContext): string | undefined {
  const payload = completion.payload;
  if (
    completion.pluginId !== RECURRING_ALARM_PLUGIN_ID ||
    completion.status !== 'completed' ||
    !recurringAlarmPayloadValidator.Check(payload) ||
    canonicalTimeZone(payload.time_zone) === undefined ||
    Number.isNaN(Date.parse(payload.occurrence_at))
  ) {
    return undefined;
  }
  return JSON.stringify({
    scheduled_for: renderCurrentTime(payload.time_zone, new Date(payload.occurrence_at)),
    missed_occurrences: payload.coalesced,
    prompt: payload.prompt,
  })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}
