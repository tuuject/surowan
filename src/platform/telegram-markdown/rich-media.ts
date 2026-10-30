import { isRecord } from './shared.ts';

const IMAGE_DOCUMENT_TYPES: Readonly<Record<string, true>> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
};
const MAX_IMAGE_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** The part of a Telegram PhotoSize the runtime stores. */
export interface TelegramPhoto {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

/** The part of a Telegram Document the runtime stores, once it is known to be an image. */
export interface ImageDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly mime_type: string;
  readonly file_size: number;
  readonly thumbnail?: { readonly width: number; readonly height: number };
}

/** A Document the runtime reads like a photo. */
export function isImageDocument<T extends { readonly mime_type?: string; readonly file_size?: number }>(
  document: T,
): document is T & { readonly mime_type: string; readonly file_size: number } {
  return (
    document.mime_type !== undefined &&
    IMAGE_DOCUMENT_TYPES[document.mime_type] === true &&
    document.file_size !== undefined &&
    document.file_size <= MAX_IMAGE_DOCUMENT_BYTES
  );
}

export type RichMedia =
  | { readonly kind: 'photo'; readonly photo: TelegramPhoto }
  | { readonly kind: 'document'; readonly document: ImageDocument };

export function normalizePhoto(value: unknown): TelegramPhoto | undefined {
  // Telegram lists sizes smallest first; like a photo message, only the
  // largest is kept.
  const photo = Array.isArray(value) ? value.at(-1) : undefined;
  return isPhotoSize(photo) ? photo : undefined;
}

export function normalizeImageDocument(value: unknown): ImageDocument | undefined {
  if (!isFileRecord(value) || (value.thumbnail !== undefined && !hasSize(value.thumbnail))) {
    return undefined;
  }
  const document = value as unknown as Omit<ImageDocument, 'mime_type' | 'file_size'> & {
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  return isImageDocument(document) ? document : undefined;
}

function isPhotoSize(value: unknown): value is TelegramPhoto {
  return isFileRecord(value) && hasSize(value);
}

function hasSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    Number.isInteger(value.width) &&
    typeof value.height === 'number' &&
    Number.isInteger(value.height)
  );
}

function isFileRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.file_id === 'string' &&
    typeof value.file_unique_id === 'string' &&
    (value.file_size === undefined || (typeof value.file_size === 'number' && Number.isInteger(value.file_size))) &&
    (value.mime_type === undefined || typeof value.mime_type === 'string')
  );
}
