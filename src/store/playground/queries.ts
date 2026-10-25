/**
 * Read models over a room: the timeline page, a release with its attempts and
 * sends, and the invocation summaries with their usage and receipt state.
 */
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ReleaseDetail, ReleaseSend, RoomInvocationSummary, TimelineEntry, TimelineMedia } from './index.ts';
import {
  hostSends,
  invocations,
  media,
  messageRevisions,
  messages,
  playgroundReleases,
  playgroundRetries,
  senders,
  taskReceipts,
  toolCalls,
} from '../schema/index.ts';
import { PlaygroundError, type PlaygroundDeps, roomRow } from './shared.ts';

export function timeline(
  deps: PlaygroundDeps,
  chatId: bigint,
  options: { readonly beforeSeq?: bigint; readonly limit: number },
): { readonly items: readonly TimelineEntry[]; readonly hasMore: boolean } {
  const rows = deps.orm
    .select({
      messageId: messages.id,
      seq: messages.localSequenceNo,
      sentByBot: messages.sentByBot,
      receivedAt: messages.receivedAt,
      kind: messageRevisions.kind,
      text: messageRevisions.text,
      caption: messageRevisions.caption,
      senderId: messageRevisions.senderId,
      senderName: senders.displayName,
      senderIsBot: senders.isBot,
      replyToMessageId: messages.localReplyToMessageId,
      replyToSeq: sql<
        bigint | null
      >`(SELECT m2.local_sequence_no FROM messages m2 WHERE m2.id = ${messages.localReplyToMessageId})`,
      inputState: sql<string | null>`(SELECT i.state FROM playground_inputs i WHERE i.message_id = ${messages.id})`,
      sendState: sql<string | null>`(SELECT hs.state FROM host_sends hs WHERE hs.message_id = ${messages.id})`,
    })
    .from(messages)
    .innerJoin(messageRevisions, eq(messageRevisions.id, messages.currentRevisionId))
    .leftJoin(senders, eq(senders.id, messageRevisions.senderId))
    .where(
      and(
        eq(messages.chatId, chatId),
        sql`${messages.localSequenceNo} IS NOT NULL`,
        options.beforeSeq === undefined ? undefined : lt(messages.localSequenceNo, options.beforeSeq),
      ),
    )
    .orderBy(desc(messages.localSequenceNo))
    .limit(options.limit + 1)
    .all();
  const page = rows.slice(0, options.limit);
  // One media query per page, then each entry takes only its own pictures.
  const mediaByMessage = Map.groupBy(
    timelineMedia(
      deps,
      page.map((entry) => entry.messageId),
    ),
    (item) => item.messageId,
  );
  const items = page.map((row) => ({
    messageId: row.messageId,
    seq: row.seq ?? 0n,
    sentByBot: row.sentByBot,
    createdAt: row.receivedAt,
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    senderId: row.senderId,
    senderName: row.senderName,
    senderIsBot: row.senderIsBot === true,
    replyToMessageId: row.replyToMessageId,
    replyToSeq: row.replyToSeq,
    inputState: row.inputState,
    sendState: row.sendState,
    media: mediaByMessage.get(row.messageId) ?? [],
  }));
  return { items, hasMore: rows.length > options.limit };
}

function timelineMedia(deps: PlaygroundDeps, messageIds: readonly bigint[]): TimelineMedia[] {
  if (messageIds.length === 0) {
    return [];
  }
  return (
    deps.orm
      .select({
        messageId: messageRevisions.messageId,
        id: media.id,
        kind: media.kind,
        mimeType: media.mimeType,
        fileUniqueId: media.fileUniqueId,
        width: media.width,
        height: media.height,
        assetId: media.localAssetId,
      })
      .from(media)
      .innerJoin(messageRevisions, eq(messageRevisions.id, media.revisionId))
      // Only the revision the entry shows: an edited message's older pictures
      // are history, not part of what the timeline renders.
      .innerJoin(messages, eq(messages.currentRevisionId, messageRevisions.id))
      .where(inArray(messageRevisions.messageId, [...messageIds]))
      .orderBy(asc(media.id))
      .all()
  );
}

