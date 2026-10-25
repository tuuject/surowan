import { eq } from 'drizzle-orm';
import type { Orm } from '../../src/store/store.ts';
import {
  chats,
  conversations,
  media,
  mediaAnalyses,
  messageRevisions,
  messages,
  senders,
  stickerSets,
  stickers,
} from '../../src/store/schema/index.ts';
import { AT, T } from './admin-seed-data.ts';

/**
 * Conversation-side rows: the chat/conversation/sender the whole fixture hangs
 * off, plus the messages, media and sticker content shown on the Messages and
 * Stickers pages.
 */

/** The chat, conversation and sender rows every other domain references. */
export function seedAdminConversation(orm: Orm): void {
  orm
    .insert(chats)
    .values({
      id: T.chat,
      telegramChatId: 123_456_789n,
      canonicalChatId: 123_456_789n,
      type: 'supergroup',
      title: 'Surowan Test Group',
      username: 'surowan_test',
      updatedAt: AT,
    })
    .run();
  orm
    .insert(conversations)
    .values({
      id: T.conversation,
      chatId: T.chat,
      messageThreadId: 0n,
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
  orm
    .insert(senders)
    .values({
      id: T.sender,
      telegramType: 'user',
      telegramId: 42n,
      displayName: 'Alice',
      username: 'alice',
      isBot: false,
      updatedAt: AT,
    })
    .run();
}

/** Messages + revisions + media (Messages page / message detail). */
export function seedAdminMessages(orm: Orm): void {
  orm
    .insert(messages)
    .values({
      id: T.messageA,
      conversationId: T.conversation,
      chatId: T.chat,
      telegramMessageId: 900n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T07:59:30.000Z',
      receivedAt: AT,
    })
    .run();
  orm
    .insert(messages)
    .values({
      id: T.messageB,
      conversationId: T.conversation,
      chatId: T.chat,
      telegramMessageId: 901n,
      currentRevisionId: null,
      visible: true,
      sentByBot: false,
      telegramDate: '2026-09-10T08:00:05.000Z',
      receivedAt: '2026-09-10T08:00:06.000Z',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionA1,
      messageId: T.messageA,
      revisionNo: 1n,
      senderId: T.sender,
      kind: 'photo',
      text: null,
      caption: 'first caption',
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:59:31.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionA2,
      messageId: T.messageA,
      revisionNo: 2n,
      senderId: T.sender,
      kind: 'photo',
      text: null,
      caption: 'edited caption',
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T07:59:40.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionB1,
      messageId: T.messageB,
      revisionNo: 1n,
      senderId: T.sender,
      kind: 'text',
      text: 'plain text message with a reply',
      caption: null,
      replyToMessageId: 900n,
      replySnapshotJson: '{"sender":{"username":"alice"},"text":"first caption"}',
      forwardOriginJson: null,
      mediaGroupId: null,
      serviceJson: null,
      createdAt: '2026-09-10T08:00:05.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm
    .insert(messageRevisions)
    .values({
      id: T.revisionB2,
      messageId: T.messageB,
      revisionNo: 2n,
      senderId: T.sender,
      kind: 'text',
      text: 'edited text with forward origin',
      caption: null,
      replyToMessageId: null,
      replySnapshotJson: null,
      forwardOriginJson: JSON.stringify({ type: 'user', user: { id: 42, username: 'alice' } }),
      mediaGroupId: null,
      serviceJson: JSON.stringify({ type: 'edited', edit_date: '2026-09-10T08:00:20.000Z' }),
      createdAt: '2026-09-10T08:00:20.000Z',
      rawFragmentJson: '{}',
    })
    .run();
  orm.update(messages).set({ currentRevisionId: T.revisionA2 }).where(eq(messages.id, T.messageA)).run();
  orm.update(messages).set({ currentRevisionId: T.revisionB2 }).where(eq(messages.id, T.messageB)).run();
  orm
    .insert(media)
    .values({
      id: T.mediaPhoto,
      revisionId: T.revisionA1,
      kind: 'photo',
      fileId: 'file_photo_seed_1',
      fileUniqueId: 'unique_photo_seed_1',
      mimeType: 'image/jpeg',
      fileSize: 12_345n,
      width: 1280n,
      height: 720n,
      telegramJson: '{}',
    })
    .run();
}

/** Sticker set + analyses + stickers. */
export function seedAdminStickers(orm: Orm): void {
  orm
    .insert(stickerSets)
    .values({
      id: T.stickerSet,
      alias: 'mascot',
      telegramName: 'surowan_mascot',
      title: 'Surowan Mascot',
      configured: true,
      syncState: 'success',
      lastSyncedAt: '2026-09-10T08:00:10.000Z',
      errorCode: null,
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickerSets)
    .values({
      id: T.stickerSetLegacy,
      alias: 'legacy',
      telegramName: 'old_pack',
      title: null,
      configured: false,
      syncState: 'error',
      lastSyncedAt: null,
      errorCode: 'sticker_set_not_found',
      updatedAt: '2026-09-10T08:00:00.000Z',
    })
    .run();
  orm
    .insert(mediaAnalyses)
    .values({
      id: T.analysisSticker,
      fileUniqueId: 'unique_sticker_seed_1',
      analysisVersion: 'v1',
      provider: 'vision',
      model: 'vision-model',
      promptVersion: 1n,
      kind: 'sticker',
      state: 'success',
      description: 'A cheerful mascot waving hello',
      metadataJson: JSON.stringify({ dominant_color: 'pink' }),
      expiresAt: null,
      failureCount: 0n,
      nextRetryAt: null,
      createdAt: '2026-09-10T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(mediaAnalyses)
    .values({
      id: T.analysisImage,
      fileUniqueId: 'unique_photo_seed_1',
      analysisVersion: 'v1',
      provider: 'vision',
      model: 'vision-model',
      promptVersion: 1n,
      kind: 'image',
      state: 'success',
      description: 'Photo caption analysis',
      metadataJson: null,
      expiresAt: null,
      failureCount: 0n,
      nextRetryAt: null,
      createdAt: '2026-09-10T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickers)
    .values({
      id: T.stickerStatic,
      stickerSetId: T.stickerSet,
      fileUniqueId: 'unique_sticker_seed_1',
      fileId: 'file_sticker_seed_1',
      emoji: '👋',
      format: 'static',
      thumbnailJson: null,
      active: true,
      currentAnalysisId: T.analysisSticker,
      indexState: 'success',
      failureCount: 0n,
      nextRetryAt: null,
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
  orm
    .insert(stickers)
    .values({
      id: T.stickerAnimated,
      stickerSetId: T.stickerSet,
      fileUniqueId: 'unique_sticker_seed_2',
      fileId: 'file_sticker_seed_2',
      emoji: '😢',
      format: 'animated',
      thumbnailJson: null,
      active: true,
      currentAnalysisId: null,
      indexState: 'error',
      failureCount: 3n,
      nextRetryAt: '2026-09-11T08:00:10.000Z',
      updatedAt: '2026-09-10T08:00:10.000Z',
    })
    .run();
}
