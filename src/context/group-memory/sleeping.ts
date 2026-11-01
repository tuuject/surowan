import { sql } from 'drizzle-orm';
import type { RawConfig } from '../../platform/config/index.ts';
import type { HostKind } from '../../platform/im-host/identity.ts';
import type { RuntimeConfigurationStore } from '../../platform/runtime-config.ts';
import type { SecretStore } from '../../platform/secrets.ts';
import { resolveToolModel } from '../../platform/tool-model.ts';
import type { BusinessStore } from '../../store/store.ts';
import { isChatPaused, resolveChatConfig } from '../../store/store.ts';
import { activeSleepUntil } from '../../store/sleep.ts';
import { telegramChatIdentity } from '../../store/chat-identity.ts';
import { chatLocalDay, localDayWindow } from './day.ts';
import { consolidateDay } from './consolidate.ts';
import {
  loadPendingMessages,
  newestPendingMessage,
  renderGroupTranscript,
  type GroupMemoryMessageRow,
} from './messages.ts';
import { GroupMemoryStore } from './store.ts';
import { GROUP_MEMORY_BATCH_MAX_CHARACTERS, GROUP_MEMORY_DEFAULT_IDLE_MINUTES, GROUP_MEMORY_TICK_MS } from './index.ts';

/** Bound per tick so a large backlog cannot monopolise the process. */
const MAX_CONSOLIDATIONS_PER_TICK = 3;

export interface SleepingDependencies {
  readonly store: BusinessStore;
  readonly configStore: RuntimeConfigurationStore;
  readonly secrets: SecretStore;
  /** A disabled or disconnected Telegram must not start background model calls. */
  readonly isHostReady: (host: HostKind) => boolean;
}

interface ChatRow {
  readonly id: bigint;
  readonly telegram_chat_id: bigint;
}

interface Batch {
  readonly chatId: bigint;
  readonly day: string;
  readonly rows: readonly GroupMemoryMessageRow[];
}

/**
 * The sleeping worker: a Chat that has been quiet for `idle_minutes` (or whose
 * local day has ended) consolidates its unread messages into group memories.
 *
 * One consolidation at a time per process; the database claim keeps that true
 * across restarts and would keep it true across processes. The worker never
 * touches a Chat with queued/running Invocations or a collecting Bucket: a
 * reply that is still being composed must not race a summary of its input.
 */
