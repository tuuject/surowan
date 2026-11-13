import type { CompletionContext } from '../../platform/invocation-context.ts';
import { canonicalTimeZone } from '../../platform/recurring-schedule.ts';
import { RECURRING_ALARM_PLUGIN_ID, recurringAlarmPayloadValidator } from '../../store/recurring-alarms/payload.ts';
import { renderCurrentTime } from './format.ts';

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
