import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { expect, vi } from 'vitest';
import { TelegramMediaClient, type MediaDownloader } from '../../src/capabilities/media/download.ts';
import { AdminQueryError } from '../../src/ingress/admin/audit/shared.ts';
import {
  createInvocationMediaReader,
  type InvocationMediaItem,
  type InvocationMediaReader,
} from '../../src/ingress/admin/invocation-media.ts';
import { loadConfig } from '../../src/adapters/local-monolith/config/index.ts';
import { SqliteStore } from '../../src/adapters/local-monolith/database.ts';
import type { Orm } from '../../src/store/store.ts';
import {
  buckets,
  chats,
  conversations,
  invocationMessages,
  invocations,
  media,
  messageRevisions,
  messages,
} from '../../src/store/schema/index.ts';
import { writeTestConfig } from '../helpers.ts';

/**
 * Invocation media authorization fixture.
 *
 * `invocationMain` snapshots message 6001 at its *old* revision 6101, whose
 * media row 6201 is authorized while 6204 (same revision, not listed), 6202
 * (the message's current revision), and 6205 (another conversation) are not.
 * Message 6002 lives in conversation 2002, so the second invocation proves the
 * block is conversation scoping rather than a global filter.
 */
export const IDS = {
  chat: 1_001n,
  conversation: 2_001n,
  otherConversation: 2_002n,
  messageMain: 6_001n,
  messageOther: 6_002n,
  messageSticker: 6_003n,
  revisionOld: 6_101n,
  revisionCurrent: 6_102n,
  revisionOther: 6_103n,
  revisionSticker: 6_104n,
  mediaOldPhoto: 6_201n,
  mediaCurrentPhoto: 6_202n,
  mediaHiddenPhoto: 6_204n,
  mediaOtherDocument: 6_205n,
  mediaSvg: 6_206n,
  mediaUnknownMime: 6_207n,
  mediaSticker: 6_208n,
  mediaHugeSize: 6_209n,
  mediaAlphaPhoto: 6_210n,
  mediaNullSize: 6_211n,
  invocationMain: 4_001n,
  invocationOther: 4_002n,
  invocationBadJson: 4_003n,
  invocationMissingId: 4_004n,
  invocationNumericId: 4_005n,
  invocationSticker: 4_006n,
} as const;

const AT = '2026-10-06T08:00:00.000Z';
const HUGE_FILE_SIZE = 9_007_199_254_740_993n; // 2^53 + 1: not a safe JS number.

export const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

/** The seeded store plus the encoded images the download writer serves. */
export interface InvocationMediaFixture {
  readonly store: SqliteStore;
  readonly configDirectory: string;
  readonly opaquePng: Uint8Array;
  readonly transparentPng: Uint8Array;
}

/** Assigned by `openInvocationMediaFixture`, because `fixtureWriter` serves them. */
let opaquePng: Uint8Array;
let transparentPng: Uint8Array;