export function releaseDetail(deps: PlaygroundDeps, chatId: bigint, releaseId: bigint): ReleaseDetail | undefined {
  const release = deps.orm
    .select()
    .from(playgroundReleases)
    .where(and(eq(playgroundReleases.id, releaseId), eq(playgroundReleases.chatId, chatId)))
    .get();
  if (release === undefined) {
    return undefined;
  }
  const retries = deps.orm
    .select({ invocationId: playgroundRetries.invocationId })
    .from(playgroundRetries)
    .where(eq(playgroundRetries.releaseId, releaseId))
    .orderBy(asc(playgroundRetries.id))
    .all();
  const invocationIds = [release.invocationId, ...retries.map((row) => row.invocationId)].filter(
    (id): id is bigint => id !== null,
  );
  return {
    release: {
      id: release.id,
      revision: release.revision,
      throughSeq: release.throughSeq,
      bucketId: release.bucketId,
      invocationId: release.invocationId,
      createdAt: release.createdAt,
    },
    attempts: invocationIds.map((invocationId) => invocationSummaryOf(deps, invocationId)),
    sends: releaseSends(deps, invocationIds),
  };
}

function releaseSends(deps: PlaygroundDeps, invocationIds: readonly bigint[]): readonly ReleaseSend[] {
  if (invocationIds.length === 0) {
    return [];
  }
  return deps.orm
    .select({
      id: hostSends.id,
      invocationId: toolCalls.invocationId,
      kind: hostSends.kind,
      state: hostSends.state,
      messageId: hostSends.messageId,
      errorCode: hostSends.errorCode,
      createdAt: hostSends.createdAt,
      finishedAt: hostSends.finishedAt,
    })
    .from(hostSends)
    .innerJoin(toolCalls, eq(toolCalls.id, hostSends.toolCallId))
    .where(inArray(toolCalls.invocationId, [...invocationIds]))
    .orderBy(asc(hostSends.id))
    .all();
}

export function roomInvocation(
  deps: PlaygroundDeps,
  chatId: bigint,
  invocationId: bigint,
): RoomInvocationSummary | undefined {
  const room = roomRow(deps, chatId);
  if (room === undefined) {
    throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
  }
  const row = deps.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(and(eq(invocations.id, invocationId), eq(invocations.conversationId, room.conversationId)))
    .get();
  return row === undefined ? undefined : invocationSummaryOf(deps, row.id);
}

export function roomInvocations(deps: PlaygroundDeps, chatId: bigint, limit: number): RoomInvocationSummary[] {
  const room = roomRow(deps, chatId);
  if (room === undefined) {
    throw new PlaygroundError('room_not_found', `room ${chatId} does not exist`);
  }
  return deps.orm
    .select({ id: invocations.id })
    .from(invocations)
    .where(eq(invocations.conversationId, room.conversationId))
    .orderBy(desc(invocations.id))
    .limit(limit)
    .all()
    .map((row) => invocationSummaryOf(deps, row.id));
}

function invocationSummaryOf(deps: PlaygroundDeps, invocationId: bigint): RoomInvocationSummary {
  const row = deps.orm.select().from(invocations).where(eq(invocations.id, invocationId)).get();
  if (row === undefined) {
    throw new PlaygroundError('unknown_release', `invocation ${invocationId} does not exist`);
  }
  const usage = deps.orm.all<{ total_tokens: bigint; total_cost: number | null }>(
    sql`SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)), 0) AS total_tokens,
                 SUM(cost) AS total_cost
          FROM model_calls WHERE invocation_id = ${invocationId}`,
  )[0];
  const receipt = deps.orm
    .select({ state: taskReceipts.state, status: taskReceipts.status })
    .from(taskReceipts)
    .where(eq(taskReceipts.invocationId, invocationId))
    .get();
  const retryOf = deps.orm
    .select({ retryOfInvocationId: playgroundRetries.retryOfInvocationId, releaseId: playgroundRetries.releaseId })
    .from(playgroundRetries)
    .where(eq(playgroundRetries.invocationId, invocationId))
    .get();
  const releasedBy =
    retryOf?.releaseId ??
    deps.orm
      .select({ id: playgroundReleases.id })
      .from(playgroundReleases)
      .where(eq(playgroundReleases.invocationId, invocationId))
      .get()?.id ??
    null;
  return {
    id: row.id,
    state: row.state,
    errorCode: row.errorCode,
    completionReason: row.completionReason,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    sendsUsed: Number(row.sendsUsed),
    toolCallsUsed: Number(row.toolCallsUsed),
    sideEffectStarted: row.sideEffectStarted,
    totalTokens: Number(usage?.total_tokens ?? 0n),
    totalCost: usage?.total_cost ?? null,
    receiptState: receipt?.state ?? null,
    receiptStatus: receipt?.status ?? null,
    retryOfInvocationId: retryOf?.retryOfInvocationId ?? null,
    releaseId: releasedBy,
  };
}
