import type { Models } from '@earendil-works/pi-ai';
import { sql } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { resolveToolModel, type ToolModelSelection } from '../../platform/tool-model.ts';
import type { BusinessStore } from '../../store/store.ts';
import { isChatPaused, resolveChatConfig } from '../../store/store.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { candidateChats, type GroupMemoryChatRow } from './chats.ts';
import { chatLocalDay, localDayWindow, previousDay } from './day.ts';
import { consolidateDay } from './consolidate.ts';
import {
  lastMessageIdBefore,
  loadPendingMessages,
  newestMessageId,
  newestPendingMessage,
  renderGroupTranscript,
  type GroupMemoryMessageRow,
} from './messages.ts';
import { GroupMemoryStore } from './store.ts';
import {
  GROUP_MEMORY_BATCH_MAX_CHARACTERS,
  GROUP_MEMORY_DEFAULT_IDLE_MINUTES,
  GROUP_MEMORY_MAX_BATCHES_PER_TICK,
  GROUP_MEMORY_MAX_IN_FLIGHT,
  GROUP_MEMORY_TICK_MS,
  type GroupMemoryLaneKind,
} from './index.ts';

export interface SleepingDependencies {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  /** A disabled or disconnected Telegram must not start background model calls. */
  readonly isHostReady: (host: HostKind) => boolean;
}

interface LaneCandidate {
  readonly chat: GroupMemoryChatRow;
  readonly lane: GroupMemoryLaneKind;
  readonly lastAttemptAt: string | null;
}

interface Batch {
  readonly chatId: bigint;
  readonly telegramChatId: bigint;
  readonly lane: GroupMemoryLaneKind;
  readonly day: string;
  readonly rows: readonly GroupMemoryMessageRow[];
}

/**
 * The sleeping worker: a Chat that has been quiet for `idle_minutes` (or whose
 * local day has ended) consolidates its unread messages into group memories.
 *
 * Each Chat with group memory on has a live lane that follows new messages and,
 * while it is catching up on an old backlog, a backfill lane. Each lane runs one
 * batch at a time (the database claim keeps that true across restarts and would
 * across processes), while up to `GROUP_MEMORY_MAX_IN_FLIGHT` lanes run in
 * parallel. Switching group memory on starts the live lane after the newest
 * stored message: history, or the gap while the switch was off, is not queued.
 *
 * The live lane never touches a Chat with queued/running Invocations or a
 * collecting Bucket: a reply that is still being composed must not race a
 * summary of its input. A backfill lane only reads days that ended before
 * yesterday, so it does not wait for that.
 */
export class SleepingService {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #isHostReady: SleepingDependencies['isHostReady'];
  readonly #groupMemory: GroupMemoryStore;
  readonly #controllers = new Set<AbortController>();
  readonly #activationBoundaries = new Map<bigint, bigint>();
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopping = false;
  #busy = false;
  #current: Promise<void> | undefined;

