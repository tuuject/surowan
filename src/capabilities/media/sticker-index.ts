import { and, eq, inArray, sql } from 'drizzle-orm';
import { dailyUsage, stickers } from '../../store/schema/index.ts';
import type { StickerIndexAnalysis } from './index.ts';
import { type MediaRow, stickerTelegramValidator } from './image.ts';
import { analyzeDeduplicated, type MediaVisionDeps, stickerAnalysisValidator } from './vision-analysis.ts';

/**
 * Analyzes one active sticker for the searchable index. The stored row is the
 * only source: its format decides the payload type and its thumbnail metadata is
 * re-validated, because indexing runs outside any invocation.
 */
export async function analyzeStickerForIndex(
  deps: MediaVisionDeps,
  stickerId: bigint,
  signal: AbortSignal,
): Promise<StickerIndexAnalysis> {
  const sticker = deps.store.orm
    .select({
      id: stickers.id,
      fileUniqueId: stickers.fileUniqueId,
      fileId: stickers.fileId,
      format: stickers.format,
      thumbnailJson: stickers.thumbnailJson,
    })
    .from(stickers)
    .where(and(eq(stickers.id, stickerId), eq(stickers.active, true)))
    .get();
  if (sticker === undefined) {
    throw new Error('Sticker is no longer active');
  }
  let thumbnail: unknown;
  if (sticker.thumbnailJson !== null) {
    try {
      thumbnail = JSON.parse(sticker.thumbnailJson);
    } catch {
      throw new Error('Stored sticker thumbnail metadata is invalid');
    }
  }
  const telegram = {
    is_video: sticker.format === 'video',
    is_animated: sticker.format === 'animated',
    ...(thumbnail === undefined ? {} : { thumbnail }),
  };
  if (!stickerTelegramValidator.Check(telegram)) {
    throw new Error('Stored sticker metadata does not match its schema');
  }
  const media: MediaRow = {
    id: sticker.id,
    kind: 'sticker',
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    mimeType:
      sticker.format === 'video'
        ? 'video/webm'
        : sticker.format === 'animated'
          ? 'application/x-tgsticker'
          : 'image/webp',
    fileSize: null,
    telegramJson: JSON.stringify(telegram),
  };
  const run = deps.visionRun();
  if (run === undefined) {
    throw new Error('No vision model is configured');
  }
  let analysis = deps.store.orm
    .all<{ id: bigint; description: string; metadata_json: string }>(
      sql`SELECT id, description, metadata_json FROM media_analyses WHERE file_unique_id = ${media.fileUniqueId} AND analysis_version = ${run.analysisVersion} AND state = 'success'`,
    )
    .at(0);
  if (analysis === undefined) {
    if (!reserveStickerImage(deps)) {
      throw new Error('Sticker vision daily budget reached');
    }
    await analyzeDeduplicated(deps, media, run, { kind: 'sticker_index' }, signal);
    analysis = deps.store.orm
      .all<{ id: bigint; description: string; metadata_json: string }>(
        sql`SELECT id, description, metadata_json FROM media_analyses WHERE file_unique_id = ${media.fileUniqueId} AND analysis_version = ${run.analysisVersion} AND state = 'success'`,
      )
      .at(0);
  }
  if (analysis === undefined) {
    throw new Error('Sticker analysis was not persisted');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(analysis.metadata_json);
  } catch {
    throw new Error('Stored sticker analysis metadata is invalid JSON');
  }
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('sticker' in metadata) ||
    !stickerAnalysisValidator.Check(metadata.sticker)
  ) {
    throw new Error('Stored sticker analysis metadata is invalid');
  }
  return { analysisId: analysis.id, description: analysis.description, metadata: metadata.sticker };
}

/**
 * Reserves one image against the sticker-index daily budget in the same
 * transaction that reads it, so two indexers never both see the last slot.
 */
function reserveStickerImage(deps: MediaVisionDeps): boolean {
  return deps.store.transaction(() => {
    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    const rows = deps.store.orm
      .select({ metric: dailyUsage.metric, amount: dailyUsage.amount })
      .from(dailyUsage)
      .where(
        and(
          eq(dailyUsage.utcDate, date),
          eq(dailyUsage.scope, 'system'),
          eq(dailyUsage.resource, 'sticker_index'),
          inArray(dailyUsage.metric, ['vision_images', 'vision_tokens']),
        ),
      )
      .all();
    const usage: Record<string, bigint> = {};
    for (const row of rows) {
      usage[row.metric] = row.amount;
    }
    const visionBudget = deps.configStore.current().config.vision.daily_budget;
    if (
      (usage.vision_images ?? 0n) >= BigInt(visionBudget.max_images) ||
      (usage.vision_tokens ?? 0n) >= BigInt(visionBudget.max_tokens)
    ) {
      return false;
    }
    deps.store.orm
      .insert(dailyUsage)
      .values({
        utcDate: date,
        scope: 'system',
        resource: 'sticker_index',
        metric: 'vision_images',
        amount: 1n,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [dailyUsage.utcDate, dailyUsage.scope, dailyUsage.resource, dailyUsage.metric],
        set: { amount: sql`${dailyUsage.amount} + 1`, updatedAt: now },
      })
      .run();
    return true;
  });
}
