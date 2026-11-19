import type { Models } from '@earendil-works/pi-ai';
import type { RawConfig } from '../../platform/config/index.ts';
import { type HostKind, isHostKind } from '../../platform/im-host/identity.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { resolveToolModel, type ToolModelSelection } from '../../platform/tool-model.ts';
import type { BusinessStore } from '../../store/store.ts';
import { isChatPaused, resolveChatConfig } from '../../store/store.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { candidateChats, isChatBusy } from './chats.ts';
import { consolidateDay } from './consolidate.ts';
import { newestMessageId } from './messages.ts';
import { type Batch, batchFor, laneCandidates, log } from './planning.ts';
import { GroupMemoryStore } from './store.ts';
import { GROUP_MEMORY_MAX_BATCHES_PER_TICK, GROUP_MEMORY_MAX_IN_FLIGHT, GROUP_MEMORY_TICK_MS } from './index.ts';

export interface SleepingDependencies {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  /** A disabled or disconnected Telegram must not start background model calls. */
  readonly isHostReady: (host: HostKind) => boolean;
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
    const completion = Promise.withResolvers<void>();
    this.#current = completion.promise;
    try {
      const config = this.#configStore.current().config;
      this.reconcile(config, now);
      if (activeSleepUntil(this.#store.orm, now) !== null) {
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
      const queue = laneCandidates(this.#store, this.#groupMemory, config, now);
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
          if (activeSleepUntil(this.#store.orm, at) !== null) {
            return;
          }
          // Readiness belongs to the candidate's own host: an unready host's
          // lanes are skipped, not failed, so the ready ones still progress.
          const candidateHost = isHostKind(candidate.chat.host_kind) ? candidate.chat.host_kind : undefined;
          if (candidateHost === undefined || !this.#isHostReady(candidateHost)) {
            continue;
          }
          const current = this.#configStore.current();
          const batch = batchFor(this.#store, this.#groupMemory, current.config, candidate, at);
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
      for (const result of await Promise.allSettled(Array.from({ length: GROUP_MEMORY_MAX_IN_FLIGHT }, runLanes))) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
      return consolidated;
    } finally {
      this.#busy = false;
      completion.resolve();
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
      this.#isHostReady(batch.hostKind) &&
      activeSleepUntil(this.#store.orm, clock()) === null &&
      !isChatPaused(this.#store.orm, batch.chatId) &&
      (batch.lane !== 'live' || !isChatBusy(this.#store, batch.chatId)) &&
      resolveChatConfig(this.#configStore.current().config, this.#store.orm, batch.telegramChatId)?.group_memory
        ?.enabled === true &&
      this.#groupMemory.lane(batch.chatId, batch.lane)?.claimedAt === claimedAt;
    const fields = { chat_id: batch.chatId.toString(), lane: batch.lane, day: batch.day };
    const first = batch.rows[0]?.messageNo ?? 0n;
    let read = { through: batch.rows.at(-1)?.messageNo ?? first, messages: batch.rows.length, modelCalls: 0 };
    let runId: bigint | undefined;
    const failRun = (
      code: string,
      detail: string | null,
      read: { readonly through: bigint; readonly messages: number; readonly modelCalls: number },
      retryDelay?: number,
    ): void => {
      const at = clock();
      this.#groupMemory.fail(batch.chatId, batch.lane, claimedAt, code, at, retryDelay);
      if (runId !== undefined) {
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
      }
      log('group_memory_failed', { ...fields, error_code: code });
    };
    try {
      const id = this.#groupMemory.startRun(
        {
          chatId: batch.chatId,
          lane: batch.lane,
          day: batch.day,
          firstMessageId: first,
          throughMessageId: batch.rows.at(-1)?.messageNo ?? first,
          messages: batch.rows.length,
        },
        clock(),
      );
      runId = id;
      const result = await consolidateDay(
        { orm: this.#store.orm, secrets: this.#secrets },
        {
          day: batch.day,
          rows: batch.rows,
          models,
          selection,
          signal: controller.signal,
          now: clock(),
          canCall,
          onCall: (progress) => {
            this.#groupMemory.recordRunCall(id, progress);
            read = progress;
          },
        },
      );
      read = result;
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
      const committed = this.#store.orm.transaction(
        () => {
          if (
            !this.#groupMemory.commit(batch.chatId, batch.lane, claimedAt, batch.day, result.events, result.through, at)
          ) {
            return false;
          }
          this.#groupMemory.finishRun(
            id,
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
          return true;
        },
        { behavior: 'immediate' },
      );
      if (!committed) {
        failRun('group_memory_claim_lost', null, result, 0);
        return false;
      }
      log('group_memory_consolidated', {
        ...fields,
        messages: result.messages,
        events: result.events.length,
        model_calls: result.modelCalls,
        through: result.through.toString(),
      });
      return true;
    } catch (error) {
      failRun('group_memory_error', this.#secrets.redact(error instanceof Error ? error.message : String(error)), read);
      return false;
    } finally {
      this.#controllers.delete(controller);
    }
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