/** Seeds a fresh store and encodes the PNG fixtures the reader tests download. */
export async function openInvocationMediaFixture(): Promise<InvocationMediaFixture> {
  const configDirectory = await mkdtemp(join(tmpdir(), 'surowan-invocation-media-'));
  const configPath = join(configDirectory, 'config.jsonc');
  await writeTestConfig(configDirectory, configPath);
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  seedFixture(store.orm);
  opaquePng = new Uint8Array(
    await sharp({ create: { width: 32, height: 16, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png()
      .toBuffer(),
  );
  transparentPng = new Uint8Array(
    await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toBuffer(),
  );
  return { store, configDirectory, opaquePng, transparentPng };
}

export async function closeInvocationMediaFixture(fixture: InvocationMediaFixture): Promise<void> {
  fixture.store.close();
  await rm(fixture.configDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function seedFixture(orm: Orm): void {
  orm
    .insert(chats)
    .values({
      id: IDS.chat,
      telegramChatId: 123_456_789n,
      canonicalChatId: 123_456_789n,
      type: 'supergroup',
      title: 'Invocation media fixture',
      username: null,
      updatedAt: AT,
    })
    .run();
  orm
    .insert(conversations)
    .values([
      { id: IDS.conversation, chatId: IDS.chat, messageThreadId: 0n, createdAt: AT, updatedAt: AT },
      { id: IDS.otherConversation, chatId: IDS.chat, messageThreadId: 1n, createdAt: AT, updatedAt: AT },
    ])
    .run();
  orm
    .insert(messages)
    .values([
      messageRow(IDS.messageMain, IDS.conversation, 9_001n),
      messageRow(IDS.messageOther, IDS.otherConversation, 9_002n),
      messageRow(IDS.messageSticker, IDS.conversation, 9_003n),
    ])
    .run();
  orm
    .insert(messageRevisions)
    .values([
      revisionRow(IDS.revisionOld, IDS.messageMain, 1n, 'photo'),
      revisionRow(IDS.revisionCurrent, IDS.messageMain, 2n, 'photo'),
      revisionRow(IDS.revisionOther, IDS.messageOther, 1n, 'document'),
      revisionRow(IDS.revisionSticker, IDS.messageSticker, 1n, 'sticker'),
    ])
    .run();
  orm.update(messages).set({ currentRevisionId: IDS.revisionCurrent }).where(eq(messages.id, IDS.messageMain)).run();
  orm
    .insert(media)
    .values([
      mediaRow(IDS.mediaOldPhoto, IDS.revisionOld, 'photo', 'file-photo-old', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaCurrentPhoto, IDS.revisionCurrent, 'photo', 'file-photo-current', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaHiddenPhoto, IDS.revisionOld, 'photo', 'file-photo-hidden', 'image/png', 68n, '{}'),
      mediaRow(IDS.mediaOtherDocument, IDS.revisionOther, 'document', 'file-doc-other', 'application/pdf', 68n, '{}'),
      mediaRow(IDS.mediaSvg, IDS.revisionOld, 'document', 'file-svg', 'image/svg+xml', 68n, '{}'),
      mediaRow(IDS.mediaUnknownMime, IDS.revisionOld, 'document', 'file-unknown-mime', null, 68n, '{}'),
      mediaRow(
        IDS.mediaSticker,
        IDS.revisionSticker,
        'sticker',
        'file-sticker',
        'application/x-tgsticker',
        68n,
        JSON.stringify({ is_video: false, is_animated: false, thumbnail: { file_id: 'file-sticker-thumb' } }),
      ),
      mediaRow(IDS.mediaHugeSize, IDS.revisionOld, 'photo', 'file-photo-huge-size', 'image/png', HUGE_FILE_SIZE, '{}'),
      mediaRow(IDS.mediaAlphaPhoto, IDS.revisionOld, 'photo', 'file-photo-alpha', 'image/png', 68n, '{}'),
      // A NULL size is legal in the schema: the download-time cap is the only defense.
      mediaRow(IDS.mediaNullSize, IDS.revisionOld, 'photo', 'file-photo-null-size', 'image/png', null, '{}'),
    ])
    .run();
  const invocationIds = [
    [IDS.invocationMain, IDS.conversation],
    [IDS.invocationOther, IDS.otherConversation],
    [IDS.invocationBadJson, IDS.conversation],
    [IDS.invocationMissingId, IDS.conversation],
    [IDS.invocationNumericId, IDS.conversation],
    [IDS.invocationSticker, IDS.conversation],
  ] as const;
  orm
    .insert(buckets)
    .values(
      invocationIds.map(([, conversationId], index) => ({
        id: 3_001n + BigInt(index),
        conversationId,
        state: 'completed',
        kind: 'realtime',
        firstReceivedAt: AT,
        deadlineAt: AT,
        queuedAt: AT,
        startedAt: AT,
        finishedAt: AT,
        mergedIntoBucketId: null,
        errorCode: null,
        createdAt: AT,
        updatedAt: AT,
      })),
    )
    .run();
  orm
    .insert(invocations)
    .values(
      invocationIds.map(([id, conversationId], index) => ({
        id,
        bucketId: 3_001n + BigInt(index),
        conversationId,
        state: 'completed',
        configHash: 'invocation-media-fixture',
        promptVersion: 1n,
        toolRegistryHash: null,
        toolRegistryJson: null,
        startedAt: AT,
        finishedAt: AT,
        completionReason: 'completed',
        errorCode: null,
        sendsUsed: 0n,
        toolCallsUsed: 0n,
        turnsUsed: 0n,
        sideEffectStarted: false,
        createdAt: AT,
      })),
    )
    .run();
  orm
    .insert(invocationMessages)
    .values([
      // The old revision is snapshotted: 6201 is listed, 6204 is not.
      snapshotRow(IDS.invocationMain, IDS.messageMain, IDS.revisionOld, 1n, {
        message_id: '9001',
        kind: 'photo',
        caption: 'older revision',
        media: [
          { id: '6201', kind: 'photo' },
          { id: '6206', kind: 'document' },
          { id: '6207', kind: 'document' },
          { id: '6209', kind: 'photo' },
          { id: '6210', kind: 'photo' },
          { id: '6211', kind: 'photo' },
        ],
      }),
      // Cross-conversation snapshot row: message 6002 belongs to conversation 2002.
      snapshotRow(IDS.invocationMain, IDS.messageOther, IDS.revisionOther, 2n, { media: [{ id: '6205' }] }),
      snapshotRow(IDS.invocationOther, IDS.messageOther, IDS.revisionOther, 1n, { media: [{ id: '6205' }] }),
      snapshotRow(IDS.invocationBadJson, IDS.messageMain, IDS.revisionOld, 1n, null, '{not json'),
      snapshotRow(IDS.invocationMissingId, IDS.messageMain, IDS.revisionOld, 1n, { media: [{ kind: 'photo' }] }),
      snapshotRow(IDS.invocationNumericId, IDS.messageMain, IDS.revisionOld, 1n, { media: [{ id: 6201 }] }),
      snapshotRow(IDS.invocationSticker, IDS.messageSticker, IDS.revisionSticker, 1n, { media: [{ id: '6208' }] }),
    ])
    .run();
}

function messageRow(id: bigint, conversationId: bigint, telegramMessageId: bigint) {
  return {
    id,
    conversationId,
    chatId: IDS.chat,
    telegramMessageId,
    currentRevisionId: null,
    visible: true,
    sentByBot: false,
    telegramDate: AT,
    receivedAt: AT,
  };
}

function revisionRow(id: bigint, messageId: bigint, revisionNo: bigint, kind: string) {
  return {
    id,
    messageId,
    revisionNo,
    senderId: null,
    kind,
    text: null,
    caption: kind === 'photo' ? 'fixture caption' : null,
    replyToMessageId: null,
    replySnapshotJson: null,
    forwardOriginJson: null,
    mediaGroupId: null,
    serviceJson: null,
    createdAt: AT,
    rawFragmentJson: '{}',
  };
}

function mediaRow(
  id: bigint,
  revisionId: bigint,
  kind: string,
  fileId: string,
  mimeType: string | null,
  fileSize: bigint | null,
  telegramJson: string,
) {
  return {
    id,
    revisionId,
    kind,
    fileId,
    fileUniqueId: `${fileId}-unique`,
    mimeType,
    fileSize,
    width: 32n,
    height: 16n,
    telegramJson,
  };
}

function snapshotRow(
  invocationId: bigint,
  messageId: bigint,
  revisionId: bigint,
  sequenceNo: bigint,
  snapshot: unknown,
  rawSnapshot?: string,
) {
  return {
    invocationId,
    messageId,
    revisionId,
    section: sequenceNo === 1n ? 'history' : 'new',
    sequenceNo,
    sourceBucketId: null,
    omittedBefore: 0n,
    snapshotJson: rawSnapshot ?? JSON.stringify(snapshot),
  };
}

/**
 * Records every download and the private temp directory it landed in, so tests
 * can prove which file ID was fetched and that the directory is gone afterwards.
 */
export function recordingDownloader(
  write: (fileId: string, destination: string, signal: AbortSignal) => Promise<void>,
) {
  const calls: { readonly fileId: string; readonly destination: string }[] = [];
  const directories: string[] = [];
  const downloader: MediaDownloader = {
    download: async (fileId, destination, signal) => {
      signal.throwIfAborted();
      calls.push({ fileId, destination });
      const directory = dirname(destination);
      if (!directories.includes(directory)) {
        directories.push(directory);
      }
      await write(fileId, destination, signal);
      signal.throwIfAborted();
    },
  };
  return { downloader, calls, directories };
}

function bytesFor(fileId: string): Uint8Array {
  switch (fileId) {
    case 'file-photo-old':
    case 'file-sticker-thumb':
      return opaquePng;
    case 'file-photo-alpha':
      return transparentPng;
    case 'file-svg':
    case 'file-unknown-mime':
      return svgBytes;
    default:
      throw new Error(`Unexpected download file ID ${fileId}`);
  }
}

/** Writes realistic bytes for known fixture file IDs; unknown IDs fail the test loudly. */
export function fixtureWriter(fileId: string, destination: string): Promise<void> {
  return writeFile(destination, bytesFor(fileId));
}

/** Binds the reader to one store so tests only have to supply a downloader. */
export function createReader(
  orm: Orm,
  downloader: MediaDownloader,
  shutdownSignal: AbortSignal = new AbortController().signal,
): InvocationMediaReader {
  return createInvocationMediaReader({ orm, downloader, shutdownSignal });
}

export async function expectAdminError(run: Promise<unknown>, code: string, status: number): Promise<AdminQueryError> {
  const settled = await run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (settled.ok) {
    throw new Error(`Expected ${code} (${status}) but the call succeeded`);
  }
  if (!(settled.error instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(settled.error)}`);
  }
  expect(settled.error.code).toBe(code);
  expect(settled.error.status).toBe(status);
  return settled.error;
}

export function expectSyncAdminError(run: () => unknown, code: string, status: number): AdminQueryError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  expect(caught.status).toBe(status);
  return caught;
}

export function itemOf(items: readonly InvocationMediaItem[], id: string): InvocationMediaItem {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) {
    throw new Error(`Expected media item ${id}`);
  }
  return item;
}

/**
 * The Windows-style failure Node's `rm` retries under `maxRetries`: whether a
 * single occurrence is absorbed is decided solely by the options the reader
 * passes. The message embeds the temp path, exactly like the real error, so a
 * raw leak would be visible.
 */
export function ebusy(path: string): Error {
  return Object.assign(new Error(`EBUSY: resource busy or locked, rm '${path}'`), { code: 'EBUSY' });
}

/**
 * A body that emits the given chunks and ends. Paired with a stubbed global
 * `fetch`, this drives the real `TelegramMediaClient` without any network.
 */
function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

export function stubTelegramFetch(headers: Record<string, string>, chunks: readonly Uint8Array[]): void {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    body: bodyOf(chunks),
    headers: new Headers(headers),
  }));
}

export function telegramClient(getFile: () => Promise<{ readonly file_path?: string }>): TelegramMediaClient {
  return new TelegramMediaClient({ getFile }, 'test-token');
}

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export async function expectSettledError<T>(settled: Promise<Settled<T>>, code: string, status: number): Promise<void> {
  const result = await settled;
  if (result.ok) {
    throw new Error(`Expected ${code} (${status}) but the call succeeded`);
  }
  if (!(result.error instanceof AdminQueryError)) {
    throw new Error(`Expected AdminQueryError, received ${String(result.error)}`);
  }
  expect(result.error.code).toBe(code);
  expect(result.error.status).toBe(status);
}

/** The `node:fs/promises` behaviours a test file can inject through its mock. */
export interface FsHooks {
  beforeRead: ((path: string) => Promise<void> | void) | undefined;
  afterRead: ((path: string) => void) | undefined;
  rmFailure: ((path: string, attempt: number) => Error | undefined) | undefined;
  rmOptions: { readonly maxRetries?: number | undefined; readonly retryDelay?: number | undefined }[];
}

/** Parks the first `readFile` until the returned `release` is called. */
export function parkFirstRead(hooks: FsHooks): { readonly reached: () => boolean; readonly release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  hooks.beforeRead = async () => {
    if (!reached) {
      reached = true;
      await gate;
    }
  };
  return { reached: () => reached, release };
}

export async function waitForPark(reached: () => boolean): Promise<void> {
  while (!reached()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
