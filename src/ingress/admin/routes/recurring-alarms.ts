import type { RuntimeConfigurationStore } from '../../../platform/runtime-config.ts';
import type { RecurringAlarmService } from '../../../store/recurring-alarms/index.ts';
import type { RecurringAlarmRecord } from '../../../store/recurring-alarms/records.ts';
import type { BusinessStore } from '../../../store/store.ts';
import { json, readJsonObject, requiredRevision, revisionRequired } from '../http.ts';
import {
  parseRecurringCreate,
  parseRecurringDraft,
  parseRecurringId,
  parseRecurringRevision,
  previewSchedule,
  recurringResponse,
} from '../recurring-alarms/requests.ts';
import { listRecurringTargets } from '../recurring-alarms/targets.ts';
import { listRecurringAlarms, recurringAlarmDetail, recurringAlarmView } from '../recurring-alarms/views.ts';

/** A prompt of 4000 characters may take four bytes each before JSON escaping. */
const RECURRING_BODY_MAX_BYTES = 65_536;

export interface RecurringAlarmsAdminDeps {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  /** Absent in standalone panels without a Scheduler; every route then answers 503. */
  readonly recurring: RecurringAlarmService | undefined;
}

/** `/api/recurring-alarms*`: definitions, targets, the schedule preview and Run now. */
export function createRecurringAlarmsAdminHandler(deps: RecurringAlarmsAdminDeps) {
  const { store, configStore } = deps;

  const handle = async (
    request: Request,
    url: URL,
    segments: readonly string[],
    username: string,
    recurring: RecurringAlarmService,
  ): Promise<Response> => {
    const { orm } = store;
    const [, first, second] = segments;
    if (segments.length === 1 && request.method === 'GET') {
      const load = (ids: readonly bigint[]): RecurringAlarmRecord[] =>
        ids.flatMap((id) => {
          const record = recurring.get(id);
          return record === undefined ? [] : [record];
        });
      return json(
        listRecurringAlarms(
          orm,
          {
            limit: url.searchParams.get('limit'),
            offset: url.searchParams.get('offset'),
            as_of: url.searchParams.get('as_of'),
            chat: url.searchParams.get('chat'),
            enabled: url.searchParams.get('enabled'),
          },
          load,
        ),
      );
    }
    if (segments.length === 1 && request.method === 'POST') {
      const body = parseRecurringCreate(await readJsonObject(request, RECURRING_BODY_MAX_BYTES));
      const target = listRecurringTargets(orm, configStore.current().config).find(
        (option) =>
          option.chat_id === body.chatId.toString() && option.message_thread_id === body.messageThreadId.toString(),
      );
      if (target === undefined) {
        return json(
          { error: 'target_unavailable', message: 'The target is not a configured Chat, Topic or room' },
          409,
        );
      }
      // One transaction: a refused draft leaves no Conversation row behind.
      return recurringResponse(() =>
        store.transaction(() => {
          const conversationId =
            target.conversation_id === null
              ? recurring.ensureConversation(body.chatId, body.messageThreadId)
              : BigInt(target.conversation_id);
          return recurringAlarmView(orm, recurring.create(conversationId, body.draft, username));
        }),
      );
    }
    if (segments.length === 2 && first === 'targets' && request.method === 'GET') {
      const config = configStore.current().config;
      // The global zone is what a new alarm defaults to; each alarm keeps its own afterwards.
      return json({ items: listRecurringTargets(orm, config), default_time_zone: config.timezone });
    }
    if (segments.length === 2 && first === 'preview' && request.method === 'POST') {
      return json(previewSchedule(recurring.engine, await readJsonObject(request, RECURRING_BODY_MAX_BYTES)));
    }
    if (segments.length === 2 && first !== undefined) {
      const id = parseRecurringId(first);
      if (request.method === 'GET') {
        const record = recurring.get(id);
        return record === undefined
          ? json({ error: 'not_found', message: 'Recurring alarm does not exist' }, 404)
          : json(recurringAlarmDetail(orm, record));
      }
      if (request.method === 'PUT') {
        const header = requiredRevision(request);
        if (header === null) {
          return revisionRequired();
        }
        const revision = parseRecurringRevision(header);
        const draft = parseRecurringDraft(await readJsonObject(request, RECURRING_BODY_MAX_BYTES));
        return recurringResponse(() => recurringAlarmView(orm, recurring.update(id, revision, draft, username)));
      }
      if (request.method === 'DELETE') {
        return recurringResponse(() => {
          recurring.delete(id, username);
          return { status: 'deleted' };
        });
      }
    }
    if (segments.length === 3 && first !== undefined && second === 'run' && request.method === 'POST') {
      const id = parseRecurringId(first);
      return recurringResponse(() => {
        const run = recurring.runNow(id, username);
        return {
          firing_id: run.firingId.toString(),
          task_id: run.taskId.toString(),
          occurrence_at: run.occurrenceAt,
        };
      });
    }
    return json({ error: 'not_found', message: 'Unknown recurring alarm route' }, 404);
  };

  return {
    async handle(
      request: Request,
      url: URL,
      segments: readonly string[],
      username: string,
    ): Promise<Response | undefined> {
      if (segments[0] !== 'recurring-alarms') {
        return undefined;
      }
      const recurring = deps.recurring;
      if (recurring === undefined) {
        return json({ error: 'recurring_alarms_unavailable', message: 'Recurring alarms are not wired' }, 503);
      }
      return await handle(request, url, segments, username, recurring);
    },
  };
}
