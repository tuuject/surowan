import { readFile } from 'node:fs/promises';
import type { Api, ImageContent, Message, Model, TextContent } from '@earendil-works/pi-ai';
import { sql } from 'drizzle-orm';
import { type ToolImageReference, toolImageMarker, toolImageReferences } from '../../platform/tool-images.ts';
import type { Orm } from '../../store/store.ts';
import { MAX_DOWNLOAD_BYTES } from './image.ts';
import { localImageAssets } from './local-assets.ts';

export function toolImageLabel(toolName: string, callId: string, index: number): string {
  return `Tool result image ${index + 1} from ${toolName} (tool_call_id: ${callId})`;
}

/** Read the retained authorization boundary once per request, including on cache hits. */
function authorizedToolImages(orm: Orm, conversationId: bigint): Map<string, readonly ToolImageReference[]> {
  const rows = orm.all<{ payload_json: string }>(sql`
    SELECT cm.payload_json FROM context_messages cm
    JOIN conversation_contexts cc ON cc.id = cm.context_id
    WHERE cc.conversation_id = ${conversationId} AND cm.seq >= cc.head_seq
      AND cm.evicted_at IS NULL AND cm.role = 'toolResult'`);
  const calls = new Map<string, readonly ToolImageReference[]>();
  for (const row of rows) {
    const parsed: { toolCallId?: unknown; details?: unknown } = JSON.parse(row.payload_json);
    if (typeof parsed.toolCallId === 'string' && !calls.has(parsed.toolCallId)) {
      calls.set(parsed.toolCallId, toolImageReferences(parsed.details));
    }
  }
  return calls;
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
  // Mirror Pi's provider grouping: Responses and Gemini <3 use separate image outputs;
  // Completions, Anthropic and multimodal Gemini merge consecutive tool images.
  const geminiVersion = /^gemini(?:-live)?-(\d+)/i.exec(options.model.id)?.[1];
  const mergeToolImages =
    options.model.api === 'openai-completions' ||
    options.model.api === 'anthropic-messages' ||
    (options.model.api === 'google-generative-ai' && (geminiVersion === undefined || Number(geminiVersion) >= 3));
  // Reserve every image already present before choosing which references to restore.
  let budget = { remaining: maxPerMessage };
  let previousRole: Message['role'] | undefined;
  const entries = messages.map((message, position) => {
    if (!(mergeToolImages && message.role === 'toolResult' && previousRole === 'toolResult')) {
      budget = { remaining: maxPerMessage };
    }
    previousRole = message.role;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'image') {
          remaining -= Buffer.byteLength(block.data, 'base64');
          remainingImages -= 1;
          budget.remaining -= 1;
        }
      }
    }
    return { message, position, budget };
  });
  const calls = messages.some(
    (message) => message.role === 'toolResult' && toolImageReferences(message.details).length > 0,
  )
    ? authorizedToolImages(options.orm, options.conversationId)
    : new Map<string, readonly ToolImageReference[]>();
  // Prefer new results if a long retained history exceeds the existing media byte budget.
  const projected = [...messages];
  for (const { message, position, budget } of entries.toReversed()) {
    if (message.role !== 'toolResult') {
      continue;
    }
    const references = toolImageReferences(message.details);
    if (references.length === 0) {
      continue;
    }
    const authorized = calls.get(message.toolCallId) ?? [];
    const content: (TextContent | ImageContent)[] = [];
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
      } else if (image.byteSize > remaining || remainingImages <= 0 || budget.remaining <= 0) {
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
          budget.remaining -= 1;
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
