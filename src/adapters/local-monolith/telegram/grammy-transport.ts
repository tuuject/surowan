/**
 * The grammY side of the Telegram transport: request/response adaptation, the
 * chat-action dedup, and the single conversion of a stored topic id into the
 * `message_thread_id` the wire needs. The host above keeps transport-neutral
 * delivery; nothing here knows what an invocation is.
 */

import { type Api, InputFile } from 'grammy';
import type { TelegramSendResponse, TelegramTransport } from './host.ts';

/**
 * A topic id the wire cannot carry: `message_thread_id` is a JSON number, so
 * an id outside the safe integer range can only be rounded into a different
 * topic. The host refuses instead of addressing a conversation it was not
 * asked for.
 */
export class UnsafeTopicIdError extends Error {
  constructor(topicId: bigint) {
    super(
      `topic id ${topicId} is outside the safe integer range for message_thread_id; refusing to address a rounded topic`,
    );
    this.name = 'UnsafeTopicIdError';
  }
}

/** The one conversion of a stored topic id into the `message_thread_id` the wire needs. */
export function wireThreadId(topicId: bigint): number {
  if (topicId > BigInt(Number.MAX_SAFE_INTEGER) || topicId < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsafeTopicIdError(topicId);
  }
  return Number(topicId);
}

/** Adapts a grammY client to {@link TelegramTransport}. */
export function grammyTelegramTransport(api: Api): TelegramTransport {
  // Telegram drops a chat action after five seconds, so overlapping pings and
  // pings that arrive less than one refresh apart are both wasted requests.
  const typingRequests = new Map<string, { readonly at: number; pending: boolean }>();
  const narrow = (message: TelegramSendResponse): TelegramSendResponse => {
    const raw = message.photo;
    const sizes = Array.isArray(raw) ? raw : undefined;
    return {
      message_id: message.message_id,
      date: message.date,
      chat: message.chat,
      ...(sizes === undefined ? {} : { photo: sizes }),
    };
  };
  return {
    sendTyping: async (chatId, threadId, signal) => {
      const key = `${chatId}:${threadId}`;
      const previous = typingRequests.get(key);
      if (signal.aborted || (previous !== undefined && (previous.pending || Date.now() - previous.at < 4_000))) {
        return;
      }
      const current = { at: Date.now(), pending: true };
      typingRequests.set(key, current);
      try {
        await api.sendChatAction(
          chatId,
          'typing',
          threadId === 0n ? {} : { message_thread_id: wireThreadId(threadId) },
          // grammY still types its signal as the older abort-controller shim; it forwards abort events.
          AbortSignal.any([signal, AbortSignal.timeout(3_500)]) as unknown as Parameters<Api['sendChatAction']>[3],
        );
      } finally {
        current.pending = false;
        const cleanup = setTimeout(
          () => {
            if (typingRequests.get(key) === current) {
              typingRequests.delete(key);
            }
          },
          Math.max(0, current.at + 4_000 - Date.now()),
        );
        // Never hold the process open for a cosmetic status.
        cleanup.unref?.();
      }
    },
    sendMessage: async (chatId, text, options) => narrow(await api.sendMessage(chatId, text, options)),
    sendSticker: async (chatId, sticker, options) => narrow(await api.sendSticker(chatId, sticker, options)),
    sendGeneratedPhoto: async (chatId, bytes, fileName, options) => {
      const message = await api.sendPhoto(chatId, new InputFile(Buffer.from(bytes), fileName), {
        ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
        ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        ...(options.caption === undefined ? {} : { caption: options.caption }),
      });
      return narrow(message);
    },
    sendGeneratedPhotoGroup: async (chatId, pictures, options) => {
      const messages = await api.sendMediaGroup(
        chatId,
        pictures.map((picture, index) => ({
          type: 'photo' as const,
          media: new InputFile(Buffer.from(picture.bytes), picture.fileName),
          ...(index === 0 && options.caption !== undefined ? { caption: options.caption } : {}),
        })),
        {
          ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
          ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
        },
      );
      return messages.map(narrow);
    },
    sendDocuments: async (chatId, files, options) => {
      const target = {
        ...(options.message_thread_id === undefined ? {} : { message_thread_id: options.message_thread_id }),
        ...(options.reply_parameters === undefined ? {} : { reply_parameters: options.reply_parameters }),
      };
      const [only] = files;
      if (files.length === 1 && only !== undefined) {
        const message = await api.sendDocument(chatId, new InputFile(Buffer.from(only.bytes), only.fileName), {
          ...target,
          ...(options.caption === undefined ? {} : { caption: options.caption }),
        });
        return [narrow(message)];
      }
      // The caption rides on the first file, the message the send records.
      const messages = await api.sendMediaGroup(
        chatId,
        files.map((file, index) => ({
          type: 'document' as const,
          media: new InputFile(Buffer.from(file.bytes), file.fileName),
          ...(index === 0 && options.caption !== undefined ? { caption: options.caption } : {}),
        })),
        target,
      );
      return messages.map(narrow);
    },
  };
}
