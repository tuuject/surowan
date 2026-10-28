/**
 * Rebuilds one historical public-chat scene out of stored data.
 *
 * A scene is the model input a fresh invocation would have had at the moment
 * its opening bucket was frozen: the opening bucket's `new` snapshots (the
 * trigger batch) plus the conversation history that provably existed then.
 * It reads only `messages` / `message_revisions` / `invocation_messages` (and
 * the surrounding rows they reference) and never writes — no Context refs, no
 * canonical history, no snapshots of its own.
 *
 * Retained images receive ephemeral scene-local references when the current
 * model supports image input. Other media carry explicit unavailable/missing
 * markers. This builder never fetches bytes or persists capability references.
 *
 * Deliberate boundaries:
 * - The trigger batch is the *frozen* opening batch. Later attached buckets,
 *   later edits and the bot's own later reply are never read for it; a legacy
 *   `source_bucket_id IS NULL` batch counts as opening only when the invocation
 *   has no other attached bucket.
 * - Frozen history takes precedence; remaining history uses revisions and
 *   arrivals provable at `invocations.created_at`, before the last opening
 *   message. Current history limits, `/cut_topic` and chat/topic allowlists
 *   apply. Ignored-user settings are ingress-only, not retroactive filters.
 *   Missing revisions are counted, never replaced with later edits.
 * - With `beforeSendId`, the input is only frozen public messages strictly
 *   between the previous bot message and the selected successful send. Proven
 *   pre-send injections are flattened into one batch; no earlier history or
 *   reply quotes enter it. The cutoff is the selected send's request start;
 *   equal-millisecond injections are omitted because their order is unproven.
 * - The runtime block carries `current_time` (the scene cutoff, or `options.now`)
 *   and an empty `<memory_list>`; live memory, sticker catalogs and task
 *   receipts are never read.
 */

import { randomUUID } from 'node:crypto';
import type { RawConfig } from '../../platform/config/index.ts';
import type { BusinessStore } from '../../store/store.ts';
import { resolveChatConfig } from '../../store/store.ts';

import { MEDIA_MISSING, compareMessages, loadHistoryWindow, renderCurrentTime } from './render.ts';
import { loadBotSlice, loadOpeningBatch, loadSliceBatch, loadSource, type SceneMessage } from './rows.ts';
import { formatSnapshot } from '../builder/format.ts';

export interface SceneContextOptions {
  /** Same three inputs `renderInjection` uses to size one batch. */
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly toolDefinitionCharacters: number;
  /** Rendering clock; defaults to the scene cutoff. History bounds never move. */
  readonly now?: Date;
  readonly supportsImages?: boolean;
  /** Successful host_sends row: replay only the public input since the previous bot message. */
  readonly beforeSendId?: bigint;
}

export interface SceneContext {
  /** Rendered scene: runtime block, untrusted history block, untrusted new block. */
  readonly text: string;
  readonly historyCount: number;
  readonly messageCount: number;
  /** Window messages the scene could not render (missing revision or character budget). */
  readonly omittedMessages: number;
  /** Rendered media entries without an authorized image reference. */
  readonly omittedImages: number;
  /** The moment the opening batch was frozen (`invocations.created_at`). */
  readonly cutoffAt: string;
  readonly bucketId: bigint;
  readonly conversationId: bigint;
  readonly chatId: bigint;
  readonly threadId: bigint;
  /** Media row IDs referenced by the rendered messages, for statistics only. */
  readonly mediaIds: readonly bigint[];
  readonly mediaRefs: ReadonlyMap<string, bigint>;
  /** Every rendered message is a possible same-scene reply target. */
  readonly replyMessageIds: readonly string[];
  readonly slice?: {
    readonly beforeSendId: string;
    readonly beforeMessageId: string;
    readonly afterBotMessageId: string | null;
  };
}