export class SleepingService {
  readonly #store: BusinessStore;
  readonly #configStore: RuntimeConfigurationStore;
  readonly #secrets: SecretStore;
  readonly #isHostReady: SleepingDependencies['isHostReady'];
  readonly #groupMemory: GroupMemoryStore;
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopping = false;
  #busy = false;
  #controller: AbortController | undefined;
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
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#controller?.abort(new Error('shutdown'));
    await this.#current?.catch(() => undefined);
  }

  /** One pass; exported so tests drive the sleeping decision without timers. */
  async tick(now = new Date()): Promise<number> {
    if (this.#stopping || this.#busy || !this.#isHostReady('telegram')) {
      return 0;
    }
    if (activeSleepUntil(this.#store.orm, now) !== null) {
      // The global budget sleep says "spend nothing until reset"; a background
      // summary is still a paid model call.
      return 0;
    }
    this.#busy = true;
    try {
      this.#groupMemory.recoverStale(now);
      const config = this.#configStore.current();
      const selection = resolveToolModel(config.config);
      let consolidated = 0;
      for (const batch of this.#eligibleBatches(config.config, now)) {
        if (this.#stopping || consolidated >= MAX_CONSOLIDATIONS_PER_TICK) {
          break;
        }
        const claimed = this.#groupMemory.claim(batch.chatId, now);
        if (!claimed) {
          continue;
        }
        if (selection === undefined) {
          this.#groupMemory.fail(batch.chatId, 'tool_model_unavailable', now);
          log('group_memory_failed', {
            chat_id: batch.chatId.toString(),
            day: batch.day,
            error_code: 'tool_model_unavailable',
          });
          continue;
        }
        const controller = new AbortController();
        this.#controller = controller;
        try {
          const result = await consolidateDay(
            { orm: this.#store.orm, secrets: this.#secrets },
            {
              day: batch.day,
              rows: batch.rows,
              models: config.models,
              selection,
              signal: controller.signal,
              now,
            },
          );
          this.#groupMemory.commit(batch.chatId, batch.day, result.events, result.through, now);
          consolidated += 1;
          log('group_memory_consolidated', {
            chat_id: batch.chatId.toString(),
            day: batch.day,
            messages: result.messages,
            events: result.events.length,
            through: result.through.toString(),
          });
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : 'group_memory_error';
          // A shutdown-aborted batch must be retried as soon as the next process
          // starts, not after the normal failure backoff.
          this.#groupMemory.fail(batch.chatId, this.#stopping ? 'shutdown' : code, now, this.#stopping ? 0 : undefined);
          log('group_memory_failed', { chat_id: batch.chatId.toString(), day: batch.day, error_code: code });
        } finally {
          this.#controller = undefined;
        }
      }
      return consolidated;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * The batches this pass may summarize, oldest Chat first. A Chat contributes
   * at most its first pending Chat-local day, so a backlog is consolidated one
   * day at a time and never mixes two days into one memory batch.
   */
  #eligibleBatches(config: RawConfig, now: Date): Batch[] {
    const batches: Batch[] = [];
    const seen = new Set<string>();
    for (const configured of config.telegram.chats) {
      if (configured.group_memory?.enabled !== true) {
        continue;
      }
      const identities = telegramChatIdentity(this.#store, [BigInt(configured.id)]);
      const rows = this.#store.orm.all<ChatRow>(
        sql`SELECT id, telegram_chat_id FROM chats
            WHERE host_kind = 'telegram' AND telegram_chat_id IN (${sql.join(
              identities.map((id) => sql`${id}`),
              sql`, `,
            )})`,
      );
      for (const row of rows) {
        const key = row.id.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const chat = resolveChatConfig(config, this.#store.orm, row.telegram_chat_id);
        if (chat?.group_memory?.enabled !== true) {
          continue;
        }
        // `/pause` is an operator stop, not just a reply gate: it also stops
        // background model calls until the Chat resumes.
        if (isChatPaused(this.#store.orm, row.id) || this.#chatBusy(row.id)) {
          continue;
        }
        const state = this.#groupMemory.state(row.id);
        const watermark = state?.consolidatedThroughMessageId ?? 0n;
        const pending = loadPendingMessages(this.#store.orm, row.id, watermark);
        const first = pending[0];
        if (first === undefined) {
          continue;
        }
        const timezone = chat.timezone ?? config.timezone;
        const day = chatLocalDay(first.telegramDate, timezone);
        if (day > chatLocalDay(now.toISOString(), timezone)) {
          // Clock skew or a future-dated message: wait instead of inventing a day.
          continue;
        }
        const window = localDayWindow(day, timezone);
        const dayRows = pending.filter(
          (message) => message.telegramDate >= window.start && message.telegramDate < window.end,
        );
        const rows = trimToBudget(dayRows);
        if (rows.length === 0) {
          continue;
        }
        if (day === chatLocalDay(now.toISOString(), timezone)) {
          const newest = newestPendingMessage(this.#store.orm, row.id, watermark);
          if (newest === undefined) {
            continue;
          }
          const idleMilliseconds = (chat.group_memory.idle_minutes ?? GROUP_MEMORY_DEFAULT_IDLE_MINUTES) * 60_000;
          if (now.getTime() - Date.parse(newest.telegramDate) < idleMilliseconds) {
            continue;
          }
        }
        batches.push({ chatId: row.id, day, rows });
      }
    }
    return batches;
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
