import Type from 'typebox';
import Compile from 'typebox/compile';

const ImageReferenceSchema = Type.Object(
  {
    contentIndex: Type.Integer({ minimum: 0 }),
    assetId: Type.String({ pattern: '^[a-f0-9]{32}$' }),
    mimeType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png'), Type.Literal('image/webp')]),
    byteSize: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const ImagesSchema = Type.Object(
  {
    version: Type.Literal(1),
    items: Type.Array(ImageReferenceSchema),
  },
  { additionalProperties: false },
);
const validator = Compile(ImagesSchema);

export type ToolImageReference = {
  readonly contentIndex: number;
  readonly assetId: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
};

/**
 * References are minted by the runtime at the tool boundary — an MCP result, a
 * member avatar — and never parsed out of tool text. Any tool may carry them;
 * the shape says nothing about which one did.
 */
export function toolImageReferences(details: unknown): readonly ToolImageReference[] {
  if (details === null || typeof details !== 'object' || !('toolImages' in details)) {
    return [];
  }
  if (!validator.Check(details.toolImages)) {
    throw new Error('Invalid stored tool image references');
  }
  const items = details.toolImages.items;
  if (new Set(items.map((item) => item.contentIndex)).size !== items.length) {
    throw new Error('Duplicate stored tool image position');
  }
  return items;
}

export interface StoredToolContent {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly details: unknown;
}

/** Audit snapshots and canonical messages share the same bounded representation. */
export function parseStoredToolContent(json: string | null): StoredToolContent | null {
  if (json === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || !('content' in parsed) || !Array.isArray(parsed.content)) {
    throw new Error('Invalid stored tool content');
  }
  const content: { type: 'text'; text: string }[] = [];
  for (const block of parsed.content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Invalid stored tool content block');
    }
    content.push({ type: 'text', text: block.text });
  }
  const details = 'details' in parsed ? parsed.details : null;
  for (const image of toolImageReferences(details)) {
    if (image.contentIndex >= content.length || content[image.contentIndex]?.text !== toolImageMarker(image.assetId)) {
      throw new Error('Stored tool image position does not match its content');
    }
  }
  return { content, details };
}

/** The placeholder a tool leaves where the pixels will be attached at request time. */
export function toolImageMarker(assetId: string): string {
  return `[image ${assetId}]`;
}