  constructor(dependencies: SleepingDependencies) {
    this.#store = dependencies.store;
    this.#configStore = dependencies.configStore;
    this.#secrets = dependencies.secrets;
    this.#isHostReady = dependencies.isHostReady;
    this.#groupMemory = new GroupMemoryStore(dependencies.store.orm);
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#stopping = false;
    this.#groupMemory.recoverStale();
    this.#groupMemory.interruptRuns();
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const controller of this.#controllers) {
      controller.abort(new Error('shutdown'));
    }
    await this.#current?.catch(() => undefined);
  }

  /**
   * Brings the lanes in line with the group-memory switches: a Chat switched on
   * without a live lane gets one that starts after its newest stored message,
   * and every lane of a Chat that is off (or gone from the configuration) is
   * dropped. Each tick runs it; a configuration publish runs it at once so the
   * boundary is the moment of the switch, not the next tick.
   */
  reconcile(config: RawConfig = this.#configStore.current().config, now = new Date()): void {
    const active = candidateChats(this.#store, config);
    const activeIds = active.map((chat) => chat.id);
    for (const id of this.#activationBoundaries.keys()) {
      if (!activeIds.includes(id)) {
        this.#activationBoundaries.delete(id);
      }
    }
    // Capture every boundary before the first write can fail or partially apply.
    for (const chat of active) {
      if (!this.#activationBoundaries.has(chat.id) && this.#groupMemory.lane(chat.id, 'live') === undefined) {
        this.#activationBoundaries.set(chat.id, newestMessageId(this.#store.orm, chat.id));
      }
    }
    const dropped = this.#groupMemory.deactivateAllExcept(activeIds);
    if (dropped > 0) {
      log('group_memory_lanes_dropped', { lanes: dropped });
    }
    for (const chat of active) {
      const through = this.#activationBoundaries.get(chat.id);
      if (through === undefined) {
        continue;
      }
      if (this.#groupMemory.activate(chat.id, through, now)) {
        log('group_memory_activated', { chat_id: chat.id.toString(), through: through.toString() });
      }
      this.#activationBoundaries.delete(chat.id);
    }
  }

  /** One pass; exported so tests drive the sleeping decision without timers. */
  async tick(now = new Date()): Promise<number> {
    if (this.#stopping || this.#busy) {
      return 0;
    }
    this.#busy = true;
    try {
      const config = this.#configStore.current().config;
      this.reconcile(config, now);
      if (!this.#isHostReady('telegram') || activeSleepUntil(this.#store.orm, now) !== null) {
        // The global budget sleep says "spend nothing until reset"; a background
        // summary is still a paid model call.
        return 0;
      }
      this.#groupMemory.recoverStale(now);
      const startedAt = performance.now();
      // Each batch may wait minutes on the model. Gates are re-evaluated against
      // the current state and the elapsed clock instead of trusting a decision
      // taken before that wait.
      const clock = (): Date => new Date(now.getTime() + Math.round(performance.now() - startedAt));
      const queue = this.#laneCandidates(config, now);
      let started = 0;
      let consolidated = 0;
      const runLanes = async (): Promise<void> => {
        for (;;) {
          // The cap counts batches started, not successes: during a provider
          // outage a failing call is exactly as expensive as a good one.
          if (this.#stopping || started >= GROUP_MEMORY_MAX_BATCHES_PER_TICK) {
            return;
          }
          const candidate = queue.shift();
          if (candidate === undefined) {
            return;
          }
          const at = clock();
          if (!this.#isHostReady('telegram') || activeSleepUntil(this.#store.orm, at) !== null) {
            return;
          }
          const current = this.#configStore.current();
          const batch = this.#batchFor(current.config, candidate, at);
          if (batch === undefined) {
            continue;
          }
          const claimedAt = this.#groupMemory.claim(batch.chatId, batch.lane, at);
          if (claimedAt === undefined) {
            continue;
          }
          const selection = resolveToolModel(current.config);
          if (selection === undefined) {
            this.#groupMemory.fail(batch.chatId, batch.lane, claimedAt, 'tool_model_unavailable', at);
            log('group_memory_failed', {
              chat_id: batch.chatId.toString(),
              lane: batch.lane,
              day: batch.day,
              error_code: 'tool_model_unavailable',
            });
            continue;
          }
          started += 1;
          if (await this.#consolidate(batch, claimedAt, current.models, selection, clock)) {
            consolidated += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: GROUP_MEMORY_MAX_IN_FLIGHT }, runLanes));
      return consolidated;
    } finally {
      this.#busy = false;
    }
  }

  /** Runs one claimed batch; true when its memories were committed. */
  async #consolidate(
    batch: Batch,
    claimedAt: string,
    models: Models,
    selection: ToolModelSelection,
    clock: () => Date,
  ): Promise<boolean> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const canCall = (): boolean =>
      !this.#stopping &&
      this.#isHostReady('telegram') &&
      activeSleepUntil(this.#store.orm, clock()) === null &&
      !isChatPaused(this.#store.orm, batch.chatId) &&
      (batch.lane !== 'live' || !this.#chatBusy(batch.chatId)) &&
      resolveChatConfig(this.#configStore.current().config, this.#store.orm, batch.telegramChatId)?.group_memory
        ?.enabled === true &&
      this.#groupMemory.lane(batch.chatId, batch.lane)?.claimedAt === claimedAt;
    const fields = { chat_id: batch.chatId.toString(), lane: batch.lane, day: batch.day };
    const first = batch.rows[0]?.telegramMessageId ?? 0n;
    const runId = this.#groupMemory.startRun(
      {
        chatId: batch.chatId,
        lane: batch.lane,
        day: batch.day,
        firstMessageId: first,
        throughMessageId: batch.rows.at(-1)?.telegramMessageId ?? first,
        messages: batch.rows.length,
      },
      clock(),
    );
    const failRun = (
      code: string,
      detail: string | null,
      read: { readonly through: bigint; readonly messages: number; readonly modelCalls: number },
      retryDelay?: number,
    ): void => {
      const at = clock();
      this.#groupMemory.fail(batch.chatId, batch.lane, claimedAt, code, at, retryDelay);
      this.#groupMemory.finishRun(
        runId,
        {
          state: 'error',
          throughMessageId: read.through,
          messages: read.messages,
          events: null,
          modelCalls: read.modelCalls,
          errorCode: code,
          errorDetail: detail,
        },
        at,
      );
      log('group_memory_failed', { ...fields, error_code: code });
    };
    try {
      const result = await consolidateDay(
        { orm: this.#store.orm, secrets: this.#secrets },
        { day: batch.day, rows: batch.rows, models, selection, signal: controller.signal, now: clock(), canCall },
      );
      if (!result.ok) {
        // A shutdown-aborted batch must be retried as soon as the next process
        // starts, not after the normal failure backoff.
        failRun(
          this.#stopping ? 'shutdown' : result.errorCode,
          result.errorDetail,
          result,
          this.#stopping || !canCall() ? 0 : undefined,
        );
        return false;
      }
      const stillEnabled =
        resolveChatConfig(this.#configStore.current().config, this.#store.orm, batch.telegramChatId)?.group_memory
          ?.enabled === true;
      if (!stillEnabled) {
        // The Admin switched the Chat off while the model was running: do
        // not write memories for a Chat whose capability is already gone.
        failRun('group_memory_disabled', null, result, 0);
        return false;
      }
      const at = clock();
      if (
        !this.#groupMemory.commit(batch.chatId, batch.lane, claimedAt, batch.day, result.events, result.through, at)
      ) {
        failRun('group_memory_claim_lost', null, result, 0);
        return false;
      }
      this.#groupMemory.finishRun(
        runId,
        {
          state: 'success',
          throughMessageId: result.through,
          messages: result.messages,
          events: result.events.length,
          modelCalls: result.modelCalls,
          errorCode: null,
          errorDetail: null,
        },
        at,
      );
      log('group_memory_consolidated', {
        ...fields,
        messages: result.messages,
        events: result.events.length,
        model_calls: result.modelCalls,
        through: result.through.toString(),
      });
      return true;
    } catch (error) {
      failRun('group_memory_error', this.#secrets.redact(error instanceof Error ? error.message : String(error)), {
        through: batch.rows.at(-1)?.telegramMessageId ?? first,
        messages: batch.rows.length,
        modelCalls: 0,
      });
      return false;
    } finally {
      this.#controllers.delete(controller);
    }
  }

  /**
   * Every lane worth a look this tick: live lanes first, then backfill, each
   * group least recently attempted first, so no Chat or lane holds the per-tick
   * budget for long. A live lane that fell more than a day behind is split
   * first.
   */
  #laneCandidates(config: RawConfig, now: Date): LaneCandidate[] {
    const candidates: LaneCandidate[] = [];
    for (const chat of candidateChats(this.#store, config)) {
      this.#splitBacklog(config, chat, now);
      for (const lane of this.#groupMemory.lanes(chat.id)) {
        candidates.push({ chat, lane: lane.lane, lastAttemptAt: lane.lastAttemptAt });
      }
    }
    return candidates.sort(
      (left, right) =>
        (left.lane === right.lane ? 0 : left.lane === 'live' ? -1 : 1) ||
        (left.lastAttemptAt ?? '').localeCompare(right.lastAttemptAt ?? ''),
    );
  }

  /**
   * Hands everything before yesterday to a backfill lane when the live lane's
   * oldest pending message is older than that, so yesterday and today are
   * summarized without waiting for the backlog. One backfill lane at a time: a
   * live lane that falls behind again while one runs catches up in order.
   */
  #splitBacklog(config: RawConfig, chat: GroupMemoryChatRow, now: Date): void {
    const live = this.#groupMemory.lane(chat.id, 'live');
    if (live === undefined || live.state !== 'idle' || this.#groupMemory.lane(chat.id, 'backfill') !== undefined) {
      return;
    }
    const oldest = loadPendingMessages(this.#store.orm, chat.id, { after: live.throughMessageId, until: null }, 1)[0];
    if (oldest === undefined) {
      return;
    }
    const timezone = resolveChatConfig(config, this.#store.orm, chat.telegram_chat_id)?.timezone ?? config.timezone;
    const yesterday = previousDay(chatLocalDay(now.toISOString(), timezone));
    if (chatLocalDay(oldest.telegramDate, timezone) >= yesterday) {
      return;
    }
    const splitPoint = lastMessageIdBefore(this.#store.orm, chat.id, localDayWindow(yesterday, timezone).start);
    if (splitPoint === undefined || !this.#groupMemory.split(chat.id, splitPoint, now)) {
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
  #batchFor(config: RawConfig, candidate: LaneCandidate, now: Date): Batch | undefined {
    const row = candidate.chat;
    const chat = resolveChatConfig(config, this.#store.orm, row.telegram_chat_id);
    if (chat?.group_memory?.enabled !== true) {
      return undefined;
    }
    // `/pause` is an operator stop, not just a reply gate: it also stops
    // background model calls until the Chat resumes.
    if (isChatPaused(this.#store.orm, row.id) || (candidate.lane === 'live' && this.#chatBusy(row.id))) {
      return undefined;
    }
    const lane = this.#groupMemory.lane(row.id, candidate.lane);
    if (lane === undefined) {
      return undefined;
    }
    const range = { after: lane.throughMessageId, until: lane.untilMessageId };
    const pending = loadPendingMessages(this.#store.orm, row.id, range);
    const first = pending[0];
    if (first === undefined) {
      if (candidate.lane === 'backfill' && this.#groupMemory.finishBackfill(row.id)) {
        log('group_memory_backfill_finished', { chat_id: row.id.toString() });
      }
      return undefined;
    }
    const timezone = chat.timezone ?? config.timezone;
    const today = chatLocalDay(now.toISOString(), timezone);
    const day = chatLocalDay(first.telegramDate, timezone);
    if (day > today) {
      // Clock skew or a future-dated message: wait instead of inventing a day.
      return undefined;
    }
    const window = localDayWindow(day, timezone);
    const dayRows = pending.filter(
      (message) => message.telegramDate >= window.start && message.telegramDate < window.end,
    );
    const rows = trimToBudget(dayRows);
    if (rows.length === 0) {
      return undefined;
    }
    if (day === today) {
      const newest = newestPendingMessage(this.#store.orm, row.id, range);
      if (newest === undefined) {
        return undefined;
      }
      const idleMilliseconds = (chat.group_memory.idle_minutes ?? GROUP_MEMORY_DEFAULT_IDLE_MINUTES) * 60_000;
      if (now.getTime() - Date.parse(newest.telegramDate) < idleMilliseconds) {
        return undefined;
      }
    }
    return { chatId: row.id, telegramChatId: row.telegram_chat_id, lane: candidate.lane, day, rows };
  }

  #chatBusy(chatId: bigint): boolean {
    return (
      this.#store.orm
        .all<{ busy: bigint }>(
          sql`SELECT EXISTS (
              SELECT 1 FROM invocations i
              JOIN conversations v ON v.id = i.conversation_id
              WHERE v.chat_id = ${chatId} AND i.state IN ('queued', 'running')
            ) OR EXISTS (
              SELECT 1 FROM buckets b
              JOIN conversations v ON v.id = b.conversation_id
              WHERE v.chat_id = ${chatId} AND b.state = 'collecting'
            ) AS busy`,
        )
        .at(0)?.busy === 1n
    );
  }

  #schedule(delay: number): void {
    if (!this.#started) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#current = this.tick()
        .then(() => undefined)
        .catch((error: unknown) => {
          log('group_memory_tick_failed', {
            error: this.#secrets.redactError(error),
          });
        })
        .finally(() => {
          this.#timer = undefined;
          this.#schedule(GROUP_MEMORY_TICK_MS);
        });
    }, delay);
    this.#timer.unref?.();
  }
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

function log(event: string, fields: Readonly<Record<string, string | number>>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
