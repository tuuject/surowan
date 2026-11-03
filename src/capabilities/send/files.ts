/**
 * What a `kind:file` send delivers: the original outputs of a generation, or
 * one authorized conversation picture exactly as its host stored it. A picture
 * the bot generated and sent as a photo resolves back to its original outputs,
 * so "send me the original" never answers with the compressed copy.
 */

import { and, eq, or } from 'drizzle-orm';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { hostSends, media, messageRevisions, messages } from '../../store/schema/index.ts';
import type { SendToolInput } from './index.ts';
import type { OutgoingFile, SendToolEnvironment } from './support.ts';

/** The files to deliver and the audit fields naming where they came from. */
export type FileSendSource =
  | {
      readonly files: readonly OutgoingFile[];
      readonly audit: { readonly generation_id?: string; readonly asset_ids?: readonly string[] };
    }
  | { readonly errorCode: string; readonly message: string };

const ImageSendRequest = Compile(Type.Object({ generation_id: Type.String(), asset_ids: Type.Array(Type.String()) }));

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** A file shows its name to whoever saves it, so it carries the extension of its real type. */
export function fileNameFor(name: string, mime: string): string {
  const extension = EXTENSIONS[mime];
  if (extension === undefined || name.toLowerCase().endsWith(`.${extension}`)) {
    return name;
  }
  return `${name}.${extension}`;
}

export async function resolveFileSource(
  environment: SendToolEnvironment,
  send: Extract<SendToolInput, { kind: 'file' }>,
  signal: AbortSignal | undefined,
): Promise<FileSendSource> {
  if ('image_generation_id' in send) {
    return generationFiles(environment, send.image_generation_id, undefined);
  }
  const mediaId = environment.capabilities.resolveMedia(send.image_ref);
  if (mediaId === undefined) {
    return { errorCode: 'image_ref_not_authorized', message: 'image_ref is not visible in this conversation context' };
  }
  const generated = generatedPictureOf(environment, mediaId);
  if (generated !== undefined) {
    const source =
      generated === 'unreadable'
        ? undefined
        : generationFiles(environment, generated.generation_id, generated.asset_ids);
    return source === undefined || 'errorCode' in source
      ? {
          errorCode: 'file_original_unavailable',
          message: 'the original of this generated picture is no longer available; only its compressed copy exists',
        }
      : source;
  }
  const row = environment.store.orm.select({ kind: media.kind }).from(media).where(eq(media.id, mediaId)).get();
  if (row?.kind === 'sticker') {
    return { errorCode: 'file_source_unsupported', message: 'a sticker cannot be sent as a file' };
  }
  if (row === undefined || environment.mediaFiles === undefined) {
    return { errorCode: 'file_source_unavailable', message: 'this picture cannot be read for a file send' };
  }
  // The download must not outlive the run that asked for it.
  const timeout = AbortSignal.timeout(Math.max(1, environment.deadline - Date.now()));
  try {
    const file = await environment.mediaFiles.read(
      mediaId,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );
    return { files: [{ ...file, fileName: fileNameFor(file.fileName, file.mime) }], audit: {} };
  } catch {
    return { errorCode: 'file_source_unavailable', message: 'this picture could not be read for a file send' };
  }
}

/** Outputs of one generation of this conversation, optionally only the named assets. */
function generationFiles(
  environment: SendToolEnvironment,
  generationId: string,
  assetIds: readonly string[] | undefined,
): FileSendSource {
  let pictures: ReturnType<NonNullable<SendToolEnvironment['imageGeneration']>['resolve']>;
  try {
    pictures = environment.imageGeneration?.resolve(generationId, environment.context.conversationId);
  } catch {
    return {
      errorCode: 'image_generation_unavailable',
      message: 'image_generation_unavailable: generated output files could not be read',
    };
  }
  if (pictures === undefined) {
    return {
      errorCode: 'image_generation_not_authorized',
      message:
        'image_generation_id does not name a finished generation of this conversation; use ids from tool results or receipts here',
    };
  }
  const selected = assetIds === undefined ? pictures : pictures.filter((picture) => assetIds.includes(picture.assetId));
  if (selected.length === 0) {
    return { errorCode: 'image_generation_no_outputs', message: 'that generation has no pictures to send' };
  }
  return {
    files: selected.map((picture) => ({
      bytes: picture.bytes,
      fileName: fileNameFor(picture.fileName, picture.mime),
      mime: picture.mime,
    })),
    audit: { generation_id: generationId, asset_ids: selected.map((picture) => picture.assetId) },
  };
}

/**
 * The generation and assets a bot photo message delivered, when the media row
 * is one. The delivery ledger is the record: the message a successful image
 * send published carries exactly the assets that send listed. A ledger row that
 * does not name them still proves the picture was generated, so it is
 * `unreadable` rather than an ordinary picture whose copy may be sent.
 */
function generatedPictureOf(
  environment: SendToolEnvironment,
  mediaId: bigint,
): { readonly generation_id: string; readonly asset_ids: readonly string[] } | 'unreadable' | undefined {
  const row = environment.store.orm
    .select({ requestJson: hostSends.requestJson })
    .from(media)
    .innerJoin(messageRevisions, eq(messageRevisions.id, media.revisionId))
    .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
    .innerJoin(
      hostSends,
      and(
        eq(hostSends.conversationId, messages.conversationId),
        eq(hostSends.kind, 'image'),
        eq(hostSends.state, 'success'),
        or(eq(hostSends.telegramMessageId, messages.telegramMessageId), eq(hostSends.messageId, messages.id)),
      ),
    )
    .where(and(eq(media.id, mediaId), eq(messages.sentByBot, true)))
    .get();
  if (row === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.requestJson);
  } catch {
    return 'unreadable';
  }
  return ImageSendRequest.Check(parsed) ? parsed : 'unreadable';
}