export function buildSceneContext(
  store: BusinessStore,
  config: RawConfig,
  invocationId: bigint,
  options: SceneContextOptions,
): SceneContext {
  const originalSource = loadSource(store, invocationId);
  const slice =
    options.beforeSendId === undefined
      ? undefined
      : loadBotSlice(store, invocationId, originalSource, options.beforeSendId);
  const source = slice === undefined ? originalSource : { ...originalSource, createdAt: slice.cutoffAt };
  const chatConfig = resolveChatConfig(config, store.orm, source.chatId);
  if (chatConfig === undefined) {
    throw new Error(`Scene context: chat ${source.chatId} is no longer configured`);
  }
  const topics = chatConfig.topic_ids;
  if (topics !== undefined && !topics.some((topicId) => BigInt(topicId) === source.threadId)) {
    throw new Error(`Scene context: topic ${source.threadId} of chat ${source.chatId} is not allowed`);
  }
  const opening =
    slice === undefined
      ? loadOpeningBatch(store, invocationId, source)
      : loadSliceBatch(store, invocationId, source, slice);
  if (slice !== undefined) {
    const ids = new Set(opening.map((entry) => entry.snapshot.message_id));
    for (const entry of opening) {
      entry.snapshot = {
        ...entry.snapshot,
        reply_to_message_id: ids.has(entry.snapshot.reply_to_message_id ?? '')
          ? entry.snapshot.reply_to_message_id
          : null,
        reply_snapshot: null,
      };
    }
  }
  const last = opening
    .map((entry) => entry.snapshot)
    .sort(compareMessages)
    .at(-1);
  if (last === undefined) {
    throw new Error('Scene context: opening messages unavailable');
  }
  const { newestFirst, missing } =
    slice === undefined
      ? loadHistoryWindow(store, invocationId, source, config, last)
      : { newestFirst: [], missing: 0 };
  const mediaRefs = new Map<string, bigint>();
  if (options.supportsImages === true) {
    for (const entry of [...opening, ...newestFirst]) {
      entry.snapshot.media.forEach((image, index) => {
        const id = entry.mediaIds[index];
        if (
          id !== undefined &&
          image.image_ref !== MEDIA_MISSING &&
          (image.kind === 'photo' ||
            image.kind === 'sticker' ||
            (image.kind === 'document' && image.mime_type?.startsWith('image/') === true))
        ) {
          const ref = `img_${randomUUID().replaceAll('-', '')}`;
          entry.snapshot = {
            ...entry.snapshot,
            media: entry.snapshot.media.map((value, i) => (i === index ? { ...value, image_ref: ref } : value)),
          };
          mediaRefs.set(ref, id);
        }
      });
    }
  }

  const timezone = chatConfig.timezone ?? config.timezone;
  const renderedAt = options.now ?? new Date(source.createdAt);
  const renderOptions = { timezone, now: renderedAt, inlineReplies: new Set<string>() };
  const render = (entry: SceneMessage, inlineReplies: ReadonlySet<string>): string =>
    formatSnapshot(entry.snapshot, { ...renderOptions, inlineReplies });
  const maximumCharacters = Math.max(
    1_024,
    Math.floor(options.contextWindow * 4 * config.agent.context_stop_ratio) -
      options.toolDefinitionCharacters -
      options.maxOutputTokens * 4,
  );

  // Same selection order and same "newest wins" rule as `renderInjection`: the
  // trigger batch is measured first (its newest message always survives, even
  // oversized), then history fills the remaining character budget.
  let usedCharacters = 0;
  const selectedNew: SceneMessage[] = [];
  for (const entry of opening.toReversed()) {
    const size = render(entry, renderOptions.inlineReplies).length + 1;
    if (selectedNew.length > 0 && usedCharacters + size > maximumCharacters) {
      break;
    }
    selectedNew.unshift(entry);
    usedCharacters += size;
  }
  const selectedHistory: SceneMessage[] = [];
  for (const entry of newestFirst) {
    const size = render(entry, renderOptions.inlineReplies).length + 1;
    if (usedCharacters + size > maximumCharacters) {
      break;
    }
    selectedHistory.unshift(entry);
    usedCharacters += size;
  }
  const omittedNew = opening.length - selectedNew.length;
  const omittedMessages = missing + (newestFirst.length - selectedHistory.length) + omittedNew;
  const inlineReplies = new Set([...selectedHistory, ...selectedNew].map((entry) => entry.snapshot.message_id));
  if (slice !== undefined) {
    for (const entry of selectedNew) {
      entry.snapshot = {
        ...entry.snapshot,
        // Slice replies can name rendered input only, never quote an earlier bot answer or omitted message.
        reply_to_message_id: inlineReplies.has(entry.snapshot.reply_to_message_id ?? '')
          ? entry.snapshot.reply_to_message_id
          : null,
        reply_snapshot: null,
      };
    }
  }
  const historyText = selectedHistory.map((entry) => render(entry, inlineReplies)).join('\n');
  const currentText = selectedNew.map((entry) => render(entry, inlineReplies)).join('\n');
  const omission = omittedNew === 0 ? '' : `[${omittedNew} earlier new messages omitted to fit the model context]\n`;
  const runtimeState = [
    `current_time: ${renderCurrentTime(timezone, renderedAt)}`,
    '<memory_list>\n</memory_list>',
  ].join('\n');
  const text = [
    '<runtime_state>',
    runtimeState,
    '</runtime_state>',
    ...(historyText.length === 0 ? [] : ['<untrusted_telegram_history>', historyText, '</untrusted_telegram_history>']),
    '<untrusted_new_messages>',
    `${omission}${currentText}`,
    '</untrusted_new_messages>',
  ].join('\n');

  const rendered = [...selectedHistory, ...selectedNew];
  const renderedIds = new Set(rendered.map((entry) => entry.snapshot.message_id));
  const mediaIds = new Set<bigint>();
  const selectedRefs = new Map<string, bigint>();
  let omittedImages = 0;
  for (const entry of rendered) {
    for (const id of entry.mediaIds) {
      mediaIds.add(id);
    }
    for (const image of entry.snapshot.media) {
      const id = mediaRefs.get(image.image_ref);
      if (id === undefined) {
        omittedImages += 1;
      } else {
        selectedRefs.set(image.image_ref, id);
      }
    }
  }
  return {
    text,
    historyCount: selectedHistory.length,
    messageCount: rendered.length,
    omittedMessages,
    omittedImages,
    cutoffAt: source.createdAt,
    bucketId: source.bucketId,
    conversationId: source.conversationId,
    chatId: source.chatId,
    threadId: source.threadId,
    mediaIds: [...mediaIds],
    mediaRefs: selectedRefs,
    replyMessageIds: [...renderedIds],
    ...(slice === undefined
      ? {}
      : {
          slice: {
            beforeSendId: slice.sendId.toString(),
            beforeMessageId: slice.messageId.toString(),
            afterBotMessageId: slice.previousMessageId?.toString() ?? null,
          },
        }),
  };
}
