import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { InvocationContext } from '../../platform/invocation-context.ts';
import { type ToolImageReference, toolImageMarker } from '../../platform/tool-images.ts';
import { truncateUtf8 } from '../../platform/truncate.ts';
import { MAX_DOWNLOAD_BYTES, normalizeImage } from '../media/image.ts';
import { LocalAssetRejected, type PlaygroundAssetStore } from '../media/local-assets.ts';
import { type McpCallResult, type McpToolDefinition, TRUNCATION_MARKER } from './support.ts';

export type McpResultDetails = {
  server: string;
  tool: string;
  mcpImages?: { version: 1; items: ToolImageReference[] };
};
export type McpToolResult = AgentToolResult<McpResultDetails>;

/** The transport has already bounded the whole response; never truncate binary data. */
export async function convertMcpResult(
  result: McpCallResult,
  definition: Pick<McpToolDefinition, 'serverAlias' | 'originalName' | 'resultMaxBytes'>,
  context: InvocationContext,
  assets: PlaygroundAssetStore,
  signal: AbortSignal,
): Promise<McpToolResult> {
  const details: McpResultDetails = { server: definition.serverAlias, tool: definition.originalName };
  const isError = 'isError' in result && result.isError === true;
  // Preserve the existing text-only wire contract and historical JSON envelope.
  if (
    !('content' in result) ||
    !Array.isArray(result.content) ||
    result.content.every((block) => block.type === 'text')
  ) {
    return {
      content: [
        { type: 'text', text: truncateUtf8(JSON.stringify(result), definition.resultMaxBytes, TRUNCATION_MARKER) },
      ],
      details,
      isError,
    };
  }
  const content: { type: 'text'; text: string }[] = [];
  const images: ToolImageReference[] = [];
  let remaining = definition.resultMaxBytes;
  const text = (value: string) => {
    if (remaining <= 0) {
      return;
    }
    const bounded = truncateUtf8(value, remaining, TRUNCATION_MARKER);
    remaining -= Buffer.byteLength(bounded);
    content.push({ type: 'text', text: bounded });
  };
  for (const block of result.content) {
    signal.throwIfAborted();
    if (block.type === 'text') {
      text(block.text);
    } else if (block.type === 'image') {
      try {
        const encoded: unknown = block.data;
        if (typeof encoded !== 'string' || encoded.length === 0) {
          throw new LocalAssetRejected('corrupt', 'Empty or invalid base64 image');
        }
        if (encoded.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4) {
          throw new LocalAssetRejected('too_large', 'Base64 image exceeds the media byte limit');
        }
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          throw new LocalAssetRejected('corrupt', 'Invalid base64 image');
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) {
          throw new LocalAssetRejected('corrupt', 'Invalid base64 image');
        }
        await assets.validate({ bytes, declaredMime: block.mimeType });
        signal.throwIfAborted();
        const directory = await mkdtemp(join(tmpdir(), 'surowan-mcp-image-'));
        try {
          const input = join(directory, 'input');
          await writeFile(input, bytes, { mode: 0o600, signal });
          const normalized = await normalizeImage(input, directory, signal);
          const normalizedBytes = await readFile(normalized.path, { signal });
          signal.throwIfAborted();
          const asset = await assets.ingest(context.internalChatId, {
            bytes: normalizedBytes,
            declaredMime: normalized.mimeType,
          });
          signal.throwIfAborted();
          images.push({
            contentIndex: content.length,
            assetId: asset.id,
            mimeType: asset.mime,
            byteSize: asset.byteSize,
            width: asset.width,
            height: asset.height,
          });
          content.push({ type: 'text', text: toolImageMarker(asset.id) });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof LocalAssetRejected ? error.reason : 'image_processing_failed';
        // Feedback must survive even when the server consumed the entire text budget.
        content.push({
          type: 'text',
          text: `[MCP image unavailable: ${reason}; no pixels from this image were sent to the model]`,
        });
      }
    } else if (block.type === 'resource' && 'text' in block.resource) {
      text(
        JSON.stringify({
          type: block.type,
          resource: { uri: block.resource.uri, text: block.resource.text, mimeType: block.resource.mimeType },
        }),
      );
    } else if (block.type === 'resource_link') {
      text(JSON.stringify({ type: block.type, uri: block.uri, name: block.name, note: 'Resource link not fetched' }));
    } else {
      text(`[Unsupported MCP content: ${block.type}; binary content omitted]`);
    }
  }
  if ('structuredContent' in result && result.structuredContent !== undefined) {
    text(JSON.stringify(result.structuredContent));
  }
  if (images.length > 0) {
    details.mcpImages = { version: 1, items: images };
  }
  // Completions/Responses have no native error flag on tool output.
  if (isError) {
    content.push({ type: 'text', text: '[MCP tool reported an error: isError=true]' });
  }
  return { content, details, isError };
}
