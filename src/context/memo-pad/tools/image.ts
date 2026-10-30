import type { AgentTool } from '@earendil-works/pi-agent-core';
import { finishToolCall, rejectToolCall, startToolCall } from '../../../store/store.ts';
import { SaveMemoImageInputSchema, memoBlobUri } from '../index.ts';
import { memoChatRemoved, type MemoToolEnvironment } from './shared.ts';

/**
 * Copies one image that is currently visible in this Conversation into a
 * Chat-owned blob. The reference itself expires with the Conversation Context,
 * so the bytes are copied now; the returned `pwblob://` URI is what the model
 * writes into a Memo detail.
 */
export function createSaveMemoImageTool(
  env: MemoToolEnvironment,
): AgentTool<typeof SaveMemoImageInputSchema, { blob_uri: string; mime: string; byte_size: number }> {
  return {
    name: 'save_memo_image',
    label: 'Save image to memory',
    description:
      "Copy one image from the current conversation into this Chat's memory storage and return a pwblob:// URI. Accepts only an img_ image_ref visible in this Conversation Context (a Photo, image Document, or Sticker). Use it when the user asks you to remember an image or the image is durable material for a Memo entry; then reference the returned URI in the Memo detail as Markdown, for example ![description](pwblob://...). The URI is Chat-scoped and grants access only inside this Chat. You MUST call this before the originating Context references expire; the stored copy survives.",
    parameters: SaveMemoImageInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const argumentsJson = JSON.stringify(input);
      if (memoChatRemoved(env)) {
        rejectToolCall(
          env.store.orm,
          env.context.invocationId,
          toolCallId,
          'save_memo_image',
          argumentsJson,
          true,
          'chat_removed',
        );
        throw new Error('This Chat is no longer configured; memory writes are refused');
      }
      const mediaId = env.capabilities.resolveMedia(input.image_ref);
      if (mediaId === undefined) {
        rejectToolCall(
          env.store.orm,
          env.context.invocationId,
          toolCallId,
          'save_memo_image',
          argumentsJson,
          true,
          'image_ref_not_authorized',
        );
        throw new Error('image_ref is not visible in this conversation context');
      }
      const toolId = startToolCall(
        env.store.orm,
        env.context.invocationId,
        toolCallId,
        'save_memo_image',
        argumentsJson,
        true,
      );
      try {
        const image = await env.prepareImage(mediaId, signal ?? new AbortController().signal);
        const { blob, created } = await env.blobs.ingest(env.context.internalChatId, {
          bytes: Buffer.from(image.base64, 'base64'),
          mime: image.mime,
        });
        const uri = memoBlobUri(blob.id);
        finishToolCall(env.store.orm, toolId, 'success', `blob_id=${blob.id} created=${created}`, null);
        return {
          content: [
            {
              type: 'text',
              text: `Saved image as ${uri} (${blob.mime}, ${blob.byteSize} bytes). Reference it in a Memo detail with Markdown, for example ![description](${uri}).`,
            },
          ],
          details: { blob_uri: uri, mime: blob.mime, byte_size: blob.byteSize },
        };
      } catch (error) {
        finishToolCall(env.store.orm, toolId, 'error', null, 'memo_blob_error');
        throw error;
      }
    },
  };
}
