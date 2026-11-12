import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import type { RawConfig } from '../../platform/config/index.ts';
import type { CapabilityRefResolver, InvocationContext } from '../../platform/invocation-context.ts';
import type { BusinessStore } from '../../store/store.ts';
import { stickerSets, stickers } from '../../store/schema/index.ts';
import type { MediaService, StickerIndexAnalysis } from '../media/index.ts';
import { createStickerSearchTool, type StickerSearchTool } from './search.ts';
import { reconcileStickerSets } from './sets.ts';

const StickerSetResponseSchema = Type.Object(
  {
    name: Type.String(),
    title: Type.String(),
    stickers: Type.Array(
      Type.Object(
        {
          file_id: Type.String(),
          file_unique_id: Type.String(),
          width: Type.Number(),
          height: Type.Number(),
          is_animated: Type.Boolean(),
          is_video: Type.Boolean(),
          emoji: Type.Optional(Type.String()),
          thumbnail: Type.Optional(Type.Object({ file_id: Type.String() }, { additionalProperties: true })),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
const stickerSetValidator = Compile(StickerSetResponseSchema);

interface StickerApi {
  getStickerSet(name: string): Promise<unknown>;
}

export interface StickerServiceOptions {
  readonly store: BusinessStore;
  /** The published configuration of the moment; sticker sets are hot. */
  readonly config: () => RawConfig;
  readonly api: StickerApi;
  readonly media: MediaService;
}

export class StickerService {
  readonly #store: BusinessStore;
  readonly #config: () => RawConfig;
  readonly #api: StickerApi;
  readonly #media: MediaService;
  #controller: AbortController | undefined;
  #loopPromise: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  /** Fetch passes run one at a time, so a refresh never interleaves with startup. */
  #fetching: Promise<void> = Promise.resolve();

  constructor(options: StickerServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#api = options.api;
    this.#media = options.media;
  }

  /**
   * Reconciles the store with the configuration, then fetches every configured
   * set from Telegram. Sets a published change added while that pass ran are
   * still `pending` afterwards, so a second pass picks them up.
   */
  async sync(): Promise<void> {
    reconcileStickerSets(this.#store, this.#config().telegram.sticker_sets ?? []);
    await this.#fetchSets('all');
    await this.#fetchSets('pending');
  }

  /**
   * Fetches the configured sets that are not synchronized — the ones a
   * published change just added, and earlier failures — then wakes the index
   * worker. The caller has already reconciled the store.
   */
  async refresh(): Promise<void> {
    await this.#fetchSets('unsynced');
    this.#wake?.();
  }

  start(): void {
    if (this.#controller !== undefined) {
      throw new Error('Sticker worker is already running');
    }
    this.#controller = new AbortController();
    this.#loopPromise = this.#loop(this.#controller.signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#wake?.();
    await this.#loopPromise;
    this.#controller = undefined;
    this.#loopPromise = undefined;
    this.#wake = undefined;
  }

  async runOne(now = new Date(), signal = new AbortController().signal): Promise<boolean> {
    // Without a vision model nothing can be indexed: pending stickers stay
    // pending instead of accruing failures and backoff until one is configured.
    if (!this.#media.visionAvailable()) {
      return false;
    }
    const orm = this.#store.orm;
    const sticker = orm
      .select({ id: stickers.id, emoji: stickers.emoji })
      .from(stickers)
      .innerJoin(stickerSets, eq(stickers.stickerSetId, stickerSets.id))
      .where(
        and(
          eq(stickers.active, true),
          eq(stickerSets.configured, true),
          inArray(stickers.indexState, ['pending', 'error']),
          or(isNull(stickers.nextRetryAt), lte(stickers.nextRetryAt, now.toISOString())),
        ),
      )
      .orderBy(stickers.id)
      .limit(1)
      .get();
    if (sticker === undefined) {
      return false;
    }
    orm
      .update(stickers)
      .set({ indexState: 'running', updatedAt: now.toISOString() })
      .where(eq(stickers.id, sticker.id))
      .run();
    try {
      const analysis = await this.#media.analyzeStickerForIndex(sticker.id, signal);
      this.#publishIndex(sticker.id, sticker.emoji, analysis);
    } catch {
      this.#store.transaction(() => {
        const current =
          orm.select({ failureCount: stickers.failureCount }).from(stickers).where(eq(stickers.id, sticker.id)).get()
            ?.failureCount ?? 0n;
        const failureCount = current + 1n;
        const delaySeconds = Math.min(21_600, 60 * 2 ** Math.min(8, Number(failureCount - 1n)));
        orm
          .update(stickers)
          .set({
            indexState: 'error',
            failureCount,
            nextRetryAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(stickers.id, sticker.id))
          .run();
      });
    }
    return true;
  }

  /** The `search_stickers` capability over this worker's store. */
  createSearchTool(context: InvocationContext, capabilities: CapabilityRefResolver): StickerSearchTool {
    return createStickerSearchTool(this.#store.orm, context, capabilities);
  }

  #fetchSets(scope: 'all' | 'pending' | 'unsynced'): Promise<void> {
    const run = this.#fetching.then(() => this.#fetchSetsNow(scope));
    this.#fetching = run.catch(() => undefined);
    return run;
  }

  async #fetchSetsNow(scope: 'all' | 'pending' | 'unsynced'): Promise<void> {
    const orm = this.#store.orm;
    const rows = orm
      .select({ id: stickerSets.id, telegramName: stickerSets.telegramName })
      .from(stickerSets)
      .where(
        and(
          eq(stickerSets.configured, true),
          scope === 'pending'
            ? eq(stickerSets.syncState, 'pending')
            : scope === 'unsynced'
              ? ne(stickerSets.syncState, 'success')
              : undefined,
        ),
      )
      .orderBy(stickerSets.id)
      .all();
    for (const row of rows) {
      try {
        const response = await this.#api.getStickerSet(row.telegramName);
        if (!stickerSetValidator.Check(response)) {
          throw new Error('Telegram getStickerSet response is invalid');
        }
        this.#store.transaction(() => this.#applyStickerSet(row.id, response));
      } catch {
        orm
          .update(stickerSets)
          .set({ syncState: 'error', errorCode: 'telegram_sync', updatedAt: new Date().toISOString() })
          .where(and(eq(stickerSets.id, row.id), eq(stickerSets.configured, true)))
          .run();
      }
    }
  }

  #applyStickerSet(setId: bigint, response: Static<typeof StickerSetResponseSchema>): void {
    const orm = this.#store.orm;
    const now = new Date().toISOString();
    const set = orm
      .select({ id: stickerSets.id, configured: stickerSets.configured })
      .from(stickerSets)
      .where(eq(stickerSets.id, setId))
      .get();
    // Removed while Telegram answered: its stickers must stay out of the catalog.
    if (set === undefined || !set.configured) {
      return;
    }
    orm.update(stickers).set({ active: false }).where(eq(stickers.stickerSetId, set.id)).run();
    for (const sticker of response.stickers) {
      const format = sticker.is_video ? 'video' : sticker.is_animated ? 'animated' : 'static';
      orm
        .insert(stickers)
        .values({
          stickerSetId: set.id,
          fileUniqueId: sticker.file_unique_id,
          fileId: sticker.file_id,
          emoji: sticker.emoji ?? null,
          format,
          thumbnailJson: sticker.thumbnail === undefined ? null : JSON.stringify(sticker.thumbnail),
          active: true,
          indexState: 'pending',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: stickers.fileUniqueId,
          set: {
            stickerSetId: sql`excluded.sticker_set_id`,
            fileId: sql`excluded.file_id`,
            emoji: sql`excluded.emoji`,
            format: sql`excluded.format`,
            thumbnailJson: sql`excluded.thumbnail_json`,
            active: true,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }
    orm.run(
      sql`DELETE FROM sticker_search WHERE sticker_id IN (SELECT CAST(id AS TEXT) FROM stickers WHERE sticker_set_id = ${set.id} AND active = 0)`,
    );
    // A set configured again brings back indexed stickers whose search rows
    // were dropped with the removal. Queue them once more: the stored analysis
    // is reused, so this rebuilds the search row without a vision call.
    orm.run(
      sql`UPDATE stickers SET index_state = 'pending', next_retry_at = NULL
          WHERE sticker_set_id = ${set.id} AND active = 1 AND index_state = 'success'
            AND CAST(id AS TEXT) NOT IN (SELECT sticker_id FROM sticker_search)`,
    );
    orm
      .update(stickerSets)
      .set({
        title: response.title,
        telegramName: response.name,
        syncState: 'success',
        lastSyncedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(eq(stickerSets.id, set.id))
      .run();
  }

  #publishIndex(stickerId: bigint, emoji: string | null, analysis: StickerIndexAnalysis): void {
    const content = [
      analysis.description,
      emoji ?? '',
      ...analysis.metadata.emotion_zh,
      ...analysis.metadata.action_zh,
      ...analysis.metadata.tags_zh,
      ...analysis.metadata.tags_en,
    ].join(' ');
    this.#store.transaction(() => {
      const orm = this.#store.orm;
      const now = new Date().toISOString();
      orm.run(sql`DELETE FROM sticker_search WHERE sticker_id = ${stickerId.toString()}`);
      orm.run(sql`INSERT INTO sticker_search(sticker_id, description) VALUES (${stickerId.toString()}, ${content})`);
      orm
        .update(stickers)
        .set({
          currentAnalysisId: analysis.analysisId,
          indexState: 'success',
          failureCount: 0n,
          nextRetryAt: null,
          updatedAt: now,
        })
        .where(eq(stickers.id, stickerId))
        .run();
    });
  }

  async #loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.runOne(new Date(), signal)) {
        continue;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 60_000);
        this.#wake = finish;
        signal.addEventListener('abort', finish, { once: true });
      });
      this.#wake = undefined;
    }
  }
}
