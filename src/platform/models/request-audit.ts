import { createHash } from 'node:crypto';

const IMAGE_DATA_URL_PREFIX = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,/i;

export interface ScrubbedModelRequestAudit {
  readonly json: string;
  readonly replacements: number;
  readonly removedCharacters: number;
  readonly decodedBytes: number;
}

export function serializeModelRequestForAudit(payload: unknown): string {
  return scrubModelRequestAuditJson(JSON.stringify(payload ?? null)).json;
}

export function scrubModelRequestAuditJson(json: string): ScrubbedModelRequestAudit {
  let replacements = 0;
  let decodedBytes = 0;
  const omit = (encoded: string, mime: string) => {
    const bytes = Buffer.from(encoded, 'base64');
    replacements += 1;
    decodedBytes += bytes.byteLength;
    return {
      __surowan_audit_omission__: 'base64_image',
      mime_type: mime.toLowerCase(),
      encoded_characters: encoded.length,
      decoded_bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const parsed: unknown = JSON.parse(json);
  const scrubbed = JSON.stringify(parsed, (key, value: unknown) => {
    if (typeof value === 'string') {
      const prefix = IMAGE_DATA_URL_PREFIX.exec(value);
      return prefix?.[1] === undefined ? value : omit(value.slice(prefix[0].length), prefix[1]);
    }
    if (value !== null && typeof value === 'object' && 'data' in value && typeof value.data === 'string') {
      if (
        key === 'source' &&
        'type' in value &&
        value.type === 'base64' &&
        'media_type' in value &&
        typeof value.media_type === 'string' &&
        value.media_type.startsWith('image/')
      ) {
        return { ...value, data: omit(value.data, value.media_type) };
      }
      if (
        key === 'inlineData' &&
        'mimeType' in value &&
        typeof value.mimeType === 'string' &&
        value.mimeType.startsWith('image/')
      ) {
        return { ...value, data: omit(value.data, value.mimeType) };
      }
    }
    return value;
  });
  return { json: scrubbed, replacements, removedCharacters: Math.max(0, json.length - scrubbed.length), decodedBytes };
}
