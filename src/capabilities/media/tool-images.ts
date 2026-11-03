import { readFile } from 'node:fs/promises';
import type { Api, Message, Model, TextContent, ImageContent } from '@earendil-works/pi-ai';
import { sql } from 'drizzle-orm';
import { toolImageReferences, toolImageMarker, type ToolImageReference } from '../../platform/tool-images.ts';
import type { Orm } from '../../store/store.ts';
import { MAX_DOWNLOAD_BYTES } from './image.ts';
import { localImageAssets } from './local-assets.ts';

export function toolImageLabel(toolName: string, callId: string, index: number): string {
  return `Tool result image ${index + 1} from ${toolName} (tool_call_id: ${callId})`;
}

/** Only retained canonical rows can authorize pixels, including on cache hits. */
export function authorizedToolImages(orm: Orm, conversationId: bigint, callId: string): readonly ToolImageReference[] {
  const row = orm.get<{ payload_json: string }>(sql`
    SELECT cm.payload_json FROM context_messages cm
    JOIN conversation_contexts cc ON cc.id = cm.context_id
    WHERE cc.conversation_id = ${conversationId} AND cm.seq >= cc.head_seq
      AND cm.evicted_at IS NULL AND cm.role = 'toolResult'
      AND json_extract(cm.payload_json, '$.toolCallId') = ${callId}
    LIMIT 1`);
  if (row === undefined) {
    return [];
  }
  const parsed: { details?: unknown } = JSON.parse(row.payload_json);
  return toolImageReferences(parsed.details);
}

/** Request-only projection: cached and persisted histories never hold image bytes. */
export async function loadToolImages(
  messages: readonly Message[],
  options: {
    orm: Orm;
    dataDir: string;
    conversationId: bigint;
    chatId: bigint;
    model: Model<Api>;
    signal: AbortSignal;
    onUnavailable?: (notice: string) => void;
  },
): Promise<Message[]> {
  const assets = localImageAssets(options.orm, options.dataDir);
  let remaining = MAX_DOWNLOAD_BYTES;
  let remainingImages = options.model.inputLimits?.images?.maxPerRequest ?? Number.POSITIVE_INFINITY;
  const maxPerMessage = options.model.inputLimits?.images?.maxPerMessage ?? Number.POSITIVE_INFINITY;
  let groupImages = maxPerMessage;
  // Prefer new results if a long retained history exceeds the existing media byte budget.
  const projected = [...messages];
  for (let position = messages.length - 1; position >= 0; position--) {
    const message = messages[position];
    if (message?.role !== 'toolResult') {
      groupImages = maxPerMessage;
      continue;
    }
    const references = toolImageReferences(message.details);
    if (references.length === 0) {
      continue;
    }
    const authorized = authorizedToolImages(options.orm, options.conversationId, message.toolCallId);
    const content: (TextContent | ImageContent)[] = [];
    // Completions projects consecutive tool results into one provider user message.
    let messageImages = options.model.api === 'openai-completions' ? groupImages : maxPerMessage;
    const byPosition = new Map(references.map((image, index) => [image.contentIndex, { image, index }]));
    for (const [index, block] of message.content.entries()) {
      const referenced = byPosition.get(index);
      if (referenced === undefined) {
        content.push(block);
        continue;
      }
      options.signal.throwIfAborted();
      const { image, index: imageIndex } = referenced;
      const label = toolImageLabel(message.toolName, message.toolCallId, imageIndex);
      let reason: string | undefined;
      if (!options.model.input.includes('image')) {
        reason = `model ${options.model.provider}/${options.model.id} does not support image input`;
      } else if (
        block.type !== 'text' ||
        block.text !== toolImageMarker(image.assetId) ||
        !authorized.some((item) => item.assetId === image.assetId && item.contentIndex === image.contentIndex)
      ) {
        reason = 'image_not_authorized';
      } else if (image.byteSize > remaining || remainingImages <= 0 || messageImages <= 0) {
        reason = 'image_request_budget_exceeded';
      }
      const asset = reason === undefined ? assets.assetFor(options.chatId, image.assetId) : null;
      if (
        reason === undefined &&
        (asset === null || asset.byteSize !== image.byteSize || asset.mime !== image.mimeType)
      ) {
        reason = 'image_missing';
      }
      if (reason === undefined && asset !== null) {
        try {
          const bytes = await readFile(asset.path, { signal: options.signal });
          if (bytes.byteLength !== asset.byteSize) {
            throw new Error('Image size changed');
          }
          remaining -= bytes.byteLength;
          remainingImages -= 1;
          messageImages -= 1;
          groupImages = messageImages;
          content.push(
            { type: 'text', text: label },
            { type: 'image', data: bytes.toString('base64'), mimeType: asset.mime },
          );
          continue;
        } catch {
          options.signal.throwIfAborted();
          reason = 'image_missing';
        }
      }
      options.onUnavailable?.(`${label}: ${reason}; no pixels sent to the model.`);
      content.push({
        type: 'text',
        text: `[${label}: ${reason}; no pixels sent to the model. Do not infer visual details or repeat tool side effects.]`,
      });
    }
    projected[position] = { ...message, content };
  }
  return projected;
}

/** Completions cannot carry tool images: mirror Pi's user projection with call labels. */
export function projectCompletionsToolImages(messages: readonly Message[]): Message[] {
  const projected: Message[] = [];
  let images: (TextContent | ImageContent)[] = [];
  let timestamp = 0;
  const flush = () => {
    if (images.length > 0) {
      projected.push({ role: 'user', content: images, timestamp });
    }
    images = [];
  };
  for (const message of messages) {
    if (message.role !== 'toolResult') {
      flush();
      projected.push(message);
      continue;
    }
    let imageIndex = 0;
    for (const block of message.content) {
      if (block.type === 'image') {
        images.push({ type: 'text', text: toolImageLabel(message.toolName, message.toolCallId, imageIndex++) }, block);
      }
    }
    timestamp = message.timestamp;
    projected.push({ ...message, content: message.content.filter((block) => block.type !== 'image') });
  }
  flush();
  return projected;
}
