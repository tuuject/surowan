import { sql } from 'drizzle-orm';
import type { StickerService } from '../../../capabilities/stickers/index.ts';
import { type ConfiguredStickerSet, reconcileStickerSets } from '../../../capabilities/stickers/sets.ts';
import type { RawConfig } from '../../../platform/config/index.ts';
import type { BusinessStore } from '../../../store/store.ts';

export interface StickerSetPublishDeps {
  readonly store: BusinessStore;
  readonly abortInvocations: (ids: readonly bigint[], reason: string) => number;
  /** The live sticker worker, absent while no Telegram instance runs. */
  readonly stickers: () => Pick<StickerService, 'refresh'> | undefined;
  readonly onRefreshFailed: (error: unknown) => void;
}

export interface StickerSetPublication {
  readonly changed: boolean;
  /** A set was added or removed, as opposed to only renamed or re-noted. */
  readonly membershipChanged: boolean;
  readonly abortedInvocations: number;
}

/**
 * Applies a published `telegram.sticker_sets` change.
 *
 * The store is reconciled first, so the panel and the next catalog render see
 * the new aliases and notes at once, with or without a Telegram connection.
 * Adding or removing a set changes which stickers exist for the model, so every
 * running Telegram invocation stops and the next message starts on the new
 * catalog; a rename or a note edit only reaches the next injected catalog. The
 * live worker then fetches the sets that are not synchronized yet in the
 * background: a slow Telegram must not hold up the configuration write.
 */
export function publishStickerSets(
  deps: StickerSetPublishDeps,
  previous: RawConfig,
  next: RawConfig,
): StickerSetPublication {
  const before = previous.telegram.sticker_sets ?? [];
  const after = next.telegram.sticker_sets ?? [];
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return { changed: false, membershipChanged: false, abortedInvocations: 0 };
  }
  reconcileStickerSets(deps.store, after);
  const membershipChanged = !sameNames(before, after);
  const abortedInvocations = membershipChanged ? abortRunningTelegramInvocations(deps.store, deps.abortInvocations) : 0;
  deps
    .stickers()
    ?.refresh()
    .catch((error: unknown) => deps.onRefreshFailed(error));
  return { changed: true, membershipChanged, abortedInvocations };
}

function sameNames(left: readonly ConfiguredStickerSet[], right: readonly ConfiguredStickerSet[]): boolean {
  const names = new Set(left.map((set) => set.name.toLowerCase()));
  return left.length === right.length && right.every((set) => names.has(set.name.toLowerCase()));
}

/** Room invocations never see stickers, so only Telegram runs are stopped. */
function abortRunningTelegramInvocations(
  store: BusinessStore,
  abort: (ids: readonly bigint[], reason: string) => number,
): number {
  const running = store.orm.all<{ id: bigint }>(sql`SELECT i.id
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       WHERE i.state = 'running' AND ch.host_kind = 'telegram'`);
  return running.length === 0
    ? 0
    : abort(
        running.map((row) => row.id),
        'sticker_sets_changed',
      );
}
