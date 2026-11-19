import type { RawConfig } from '../../platform/config/index.ts';
import { type HostKind, isHostKind } from '../../platform/im-host/identity.ts';
import type { BusinessStore } from '../../store/store.ts';
import { isChatPaused, resolveChatConfig } from '../../store/store.ts';
import { candidateChats, isChatBusy, type GroupMemoryChatRow } from './chats.ts';
import { chatLocalDay, localDayWindow, previousDay } from './day.ts';
import {
  lastMessageIdBefore,
  loadPendingMessages,
  newestPendingMessage,
  renderGroupTranscript,
  type GroupMemoryMessageRow,
} from './messages.ts';
import type { GroupMemoryStore } from './store.ts';
import {
  GROUP_MEMORY_BATCH_MAX_CHARACTERS,
  GROUP_MEMORY_DEFAULT_IDLE_MINUTES,
  type GroupMemoryLaneKind,
} from './index.ts';

export interface LaneCandidate {
  readonly chat: GroupMemoryChatRow;
  readonly lane: GroupMemoryLaneKind;
  readonly lastAttemptAt: string | null;
}

export interface Batch {
  readonly chatId: bigint;
  readonly telegramChatId: bigint;
  /** The host the Chat itself lives on; readiness is checked against it. */
  readonly hostKind: HostKind;
  readonly lane: GroupMemoryLaneKind;
  readonly day: string;
  readonly rows: readonly GroupMemoryMessageRow[];
}

/**
 * Least recently attempted lanes go first; live wins a tie. Aging across lane
 * kinds keeps a full live queue from consuming every tick's batch budget.
 * A live lane that fell more than a day behind is split first.
 */
export function laneCandidates(
  store: BusinessStore,
  groupMemory: GroupMemoryStore,
  config: RawConfig,
  now: Date,
): LaneCandidate[] {
  const candidates: LaneCandidate[] = [];
  for (const chat of candidateChats(store, config)) {
    splitBacklog(store, groupMemory, config, chat, now);
    for (const lane of groupMemory.lanes(chat.id)) {
      candidates.push({ chat, lane: lane.lane, lastAttemptAt: lane.lastAttemptAt });
    }
  }
  return candidates.sort(
    (left, right) =>
      (left.lastAttemptAt ?? '').localeCompare(right.lastAttemptAt ?? '') ||
      (left.lane === right.lane ? 0 : left.lane === 'live' ? -1 : 1),
  );
}

/**
 * Hands everything before yesterday to a backfill lane when the live lane's
 * oldest pending message is older than that, so yesterday and today are
 * summarized without waiting for the backlog. One backfill lane at a time: a
 * live lane that falls behind again while one runs catches up in order.
 */
function splitBacklog(
  store: BusinessStore,
  groupMemory: GroupMemoryStore,
  config: RawConfig,
  chat: GroupMemoryChatRow,
  now: Date,
): void {
  const live = groupMemory.lane(chat.id, 'live');
  if (live === undefined || live.state !== 'idle' || groupMemory.lane(chat.id, 'backfill') !== undefined) {
    return;
  }
  const oldest = loadPendingMessages(store.orm, chat.id, { after: live.throughMessageId, until: null }, 1)[0];
  if (oldest === undefined) {
    return;
  }
  const timezone = resolveChatConfig(config, store.orm, chat.host_chat_id)?.timezone ?? config.timezone;
  const yesterday = previousDay(chatLocalDay(now.toISOString(), timezone));
  if (chatLocalDay(oldest.sentAt, timezone) >= yesterday) {
    return;
  }
  const splitPoint = lastMessageIdBefore(store.orm, chat.id, localDayWindow(yesterday, timezone).start);
  if (splitPoint === undefined || !groupMemory.split(chat.id, splitPoint, now)) {
    return;
  }
  log('group_memory_backfill_started', {
    chat_id: chat.id.toString(),
    from: live.throughMessageId.toString(),
    until: splitPoint.toString(),
  });
}

/**
 * The batch one lane may summarize right now, or undefined. A lane contributes
 * at most its first pending Chat-local day, so a backlog is consolidated one
 * day at a time and never mixes two days into one memory batch.
 */
export function batchFor(
  store: BusinessStore,
  groupMemory: GroupMemoryStore,
  config: RawConfig,
  candidate: LaneCandidate,
  now: Date,
): Batch | undefined {
  const row = candidate.chat;
  const hostKind = isHostKind(row.host_kind) ? row.host_kind : undefined;
  if (hostKind === undefined) {
    return undefined;
  }
  const chat = resolveChatConfig(config, store.orm, row.host_chat_id);
  if (chat?.group_memory?.enabled !== true) {
    return undefined;
  }
  // `/pause` is an operator stop, not just a reply gate: it also stops
  // background model calls until the Chat resumes.
  if (isChatPaused(store.orm, row.id) || (candidate.lane === 'live' && isChatBusy(store, row.id))) {
    return undefined;
  }
  const lane = groupMemory.lane(row.id, candidate.lane);
  if (lane === undefined) {
    return undefined;
  }
  const range = { after: lane.throughMessageId, until: lane.untilMessageId };
  const pending = loadPendingMessages(store.orm, row.id, range);
  const first = pending[0];
  if (first === undefined) {
    if (candidate.lane === 'backfill' && groupMemory.finishBackfill(row.id)) {
      log('group_memory_backfill_finished', { chat_id: row.id.toString() });
    }
    return undefined;
  }
  const timezone = chat.timezone ?? config.timezone;
  const today = chatLocalDay(now.toISOString(), timezone);
  const day = chatLocalDay(first.sentAt, timezone);
  if (day > today) {
    // Clock skew or a future-dated message: wait instead of inventing a day.
    return undefined;
  }
  const window = localDayWindow(day, timezone);
  const dayRows = pending.filter((message) => message.sentAt >= window.start && message.sentAt < window.end);
  const rows = trimToBudget(dayRows);
  if (rows.length === 0) {
    return undefined;
  }
  if (day === today) {
    const newest = newestPendingMessage(store.orm, row.id, range);
    if (newest === undefined) {
      return undefined;
    }
    const idleMilliseconds = (chat.group_memory.idle_minutes ?? GROUP_MEMORY_DEFAULT_IDLE_MINUTES) * 60_000;
    if (now.getTime() - Date.parse(newest.sentAt) < idleMilliseconds) {
      return undefined;
    }
  }
  return { chatId: row.id, telegramChatId: row.host_chat_id, hostKind, lane: candidate.lane, day, rows };
}

function trimToBudget(rows: readonly GroupMemoryMessageRow[]): readonly GroupMemoryMessageRow[] {
  const selected: GroupMemoryMessageRow[] = [];
  let characters = 0;
  for (const row of rows) {
    const length = renderGroupTranscript([row]).length + 1;
    if (selected.length > 0 && characters + length > GROUP_MEMORY_BATCH_MAX_CHARACTERS) {
      break;
    }
    selected.push(row);
    characters += length;
  }
  return selected;
}

export function log(event: string, fields: Readonly<Record<string, string | number>>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
